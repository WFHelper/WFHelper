import {
  fetchPriceByName,
  fetchPriceBySlug,
  type RequestPriority,
} from "../../lib/wfm/wfmPrice.js";
import { fetchOrderSummaryBySlug } from "../../lib/wfm/orderSummaryRemote.js";
import {
  setCachedOrderSummary,
  setCachedOrderSummaryNoData,
} from "../../lib/wfm/orderSummaryCache.js";
import { normalizeWfmSlug } from "../../lib/wfm/backendLite.js";
import { fetchWfmItemMetaBySlug } from "../../lib/wfm/wfmItemMeta.js";
import type { InventoryBaseItem, ItemMetrics, MetricNeeds } from "../../lib/inventoryMarket.js";
import type { WfmItemsLookup } from "../../types/ipc.js";
import {
  MAX_DUCAT_RETRY_PER_ITEM,
  PRICE_TRANSIENT_RETRY_MS,
  PRICE_NO_DATA_RETRY_MS,
  ORDER_TRANSIENT_RETRY_MS,
} from "./hydrationTypes.js";
import {
  resolvePriceRank,
  resolveRankedMaxRank,
  priceRetryKey,
  itemPriceRank,
  orderRetryKey,
  hasResolvedPrice,
  hasRankPairCoverage,
} from "./hydrationHelpers.js";
import { getCachedMedian, getCachedRankOrderSummary } from "./hydrationCacheHelpers.js";
import sharedNumeric from "../../../config/shared/numeric.cjs";
import wfmExclusionsShared from "../../../config/shared/wfmExclusions.cjs";

const { isRankedGroup } = sharedNumeric as {
  isRankedGroup: (group: string | null | undefined) => boolean;
};

const { isExcludedRankedMarketItem } = wfmExclusionsShared as {
  isExcludedRankedMarketItem: (
    name: string | null | undefined,
    slug: string | null | undefined,
  ) => boolean;
};

// ---------------------------------------------------------------------------
// Hydration context — provides controlled access to controller closure state
// ---------------------------------------------------------------------------

export interface HydrationContext {
  getMetric: (key: string) => ItemMetrics | undefined;
  hasPriceRetryCooldown: (key: string) => boolean;
  setPriceRetryCooldown: (key: string, delayMs: number) => void;
  clearPriceRetryCooldown: (key: string) => void;
  hasOrderRetryCooldown: (key: string) => boolean;
  setOrderRetryCooldown: (key: string, delayMs: number) => void;
  clearOrderRetryCooldown: (key: string) => void;
  getMissingDucatRetryCount: (key: string) => number;
  incrementMissingDucatRetryCount: (key: string) => void;
  clearMissingDucatRetryCount: (key: string) => void;
  queueMetricPatch: (key: string, metric: ItemMetrics) => void;
  markPending: (key: string) => void;
  clearPending: (key: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers using context
// ---------------------------------------------------------------------------

function canRetryMissingDucats(
  ctx: HydrationContext,
  key: string,
  item: InventoryBaseItem,
  metric: ItemMetrics | undefined,
): boolean {
  if (!metric) return false;
  if (!metric.hasDucats || metric.ducats != null) return false;
  if (!metric.slug) return false;
  if (item.inventoryGroup !== "all_parts" && item.inventoryGroup !== "full_sets") return false;
  return ctx.getMissingDucatRetryCount(key) < MAX_DUCAT_RETRY_PER_ITEM;
}

// ---------------------------------------------------------------------------
// Core hydration logic
// ---------------------------------------------------------------------------

export async function hydrateItemMetrics(
  ctx: HydrationContext,
  item: InventoryBaseItem,
  lookup: WfmItemsLookup,
  needs: MetricNeeds,
): Promise<void> {
  const key = item.internalName;
  const existing = ctx.getMetric(key);
  const retryMissingDucats = canRetryMissingDucats(ctx, key, item, existing);
  const requestedRank = resolvePriceRank(item);
  const retryKey = priceRetryKey(key, requestedRank);
  const existingPriceRank = itemPriceRank(existing);
  const rankMismatch = needs.price && requestedRank !== existingPriceRank;

  if (needs.price && !rankMismatch && ctx.hasPriceRetryCooldown(retryKey)) {
    return;
  }

  const needsIcon = isRankedGroup(item.inventoryGroup);
  const lookupHasIcon = Boolean(item.marketThumb);
  const iconReady = !needsIcon || lookupHasIcon || existing?.hasMeta === true;
  const rankPairCovered = hasRankPairCoverage(existing, item, needs);

  if (
    existing &&
    (!needs.price || (!rankMismatch && hasResolvedPrice(existing) && rankPairCovered)) &&
    (!needs.ducats || existing.hasDucats) &&
    iconReady &&
    !retryMissingDucats &&
    !rankMismatch
  ) {
    return;
  }

  if (!ctx.markPending) return;
  ctx.markPending(key);

  try {
    let platinum =
      typeof existing?.platinum === "number" && Number.isFinite(existing.platinum)
        ? existing.platinum
        : null;
    let ducats =
      typeof existing?.ducats === "number" && Number.isFinite(existing.ducats)
        ? existing.ducats
        : null;
    let slug = existing?.slug || item.marketSlug;
    let thumb = existing?.thumb || null;
    let icon = existing?.icon || null;
    let hasPrice = existing?.hasPrice || false;
    let hasDucats = existing?.hasDucats || false;
    let hasMeta = existing?.hasMeta || false;
    let priceRank = existingPriceRank;
    let platinumR0 =
      typeof existing?.platinumR0 === "number" && Number.isFinite(existing.platinumR0)
        ? existing.platinumR0
        : null;
    let platinumRmax =
      typeof existing?.platinumRmax === "number" && Number.isFinite(existing.platinumRmax)
        ? existing.platinumRmax
        : null;
    let hasPriceR0 = existing?.hasPriceR0 === true;
    let hasPriceRmax = existing?.hasPriceRmax === true;
    let wtsR0 =
      typeof existing?.wtsR0 === "number" && Number.isFinite(existing.wtsR0)
        ? existing.wtsR0
        : null;
    let wtbR0 =
      typeof existing?.wtbR0 === "number" && Number.isFinite(existing.wtbR0)
        ? existing.wtbR0
        : null;
    let wtsRmax =
      typeof existing?.wtsRmax === "number" && Number.isFinite(existing.wtsRmax)
        ? existing.wtsRmax
        : null;
    let wtbRmax =
      typeof existing?.wtbRmax === "number" && Number.isFinite(existing.wtbRmax)
        ? existing.wtbRmax
        : null;
    let hasOrdersR0 = existing?.hasOrdersR0 === true;
    let hasOrdersRmax = existing?.hasOrdersRmax === true;

    const fetchPriority: RequestPriority =
      item.inventoryGroup === "all_parts" || item.inventoryGroup === "full_sets"
        ? "high"
        : isRankedGroup(item.inventoryGroup)
          ? needs.orders
            ? "high"
            : "normal"
          : "normal";
    const isRankedListingItem = isRankedGroup(item.inventoryGroup);
    const rankedMaxRank = resolveRankedMaxRank(item);
    const excludedRankedItem =
      isRankedListingItem && isExcludedRankedMarketItem(item.name, item.marketSlug);
    const allowNameLookup =
      !isRankedListingItem || Boolean(item.marketSlug) || Boolean(existing?.slug);
    const bypassNoDataCache = isRankedGroup(item.inventoryGroup);

    if (isRankedListingItem && !excludedRankedItem && rankedMaxRank != null && item.marketSlug) {
      const cachedR0 = getCachedMedian(`${item.marketSlug}:rank-v3:r0`);
      const cachedRmax = getCachedMedian(`${item.marketSlug}:rank-v3:r${rankedMaxRank}`);

      if (cachedR0 != null) {
        platinumR0 = cachedR0;
        hasPriceR0 = true;
      }
      if (cachedRmax != null) {
        platinumRmax = cachedRmax;
        hasPriceRmax = true;
      }

      if (requestedRank === 0 && platinum == null && platinumR0 != null) {
        platinum = platinumR0;
      }
      if (requestedRank === rankedMaxRank && platinum == null && platinumRmax != null) {
        platinum = platinumRmax;
      }

      if (platinumR0 != null || platinumRmax != null) {
        hasPrice = true;
      }
    }

    const needsPriceFetch = needs.price && (!hasPrice || platinum == null || rankMismatch);
    if (needsPriceFetch) {
      let priceResult: Awaited<ReturnType<typeof fetchPriceByName>> = null;
      let bySlugStatus: Awaited<ReturnType<typeof fetchPriceBySlug>>["status"] | null = null;

      if (slug) {
        const bySlug = await fetchPriceBySlug(slug, {
          priority: fetchPriority,
          rank: requestedRank,
          ignoreNoDataCache: bypassNoDataCache,
        });
        bySlugStatus = bySlug.status;
        if (bySlug.status === "ok" && bySlug.median != null) {
          priceResult = {
            median: bySlug.median,
            slug: bySlug.slug || slug,
            timestamp: bySlug.timestamp || Date.now(),
          };
        }
      }

      if (!priceResult && allowNameLookup) {
        priceResult = await fetchPriceByName(item.name, lookup, {
          priority: fetchPriority,
          allowSetFallback: item.inventoryGroup === "full_sets",
          rank: requestedRank,
          ignoreNoDataCache: bypassNoDataCache,
        });
      }

      if (!priceResult && requestedRank != null) {
        if (slug) {
          const unrankedBySlug = await fetchPriceBySlug(slug, {
            priority: fetchPriority,
            ignoreNoDataCache: bypassNoDataCache,
          });
          if (unrankedBySlug.status === "ok" && unrankedBySlug.median != null) {
            priceResult = {
              median: unrankedBySlug.median,
              slug: unrankedBySlug.slug || slug,
              timestamp: unrankedBySlug.timestamp || Date.now(),
            };
          }
        }

        if (!priceResult && allowNameLookup) {
          priceResult = await fetchPriceByName(item.name, lookup, {
            priority: fetchPriority,
            allowSetFallback: item.inventoryGroup === "full_sets",
            ignoreNoDataCache: bypassNoDataCache,
          });
        }
      }

      if (
        typeof priceResult?.median === "number" &&
        Number.isFinite(priceResult.median) &&
        priceResult.median >= 0
      ) {
        platinum = Math.round(priceResult.median);
      }
      if (priceResult?.slug) {
        slug = priceResult.slug;
      }

      if (priceResult) {
        hasPrice = true;
        priceRank = requestedRank;
        if (isRankedListingItem && requestedRank != null && rankedMaxRank != null) {
          if (requestedRank === 0) {
            platinumR0 = platinum;
          }
          if (requestedRank === rankedMaxRank) {
            platinumRmax = platinum;
          }
        }
        ctx.clearPriceRetryCooldown(retryKey);
      } else if (bySlugStatus === "transient") {
        hasPrice = false;
        ctx.setPriceRetryCooldown(retryKey, PRICE_TRANSIENT_RETRY_MS);
      } else {
        hasPrice = true;
        priceRank = requestedRank;
        ctx.setPriceRetryCooldown(retryKey, PRICE_NO_DATA_RETRY_MS);
      }

      if (isRankedListingItem && requestedRank != null && rankedMaxRank != null) {
        if (requestedRank === 0) {
          hasPriceR0 = true;
        }
        if (requestedRank === rankedMaxRank) {
          hasPriceRmax = true;
        }
      }
    }

    if (needs.price && isRankedListingItem && rankedMaxRank != null) {
      const fetchRankPrice = async (rank: number): Promise<number | null> => {
        let rankResult: Awaited<ReturnType<typeof fetchPriceByName>> = null;

        if (slug) {
          const bySlug = await fetchPriceBySlug(slug, {
            priority: fetchPriority,
            rank,
            ignoreNoDataCache: bypassNoDataCache,
          });
          if (bySlug.status === "ok" && bySlug.median != null) {
            rankResult = {
              median: bySlug.median,
              slug: bySlug.slug || slug,
              timestamp: bySlug.timestamp || Date.now(),
            };
          }
        }

        if (!rankResult && allowNameLookup) {
          rankResult = await fetchPriceByName(item.name, lookup, {
            priority: fetchPriority,
            allowSetFallback: item.inventoryGroup === "full_sets",
            rank,
            ignoreNoDataCache: bypassNoDataCache,
          });
        }

        if (rankResult?.slug) {
          slug = rankResult.slug;
        }

        if (
          typeof rankResult?.median === "number" &&
          Number.isFinite(rankResult.median) &&
          rankResult.median >= 0
        ) {
          return Math.round(rankResult.median);
        }

        return null;
      };

      if (!hasPriceR0) {
        platinumR0 = await fetchRankPrice(0);
        hasPriceR0 = true;
      }

      if (!hasPriceRmax) {
        platinumRmax = await fetchRankPrice(rankedMaxRank);
        hasPriceRmax = true;
      }

      if (requestedRank === 0 && platinum == null) {
        platinum = platinumR0;
      }
      if (requestedRank === rankedMaxRank && platinum == null) {
        platinum = platinumRmax;
      }

      if (platinumR0 != null || platinumRmax != null) {
        hasPrice = true;
      }
    }

    if (
      needs.price &&
      needs.orders &&
      isRankedListingItem &&
      item.tradable === true &&
      rankedMaxRank != null
    ) {
      const ordersSlug = normalizeWfmSlug(slug || item.marketSlug);
      const rank0RetryKey = orderRetryKey(key, 0);
      const rankMaxRetryKey = orderRetryKey(key, rankedMaxRank);

      let shouldRefreshRank0 = !hasOrdersR0;
      let shouldRefreshRankMax = !hasOrdersRmax;

      if (ordersSlug) {
        const cachedRank0 = getCachedRankOrderSummary(ordersSlug, 0);
        if (cachedRank0) {
          wtsR0 = cachedRank0.wts;
          wtbR0 = cachedRank0.wtb;
          hasOrdersR0 = true;
          shouldRefreshRank0 = !cachedRank0.fresh;
        }

        const cachedRankMax = getCachedRankOrderSummary(ordersSlug, rankedMaxRank);
        if (cachedRankMax) {
          wtsRmax = cachedRankMax.wts;
          wtbRmax = cachedRankMax.wtb;
          hasOrdersRmax = true;
          shouldRefreshRankMax = !cachedRankMax.fresh;
        }
      }

      const shouldFetchRank0 = shouldRefreshRank0 && !ctx.hasOrderRetryCooldown(rank0RetryKey);
      const shouldFetchRankMax =
        shouldRefreshRankMax && !ctx.hasOrderRetryCooldown(rankMaxRetryKey);

      const refreshSummaryForRank = async (
        targetRank: number,
        retryKey: string,
        shouldFetch: boolean,
        existingWts: number | null,
        existingWtb: number | null,
        existingHasOrders: boolean,
      ): Promise<{ wts: number | null; wtb: number | null; hasOrders: boolean }> => {
        if (!shouldFetch || !ordersSlug) {
          return {
            wts: existingWts,
            wtb: existingWtb,
            hasOrders: existingHasOrders,
          };
        }

        const result = await fetchOrderSummaryBySlug(ordersSlug, { rank: targetRank });
        if (result.status === "ok") {
          const nextWts = result.data.wts;
          const nextWtb = result.data.wtb;
          if (nextWts == null && nextWtb == null) {
            setCachedOrderSummaryNoData(ordersSlug, targetRank, {
              sourceTimestamp: result.data.timestamp,
            });
          } else {
            setCachedOrderSummary(ordersSlug, targetRank, {
              wts: nextWts,
              wtb: nextWtb,
              sourceTimestamp: result.data.timestamp,
            });
          }
          ctx.clearOrderRetryCooldown(retryKey);
          return {
            wts: nextWts,
            wtb: nextWtb,
            hasOrders: true,
          };
        }

        if (result.status === "not_found") {
          setCachedOrderSummaryNoData(ordersSlug, targetRank);
          ctx.clearOrderRetryCooldown(retryKey);
          return {
            wts: null,
            wtb: null,
            hasOrders: true,
          };
        }

        ctx.setOrderRetryCooldown(retryKey, ORDER_TRANSIENT_RETRY_MS);
        return {
          wts: existingWts,
          wtb: existingWtb,
          hasOrders: existingHasOrders,
        };
      };

      if (!excludedRankedItem && (shouldFetchRank0 || shouldFetchRankMax) && ordersSlug) {
        if (shouldFetchRank0) {
          const refreshed = await refreshSummaryForRank(
            0,
            rank0RetryKey,
            shouldFetchRank0,
            wtsR0,
            wtbR0,
            hasOrdersR0,
          );
          wtsR0 = refreshed.wts;
          wtbR0 = refreshed.wtb;
          hasOrdersR0 = refreshed.hasOrders;
        }

        if (shouldFetchRankMax) {
          const refreshed = await refreshSummaryForRank(
            rankedMaxRank,
            rankMaxRetryKey,
            shouldFetchRankMax,
            wtsRmax,
            wtbRmax,
            hasOrdersRmax,
          );
          wtsRmax = refreshed.wts;
          wtbRmax = refreshed.wtb;
          hasOrdersRmax = refreshed.hasOrders;
        }
      }
    }

    // If the item already has ducats from the local database (WFCD/PEP), use them
    // and skip the per-item WFM meta fetch for ducat data.
    if (typeof item.ducats === "number" && Number.isFinite(item.ducats) && ducats == null) {
      ducats = Math.max(0, Math.round(item.ducats));
      hasDucats = true;
    }

    const needsMetaFetch = needs.ducats && (!hasDucats || ducats == null) && Boolean(slug);
    const shouldFetchMeta =
      Boolean(slug) &&
      (needsMetaFetch || (needsIcon && !lookupHasIcon && !thumb && !icon && !hasMeta));

    if (shouldFetchMeta) {
      const meta = await fetchWfmItemMetaBySlug(slug, { priority: fetchPriority });
      hasMeta = true;
      if (meta) {
        if (needsMetaFetch) {
          ducats =
            typeof meta.ducats === "number" && Number.isFinite(meta.ducats)
              ? Math.max(0, Math.round(meta.ducats))
              : null;
          if (ducats == null) {
            ctx.incrementMissingDucatRetryCount(key);
          } else {
            ctx.clearMissingDucatRetryCount(key);
          }
        }
        if (needsIcon) {
          thumb = meta.thumb || thumb;
          icon = meta.icon || icon;
        }
      }
      // Mark meta/ducats as attempted regardless of result to prevent re-queuing.
      if (needsMetaFetch) hasDucats = true;
    } else {
      // If we need ducats or icon metadata but have no usable slug,
      // mark the attempt complete to avoid endless re-queue loops.
      if (needs.ducats && !hasDucats && !slug) {
        hasDucats = true;
      }
      if (needsIcon && !lookupHasIcon && !hasMeta && !slug) {
        hasMeta = true;
      }
    }

    ctx.queueMetricPatch(key, {
      platinum,
      platinumR0,
      platinumRmax,
      hasPriceR0,
      hasPriceRmax,
      wtsR0,
      wtbR0,
      wtsRmax,
      wtbRmax,
      hasOrdersR0,
      hasOrdersRmax,
      priceRank,
      ducats,
      slug,
      thumb,
      icon,
      hasPrice,
      hasDucats,
      hasMeta,
    });
  } catch (error) {
    console.warn("[Inventory] metric hydration failed:", error);
  } finally {
    ctx.clearPending(key);
  }
}
