import { writable, type Readable } from "svelte/store";

import {
  fetchPriceByName,
  fetchPriceBySlug,
  getPriceDebugCounters,
  getPriceQueueStats,
  type PriceDebugCounters,
  type PriceQueueStats,
} from "../lib/wfm/wfmPrice.js";
import { getCachedPriceState } from "../lib/wfm/priceCache.js";
import { fetchItemOrderBookBySlug } from "../lib/wfm/orderBook.js";
import { fetchWfmItemMetaBySlug } from "../lib/wfm/wfmItemMeta.js";
import type { InventoryBaseItem, ItemMetrics, MetricNeeds } from "../lib/inventoryMarket.js";
import type { WfmItemsLookup } from "../types/ipc.js";

const HYDRATION_BATCH_SIZE = 12;
const HYDRATION_TICK_MS = 45;
const METRIC_FLUSH_MS = 80;
const MAX_DUCAT_RETRY_PER_ITEM = 2;
const PRICE_TRANSIENT_RETRY_MS = 20_000;
const PRICE_NO_DATA_RETRY_MS = 120_000;

interface HydrationTask {
  key: string;
  item: InventoryBaseItem;
  lookup: WfmItemsLookup;
  needs: MetricNeeds;
}

export interface InventoryPriceDebugCounters extends PriceDebugCounters {
  backendHitOk: number;
  backendHitNoData: number;
  backendError: number;
}

export interface InventoryHydrationDebugState {
  priceQueueStats: PriceQueueStats;
  priceDebugCounters: InventoryPriceDebugCounters;
  queued: number;
  pending: number;
}

interface InventoryHydrationController {
  metricsByKey: Readable<Record<string, ItemMetrics>>;
  debugState: Readable<InventoryHydrationDebugState>;
  enqueue: (items: InventoryBaseItem[], lookup: WfmItemsLookup, needs: MetricNeeds) => void;
  refreshDebugStats: () => void;
  /** Pause processing but keep cached metrics. */
  pause: () => void;
  /** Resume processing after a pause. */
  resume: () => void;
  /** @deprecated Use pause()/resume() instead. Full teardown clears all cached metrics. */
  destroy: () => void;
}

export function createInventoryHydrationController(): InventoryHydrationController {
  const normalizeCounters = (value: PriceDebugCounters): InventoryPriceDebugCounters => {
    const candidate = value as PriceDebugCounters & {
      backendHitOk?: number;
      backendHitNoData?: number;
      backendError?: number;
    };

    return {
      ...candidate,
      backendHitOk: candidate.backendHitOk ?? 0,
      backendHitNoData: candidate.backendHitNoData ?? 0,
      backendError: candidate.backendError ?? 0,
    };
  };

  const metricsByKeyStore = writable<Record<string, ItemMetrics>>({});
  const debugStateStore = writable<InventoryHydrationDebugState>({
    priceQueueStats: getPriceQueueStats(),
    priceDebugCounters: normalizeCounters(getPriceDebugCounters()),
    queued: 0,
    pending: 0,
  });

  let metricsByKey: Record<string, ItemMetrics> = {};
  let pendingMetricPatches: Record<string, ItemMetrics> = {};
  let metricFlushTimer: ReturnType<typeof setTimeout> | null = null;

  let pendingMetricKeys: Record<string, true> = {};
  let queuedMetricKeys: Record<string, true> = {};
  let hydrationQueue: HydrationTask[] = [];
  let hydrationRunning = false;
  let isMounted = true;
  let missingDucatRetryCountByKey: Record<string, number> = {};
  let priceTransientRetryAtByKey: Record<string, number> = {};

  function normalizeRankInput(value: unknown): number | null {
    if (value == null) return null;
    if (typeof value === "string" && value.trim().length === 0) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.floor(parsed);
  }

  function resolvePriceRank(item: InventoryBaseItem): number | null {
    const isRanked = item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes";
    if (!isRanked) return null;

    const fallbackMaxRank = item.inventoryGroup === "mods" ? 10 : 5;
    const parsedMaxRank = normalizeRankInput((item as { maxRank?: unknown }).maxRank);
    const maxRank = parsedMaxRank != null && parsedMaxRank > 0 ? parsedMaxRank : fallbackMaxRank;
    const parsedCurrentRank = normalizeRankInput((item as { rank?: unknown }).rank);
    const currentRank = parsedCurrentRank != null ? parsedCurrentRank : 0;

    return currentRank >= maxRank ? maxRank : 0;
  }

  function resolveRankedMaxRank(item: InventoryBaseItem): number | null {
    const isRanked = item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes";
    if (!isRanked) return null;

    const fallbackMaxRank = item.inventoryGroup === "mods" ? 10 : 5;
    const parsedMaxRank = normalizeRankInput((item as { maxRank?: unknown }).maxRank);
    if (parsedMaxRank != null && parsedMaxRank > 0) {
      return parsedMaxRank;
    }
    return fallbackMaxRank;
  }

  function getCachedMedian(cacheKey: string): number | null {
    const entry = getCachedPriceState(cacheKey);
    if (!entry || entry.status !== "ok") return null;
    return typeof entry.median === "number" && Number.isFinite(entry.median) ? entry.median : null;
  }

  function hasCachedRankPair(item: InventoryBaseItem): boolean {
    if ((item.inventoryGroup !== "mods" && item.inventoryGroup !== "arcanes") || !item.marketSlug) {
      return false;
    }

    const maxRank = resolveRankedMaxRank(item);
    if (maxRank == null) return false;

    const r0 = getCachedMedian(`${item.marketSlug}:rank-v3:r0`);
    const rmax = getCachedMedian(`${item.marketSlug}:rank-v3:r${maxRank}`);
    return r0 != null && rmax != null;
  }

  function hasPriceRetryCooldown(key: string): boolean {
    const retryAt = priceTransientRetryAtByKey[key];
    return typeof retryAt === "number" && retryAt > Date.now();
  }

  function setPriceRetryCooldown(key: string, delayMs: number): void {
    priceTransientRetryAtByKey = {
      ...priceTransientRetryAtByKey,
      [key]: Date.now() + delayMs,
    };
  }

  function priceRetryKey(itemKey: string, rank: number | null): string {
    return rank == null ? itemKey : `${itemKey}:r${rank}`;
  }

  function itemPriceRank(metric: ItemMetrics | undefined): number | null {
    return normalizeRankInput(metric?.priceRank) ?? null;
  }

  function hasResolvedPrice(metric: ItemMetrics | undefined): boolean {
    if (typeof metric?.platinum === "number" && Number.isFinite(metric.platinum)) {
      return true;
    }

    if (typeof metric?.platinumR0 === "number" && Number.isFinite(metric.platinumR0)) {
      return true;
    }

    if (typeof metric?.platinumRmax === "number" && Number.isFinite(metric.platinumRmax)) {
      return true;
    }

    return false;
  }

  function isActiveOrderStatus(status: string | null): boolean {
    return status === "ingame" || status === "online";
  }

  function cheapestOrderPrice(
    entries: Array<{ platinum: number; status: string | null }>,
    activeOnly: boolean,
  ): number | null {
    const list = activeOnly
      ? entries.filter((entry) => isActiveOrderStatus(entry.status))
      : entries;
    if (list.length === 0) return null;
    return Math.min(...list.map((entry) => entry.platinum));
  }

  function hasRankPairCoverage(
    metric: ItemMetrics | undefined,
    item: InventoryBaseItem,
    needs: MetricNeeds,
  ): boolean {
    const isRanked = item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes";
    if (!isRanked) return true;

    const hasPricePair = metric?.hasPriceR0 === true && metric?.hasPriceRmax === true;
    if (!hasPricePair) return false;
    if (!needs.orders) return true;
    if (item.tradable !== true) return true;

    return metric?.hasOrdersR0 === true && metric?.hasOrdersRmax === true;
  }

  function clearPriceRetryCooldown(key: string): void {
    if (!priceTransientRetryAtByKey[key]) return;
    const next = { ...priceTransientRetryAtByKey };
    delete next[key];
    priceTransientRetryAtByKey = next;
  }

  function canRetryMissingDucats(
    key: string,
    item: InventoryBaseItem,
    metric: ItemMetrics | undefined,
  ): boolean {
    if (!metric) return false;
    if (!metric.hasDucats || metric.ducats != null) return false;
    if (!metric.slug) return false;
    if (item.inventoryGroup !== "all_parts" && item.inventoryGroup !== "full_sets") return false;
    return (missingDucatRetryCountByKey[key] || 0) < MAX_DUCAT_RETRY_PER_ITEM;
  }

  function pushDebugState(): void {
    debugStateStore.set({
      priceQueueStats: getPriceQueueStats(),
      priceDebugCounters: normalizeCounters(getPriceDebugCounters()),
      queued: Object.keys(queuedMetricKeys).length,
      pending: Object.keys(pendingMetricKeys).length,
    });
  }

  function queueMetricPatch(key: string, metric: ItemMetrics): void {
    pendingMetricPatches = {
      ...pendingMetricPatches,
      [key]: metric,
    };

    if (metricFlushTimer) return;

    metricFlushTimer = setTimeout(() => {
      metricFlushTimer = null;
      if (Object.keys(pendingMetricPatches).length === 0) return;

      metricsByKey = {
        ...metricsByKey,
        ...pendingMetricPatches,
      };
      pendingMetricPatches = {};
      metricsByKeyStore.set(metricsByKey);
    }, METRIC_FLUSH_MS);
  }

  async function hydrateItemMetrics(
    item: InventoryBaseItem,
    lookup: WfmItemsLookup,
    needs: MetricNeeds,
  ): Promise<void> {
    const key = item.internalName;
    const existing = metricsByKey[key];
    const retryMissingDucats = canRetryMissingDucats(key, item, existing);
    const requestedRank = resolvePriceRank(item);
    const retryKey = priceRetryKey(key, requestedRank);
    const existingPriceRank = itemPriceRank(existing);
    const rankMismatch = needs.price && requestedRank !== existingPriceRank;

    if (needs.price && !rankMismatch && hasPriceRetryCooldown(retryKey)) {
      return;
    }

    const needsIcon = item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes";
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

    if (pendingMetricKeys[key]) return;
    pendingMetricKeys = { ...pendingMetricKeys, [key]: true };

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

      const fetchPriority =
        item.inventoryGroup === "all_parts" ||
        item.inventoryGroup === "full_sets" ||
        item.inventoryGroup === "mods" ||
        item.inventoryGroup === "arcanes"
          ? "high"
          : "normal";
      const isRankedListingItem =
        item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes";
      const rankedMaxRank = resolveRankedMaxRank(item);
      const allowNameLookup =
        !isRankedListingItem || Boolean(item.marketSlug) || Boolean(existing?.slug);
      const bypassNoDataCache = item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes";

      if (isRankedListingItem && rankedMaxRank != null && item.marketSlug) {
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
          clearPriceRetryCooldown(retryKey);
        } else if (bySlugStatus === "transient") {
          hasPrice = false;
          setPriceRetryCooldown(retryKey, PRICE_TRANSIENT_RETRY_MS);
        } else {
          hasPrice = true;
          priceRank = requestedRank;
          setPriceRetryCooldown(retryKey, PRICE_NO_DATA_RETRY_MS);
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
        const ordersSlug = slug || item.marketSlug;

        const fetchRankOrders = async (
          rank: number,
        ): Promise<{ wts: number | null; wtb: number | null }> => {
          if (!ordersSlug) {
            return { wts: null, wtb: null };
          }

          const result = await fetchItemOrderBookBySlug(ordersSlug, { rank });
          if (result.status !== "ok") {
            return { wts: null, wtb: null };
          }

          return {
            wts: cheapestOrderPrice(result.data.sell, true),
            wtb: cheapestOrderPrice(result.data.buy, true),
          };
        };

        if (!hasOrdersR0) {
          const rank0Orders = await fetchRankOrders(0);
          wtsR0 = rank0Orders.wts;
          wtbR0 = rank0Orders.wtb;
          hasOrdersR0 = true;
        }

        if (!hasOrdersRmax) {
          const rankMaxOrders = await fetchRankOrders(rankedMaxRank);
          wtsRmax = rankMaxOrders.wts;
          wtbRmax = rankMaxOrders.wtb;
          hasOrdersRmax = true;
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
              missingDucatRetryCountByKey = {
                ...missingDucatRetryCountByKey,
                [key]: (missingDucatRetryCountByKey[key] || 0) + 1,
              };
            } else if (missingDucatRetryCountByKey[key]) {
              const rest = { ...missingDucatRetryCountByKey };
              delete rest[key];
              missingDucatRetryCountByKey = rest;
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

      queueMetricPatch(key, {
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
      const rest = { ...pendingMetricKeys };
      delete rest[key];
      pendingMetricKeys = rest;
    }
  }

  async function runHydrationPump(): Promise<void> {
    if (hydrationRunning) return;
    hydrationRunning = true;

    try {
      while (isMounted && hydrationQueue.length > 0) {
        const batch = hydrationQueue.splice(0, HYDRATION_BATCH_SIZE);

        const pendingTasks: Promise<void>[] = [];
        for (const task of batch) {
          const nextQueued = { ...queuedMetricKeys };
          delete nextQueued[task.key];
          queuedMetricKeys = nextQueued;

          if (!isMounted) break;
          pendingTasks.push(hydrateItemMetrics(task.item, task.lookup, task.needs));
        }

        if (pendingTasks.length > 0) {
          await Promise.all(pendingTasks);
        }

        pushDebugState();
        await new Promise((resolve) => setTimeout(resolve, HYDRATION_TICK_MS));
      }
    } finally {
      hydrationRunning = false;
      pushDebugState();
      if (isMounted && hydrationQueue.length > 0) {
        void runHydrationPump();
      }
    }
  }

  function queueTasks(
    items: InventoryBaseItem[],
    lookup: WfmItemsLookup,
    needs: MetricNeeds,
  ): void {
    let appended = false;

    for (const item of items) {
      const key = item.internalName;
      if (pendingMetricKeys[key] || queuedMetricKeys[key]) continue;

      const existing = metricsByKey[key];
      const retryMissingDucats = canRetryMissingDucats(key, item, existing);
      const requestedRank = resolvePriceRank(item);
      const retryKey = priceRetryKey(key, requestedRank);
      const existingPriceRank = itemPriceRank(existing);
      const rankMismatch = needs.price && requestedRank !== existingPriceRank;
      const needsIcon = item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes";
      const iconReady = Boolean(item.marketThumb) || existing?.hasMeta === true;
      const rankPairCovered = hasRankPairCoverage(existing, item, needs);
      const cachedRankPairCovered = hasCachedRankPair(item);

      if (needs.price && !rankMismatch && hasPriceRetryCooldown(retryKey)) {
        continue;
      }

      if (
        !existing &&
        needs.price &&
        cachedRankPairCovered &&
        !needs.orders &&
        (!needs.ducats || item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes") &&
        (!needsIcon || iconReady)
      ) {
        continue;
      }

      if (
        existing &&
        (!needs.price || (!rankMismatch && hasResolvedPrice(existing) && rankPairCovered)) &&
        (!needs.ducats || existing.hasDucats) &&
        (!needsIcon || iconReady) &&
        !retryMissingDucats &&
        !rankMismatch
      ) {
        continue;
      }

      queuedMetricKeys = { ...queuedMetricKeys, [key]: true };
      hydrationQueue = [...hydrationQueue, { key, item, lookup, needs }];
      appended = true;
    }

    if (appended) {
      pushDebugState();
      void runHydrationPump();
    }
  }

  return {
    metricsByKey: {
      subscribe: metricsByKeyStore.subscribe,
    },
    debugState: {
      subscribe: debugStateStore.subscribe,
    },
    enqueue(items, lookup, needs) {
      queueTasks(items, lookup, needs);
    },
    refreshDebugStats() {
      pushDebugState();
    },
    pause() {
      isMounted = false;
      pushDebugState();
    },
    resume() {
      if (!isMounted) {
        isMounted = true;
        if (hydrationQueue.length > 0) {
          void runHydrationPump();
        }
      }
    },
    destroy() {
      isMounted = false;
      hydrationQueue = [];
      queuedMetricKeys = {};
      missingDucatRetryCountByKey = {};
      priceTransientRetryAtByKey = {};
      if (metricFlushTimer) {
        clearTimeout(metricFlushTimer);
        metricFlushTimer = null;
      }
      pushDebugState();
    },
  };
}

let _singleton: InventoryHydrationController | null = null;

/** Returns a shared singleton hydration controller that persists across view switches. */
export function getInventoryHydrationController(): InventoryHydrationController {
  if (!_singleton) {
    _singleton = createInventoryHydrationController();
  }
  return _singleton;
}
