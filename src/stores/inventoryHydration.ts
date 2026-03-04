import { writable, type Readable } from "svelte/store";

import {
  fetchPriceByName,
  getPriceDebugCounters,
  getPriceQueueStats,
  type PriceDebugCounters,
  type PriceQueueStats,
} from "../lib/wfm/wfmPrice.js";
import { fetchWfmItemMetaBySlug } from "../lib/wfm/wfmItemMeta.js";
import type { InventoryBaseItem, ItemMetrics, MetricNeeds } from "../lib/inventoryMarket.js";
import type { WfmItemsLookup } from "../types/ipc.js";

const HYDRATION_BATCH_SIZE = 6;
const HYDRATION_TICK_MS = 120;
const METRIC_FLUSH_MS = 140;

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

    const needsIcon = item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes";
    const lookupHasIcon = Boolean(item.marketThumb);
    const iconReady = !needsIcon || lookupHasIcon || existing?.hasMeta === true;

    if (
      existing &&
      (!needs.price || existing.hasPrice) &&
      (!needs.ducats || existing.hasDucats) &&
      iconReady
    ) {
      return;
    }

    if (pendingMetricKeys[key]) return;
    pendingMetricKeys = { ...pendingMetricKeys, [key]: true };

    try {
      let platinum = existing?.platinum ?? null;
      let ducats = existing?.ducats ?? null;
      let slug = existing?.slug || item.marketSlug;
      let thumb = existing?.thumb || null;
      let icon = existing?.icon || null;
      let hasPrice = existing?.hasPrice || false;
      let hasDucats = existing?.hasDucats || false;
      let hasMeta = existing?.hasMeta || false;

      if (needs.price && !hasPrice) {
        const priceResult = await fetchPriceByName(item.name, lookup, {
          priority: "low",
        });
        if (priceResult?.median != null) {
          platinum = priceResult.median;
        }
        if (priceResult?.slug) {
          slug = priceResult.slug;
        }
        hasPrice = true;
      }

      const shouldFetchMeta =
        slug && (needs.ducats || (needsIcon && !lookupHasIcon && !thumb && !icon && !hasMeta));

      if (shouldFetchMeta) {
        const meta = await fetchWfmItemMetaBySlug(slug, { priority: "low" });
        hasMeta = true;
        if (meta) {
          if (needs.ducats) {
            ducats = typeof meta.ducats === "number" ? meta.ducats : null;
            hasDucats = true;
          }
          if (needsIcon) {
            thumb = meta.thumb || thumb;
            icon = meta.icon || icon;
          }
        } else if (needs.ducats) {
          hasDucats = true;
        }
      }

      queueMetricPatch(key, {
        platinum,
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

        for (const task of batch) {
          const nextQueued = { ...queuedMetricKeys };
          delete nextQueued[task.key];
          queuedMetricKeys = nextQueued;

          if (!isMounted) break;
          await hydrateItemMetrics(task.item, task.lookup, task.needs);
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
      const needsIcon = item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes";
      const iconReady = Boolean(item.marketThumb) || existing?.hasMeta === true;

      if (
        existing &&
        (!needs.price || existing.hasPrice) &&
        (!needs.ducats || existing.hasDucats) &&
        (!needsIcon || iconReady)
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
    destroy() {
      isMounted = false;
      hydrationQueue = [];
      queuedMetricKeys = {};
      if (metricFlushTimer) {
        clearTimeout(metricFlushTimer);
        metricFlushTimer = null;
      }
      pushDebugState();
    },
  };
}
