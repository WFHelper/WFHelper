/**
 * Inventory hydration controller — Svelte stores, queue pump, and singleton.
 *
 * Core hydration logic lives in `src/stores/hydration/hydrateItemMetrics.ts`.
 * Pure helpers and types live in `hydrationHelpers.ts`, `hydrationCacheHelpers.ts`,
 * and `hydrationTypes.ts` respectively.
 */

import { writable } from "svelte/store";

import {
  getPriceDebugCounters,
  getPriceQueueStats,
  type PriceDebugCounters,
} from "../lib/wfm/wfmPrice.js";
import { getOrderBookDebugCounters, type OrderBookDebugCounters } from "../lib/wfm/orderBook.js";
import {
  getOrderSummaryDebugCounters,
  type OrderSummaryDebugCounters,
} from "../lib/wfm/orderSummaryRemote.js";
import { normalizeWfmSlug } from "../lib/wfm/backendLite.js";
import type { InventoryBaseItem, ItemMetrics, MetricNeeds } from "../lib/inventoryMarket.js";
import type { WfmItemsLookup } from "../types/ipc.js";

import type {
  HydrationTask,
  InventoryPriceDebugCounters,
  InventoryHydrationDebugState,
  InventoryHydrationController,
} from "./hydration/hydrationTypes.js";
import {
  HYDRATION_BATCH_SIZE,
  HYDRATION_TICK_MS,
  METRIC_FLUSH_MS,
} from "./hydration/hydrationTypes.js";
import {
  resolvePriceRank,
  resolveRankedMaxRank,
  priceRetryKey,
  itemPriceRank,
  orderRetryKey,
  hasResolvedPrice,
  hasRankPairCoverage,
} from "./hydration/hydrationHelpers.js";
import {
  hasCachedRankPair,
  hasFreshOrderSummaryPair,
  getCachedMedian,
  getCachedRankOrderSummary,
} from "./hydration/hydrationCacheHelpers.js";
import { hydrateItemMetrics, type HydrationContext } from "./hydration/hydrateItemMetrics.js";
import { isRankedGroup } from "../../config/shared/numeric.js";
import { rendererPriceCacheKey } from "../../config/shared/wfmCacheKeys.js";

// Re-export types that consumers reference.

// Controller factory

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

  const cloneOrderSummaryCounters = (
    value: OrderSummaryDebugCounters,
  ): OrderSummaryDebugCounters => {
    return { ...value };
  };

  const cloneOrderBookCounters = (value: OrderBookDebugCounters): OrderBookDebugCounters => {
    return { ...value };
  };

  const metricsByKeyStore = writable<Record<string, ItemMetrics>>({});
  const debugStateStore = writable<InventoryHydrationDebugState>({
    priceQueueStats: getPriceQueueStats(),
    priceDebugCounters: normalizeCounters(getPriceDebugCounters()),
    orderSummaryDebugCounters: cloneOrderSummaryCounters(getOrderSummaryDebugCounters()),
    orderBookDebugCounters: cloneOrderBookCounters(getOrderBookDebugCounters()),
    queued: 0,
    pending: 0,
  });

  let metricsByKey: Record<string, ItemMetrics> = {};
  const pendingMetricPatches = new Map<string, ItemMetrics>();
  let metricFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const pendingMetricKeys = new Set<string>();
  const queuedMetricKeys = new Set<string>();
  let hydrationQueue: HydrationTask[] = [];
  let hydrationRunning = false;
  let isMounted = true;
  const missingDucatRetryCountByKey = new Map<string, number>();
  const priceTransientRetryAtByKey = new Map<string, number>();
  const orderTransientRetryAtByKey = new Map<string, number>();

  const ctx: HydrationContext = {
    getMetric: (key) => metricsByKey[key],

    hasPriceRetryCooldown(key) {
      const retryAt = priceTransientRetryAtByKey.get(key);
      return typeof retryAt === "number" && retryAt > Date.now();
    },
    setPriceRetryCooldown(key, delayMs) {
      priceTransientRetryAtByKey.set(key, Date.now() + delayMs);
    },
    clearPriceRetryCooldown(key) {
      priceTransientRetryAtByKey.delete(key);
    },

    hasOrderRetryCooldown(key) {
      const retryAt = orderTransientRetryAtByKey.get(key);
      return typeof retryAt === "number" && retryAt > Date.now();
    },
    setOrderRetryCooldown(key, delayMs) {
      orderTransientRetryAtByKey.set(key, Date.now() + delayMs);
    },
    clearOrderRetryCooldown(key) {
      orderTransientRetryAtByKey.delete(key);
    },

    getMissingDucatRetryCount(key) {
      return missingDucatRetryCountByKey.get(key) || 0;
    },
    incrementMissingDucatRetryCount(key) {
      missingDucatRetryCountByKey.set(key, (missingDucatRetryCountByKey.get(key) || 0) + 1);
    },
    clearMissingDucatRetryCount(key) {
      missingDucatRetryCountByKey.delete(key);
    },

    queueMetricPatch(key, metric) {
      pendingMetricPatches.set(key, metric);

      if (metricFlushTimer) return;

      metricFlushTimer = setTimeout(() => {
        metricFlushTimer = null;
        if (pendingMetricPatches.size === 0) return;

        const nextMetrics = { ...metricsByKey };
        for (const [patchKey, patchMetric] of pendingMetricPatches) {
          nextMetrics[patchKey] = patchMetric;
        }
        pendingMetricPatches.clear();
        metricsByKey = nextMetrics;
        metricsByKeyStore.set(metricsByKey);
      }, METRIC_FLUSH_MS);
    },

    markPending(key) {
      pendingMetricKeys.add(key);
    },
    clearPending(key) {
      pendingMetricKeys.delete(key);
    },
  };

  function pushDebugState(): void {
    debugStateStore.set({
      priceQueueStats: getPriceQueueStats(),
      priceDebugCounters: normalizeCounters(getPriceDebugCounters()),
      orderSummaryDebugCounters: cloneOrderSummaryCounters(getOrderSummaryDebugCounters()),
      orderBookDebugCounters: cloneOrderBookCounters(getOrderBookDebugCounters()),
      queued: queuedMetricKeys.size,
      pending: pendingMetricKeys.size,
    });
  }

  async function runHydrationPump(): Promise<void> {
    if (hydrationRunning) return;
    hydrationRunning = true;

    try {
      while (isMounted && hydrationQueue.length > 0) {
        const batch = hydrationQueue.splice(0, HYDRATION_BATCH_SIZE);

        const pendingTasks: Promise<void>[] = [];
        for (const task of batch) {
          queuedMetricKeys.delete(task.key);

          if (!isMounted) break;
          pendingTasks.push(hydrateItemMetrics(ctx, task.item, task.lookup, task.needs));
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
      if (pendingMetricKeys.has(key) || queuedMetricKeys.has(key)) continue;

      const existing = metricsByKey[key];
      const retryMissingDucats = canRetryMissingDucats(key, item, existing);
      const requestedRank = resolvePriceRank(item);
      const retryKey = priceRetryKey(key, requestedRank);
      const existingPriceRank = itemPriceRank(existing);
      const rankMismatch = needs.price && requestedRank !== existingPriceRank;
      const needsIcon = isRankedGroup(item.inventoryGroup);
      const iconReady = Boolean(item.marketThumb) || existing?.hasMeta === true;
      const rankPairCovered = hasRankPairCoverage(existing, item, needs);
      const cachedRankPairCovered = hasCachedRankPair(item);
      const rankedMaxRank = resolveRankedMaxRank(item);
      const existingSlug = normalizeWfmSlug(existing?.slug || item.marketSlug);
      const staleOrderSummaryPair =
        needs.orders &&
        isRankedGroup(item.inventoryGroup) &&
        item.tradable === true &&
        rankedMaxRank != null &&
        existingSlug != null &&
        !hasFreshOrderSummaryPair(existingSlug, rankedMaxRank);
      const allowNetworkFetch = needs.network === true;
      const ordersRetryBlocked =
        needs.orders &&
        isRankedGroup(item.inventoryGroup) &&
        item.tradable === true &&
        rankedMaxRank != null &&
        (!allowNetworkFetch ||
          (ctx.hasOrderRetryCooldown(orderRetryKey(key, 0)) &&
            ctx.hasOrderRetryCooldown(orderRetryKey(key, rankedMaxRank))));

      if (needs.price && !rankMismatch && ctx.hasPriceRetryCooldown(retryKey)) {
        continue;
      }

      if (ordersRetryBlocked) {
        continue;
      }

      if (
        !existing &&
        needs.price &&
        cachedRankPairCovered &&
        (!needs.orders || hasFreshOrderSummaryPair(item.marketSlug, rankedMaxRank ?? 0)) &&
        (!needs.ducats || isRankedGroup(item.inventoryGroup)) &&
        (!needsIcon || iconReady)
      ) {
        // Promote cached data directly into metricsByKey so the UI reflects
        // snapshot data immediately without a full hydrateItemMetrics pass.
        if (isRankedGroup(item.inventoryGroup) && item.marketSlug && rankedMaxRank != null) {
          const slug = item.marketSlug;
          const r0 = getCachedMedian(rendererPriceCacheKey(slug, 0));
          const rmax = getCachedMedian(rendererPriceCacheKey(slug, rankedMaxRank));
          const ordersR0 = needs.orders ? getCachedRankOrderSummary(slug, 0) : null;
          const ordersRmax = needs.orders ? getCachedRankOrderSummary(slug, rankedMaxRank) : null;
          const platinum = requestedRank === rankedMaxRank ? rmax : r0;
          ctx.queueMetricPatch(key, {
            platinum,
            platinumR0: r0,
            platinumRmax: rmax,
            hasPriceR0: r0 != null,
            hasPriceRmax: rmax != null,
            wtsR0: ordersR0?.wts ?? null,
            wtbR0: ordersR0?.wtb ?? null,
            wtsRmax: ordersRmax?.wts ?? null,
            wtbRmax: ordersRmax?.wtb ?? null,
            hasOrdersR0: !needs.orders || ordersR0 != null || !allowNetworkFetch,
            hasOrdersRmax: !needs.orders || ordersRmax != null || !allowNetworkFetch,
            priceRank: requestedRank,
            ducats: null,
            slug,
            thumb: item.marketThumb ?? null,
            icon: null,
            hasPrice: r0 != null || rmax != null,
            hasDucats: !needs.ducats,
            hasMeta: Boolean(item.marketThumb),
          });
        }
        continue;
      }

      if (
        existing &&
        (!needs.price || (!rankMismatch && hasResolvedPrice(existing) && rankPairCovered)) &&
        (!needs.ducats || existing.hasDucats) &&
        (!needsIcon || iconReady) &&
        !retryMissingDucats &&
        !rankMismatch &&
        (!staleOrderSummaryPair || !allowNetworkFetch)
      ) {
        continue;
      }

      queuedMetricKeys.add(key);
      hydrationQueue = [...hydrationQueue, { key, item, lookup, needs }];
      appended = true;
    }

    if (appended) {
      pushDebugState();
      void runHydrationPump();
    }
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
    return ctx.getMissingDucatRetryCount(key) < 2;
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
      queuedMetricKeys.clear();
      pendingMetricKeys.clear();
      missingDucatRetryCountByKey.clear();
      priceTransientRetryAtByKey.clear();
      orderTransientRetryAtByKey.clear();
      if (metricFlushTimer) {
        clearTimeout(metricFlushTimer);
        metricFlushTimer = null;
      }
      pendingMetricPatches.clear();
      pushDebugState();
    },
  };
}

// Singleton

let _singleton: InventoryHydrationController | null = null;

/** Returns a shared singleton hydration controller that persists across view switches. */
export function getInventoryHydrationController(): InventoryHydrationController {
  if (!_singleton) {
    _singleton = createInventoryHydrationController();
  }
  return _singleton;
}
