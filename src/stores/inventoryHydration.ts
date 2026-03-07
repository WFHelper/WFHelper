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
import { hasCachedRankPair, hasFreshOrderSummaryPair } from "./hydration/hydrationCacheHelpers.js";
import { hydrateItemMetrics, type HydrationContext } from "./hydration/hydrateItemMetrics.js";
import sharedNumeric from "../../config/shared/numeric.cjs";

const { isRankedGroup } = sharedNumeric as {
  isRankedGroup: (group: string | null | undefined) => boolean;
};

// Re-export types that consumers reference.
export type {
  InventoryPriceDebugCounters,
  InventoryHydrationDebugState,
} from "./hydration/hydrationTypes.js";

// ---------------------------------------------------------------------------
// Controller factory
// ---------------------------------------------------------------------------

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

  // ---- Svelte stores ----
  const metricsByKeyStore = writable<Record<string, ItemMetrics>>({});
  const debugStateStore = writable<InventoryHydrationDebugState>({
    priceQueueStats: getPriceQueueStats(),
    priceDebugCounters: normalizeCounters(getPriceDebugCounters()),
    queued: 0,
    pending: 0,
  });

  // ---- Closure state ----
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
  let orderTransientRetryAtByKey: Record<string, number> = {};

  // ---- Context that bridges closure state to hydrateItemMetrics ----
  const ctx: HydrationContext = {
    getMetric: (key) => metricsByKey[key],

    hasPriceRetryCooldown(key) {
      const retryAt = priceTransientRetryAtByKey[key];
      return typeof retryAt === "number" && retryAt > Date.now();
    },
    setPriceRetryCooldown(key, delayMs) {
      priceTransientRetryAtByKey = { ...priceTransientRetryAtByKey, [key]: Date.now() + delayMs };
    },
    clearPriceRetryCooldown(key) {
      if (!priceTransientRetryAtByKey[key]) return;
      const next = { ...priceTransientRetryAtByKey };
      delete next[key];
      priceTransientRetryAtByKey = next;
    },

    hasOrderRetryCooldown(key) {
      const retryAt = orderTransientRetryAtByKey[key];
      return typeof retryAt === "number" && retryAt > Date.now();
    },
    setOrderRetryCooldown(key, delayMs) {
      orderTransientRetryAtByKey = { ...orderTransientRetryAtByKey, [key]: Date.now() + delayMs };
    },
    clearOrderRetryCooldown(key) {
      if (!orderTransientRetryAtByKey[key]) return;
      const next = { ...orderTransientRetryAtByKey };
      delete next[key];
      orderTransientRetryAtByKey = next;
    },

    getMissingDucatRetryCount(key) {
      return missingDucatRetryCountByKey[key] || 0;
    },
    incrementMissingDucatRetryCount(key) {
      missingDucatRetryCountByKey = {
        ...missingDucatRetryCountByKey,
        [key]: (missingDucatRetryCountByKey[key] || 0) + 1,
      };
    },
    clearMissingDucatRetryCount(key) {
      if (!missingDucatRetryCountByKey[key]) return;
      const rest = { ...missingDucatRetryCountByKey };
      delete rest[key];
      missingDucatRetryCountByKey = rest;
    },

    queueMetricPatch(key, metric) {
      pendingMetricPatches = { ...pendingMetricPatches, [key]: metric };

      if (metricFlushTimer) return;

      metricFlushTimer = setTimeout(() => {
        metricFlushTimer = null;
        if (Object.keys(pendingMetricPatches).length === 0) return;

        metricsByKey = { ...metricsByKey, ...pendingMetricPatches };
        pendingMetricPatches = {};
        metricsByKeyStore.set(metricsByKey);
      }, METRIC_FLUSH_MS);
    },

    markPending(key) {
      pendingMetricKeys = { ...pendingMetricKeys, [key]: true };
    },
    clearPending(key) {
      const rest = { ...pendingMetricKeys };
      delete rest[key];
      pendingMetricKeys = rest;
    },
  };

  // ---- Debug state flusher ----
  function pushDebugState(): void {
    debugStateStore.set({
      priceQueueStats: getPriceQueueStats(),
      priceDebugCounters: normalizeCounters(getPriceDebugCounters()),
      queued: Object.keys(queuedMetricKeys).length,
      pending: Object.keys(pendingMetricKeys).length,
    });
  }

  // ---- Hydration pump ----
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

  // ---- Enqueue logic ----
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
      const ordersRetryBlocked =
        needs.orders &&
        isRankedGroup(item.inventoryGroup) &&
        item.tradable === true &&
        rankedMaxRank != null &&
        ctx.hasOrderRetryCooldown(orderRetryKey(key, 0)) &&
        ctx.hasOrderRetryCooldown(orderRetryKey(key, rankedMaxRank));

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
        !needs.orders &&
        (!needs.ducats || isRankedGroup(item.inventoryGroup)) &&
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
        !rankMismatch &&
        !staleOrderSummaryPair
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

  // ---- Public API ----
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
      orderTransientRetryAtByKey = {};
      if (metricFlushTimer) {
        clearTimeout(metricFlushTimer);
        metricFlushTimer = null;
      }
      pushDebugState();
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _singleton: InventoryHydrationController | null = null;

/** Returns a shared singleton hydration controller that persists across view switches. */
export function getInventoryHydrationController(): InventoryHydrationController {
  if (!_singleton) {
    _singleton = createInventoryHydrationController();
  }
  return _singleton;
}
