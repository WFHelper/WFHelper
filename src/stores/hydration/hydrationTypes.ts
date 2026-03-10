import type { PriceDebugCounters, PriceQueueStats } from "../../lib/wfm/wfmPrice.js";
import type { OrderBookDebugCounters } from "../../lib/wfm/orderBook.js";
import type { OrderSummaryDebugCounters } from "../../lib/wfm/orderSummaryRemote.js";
import type { InventoryBaseItem, ItemMetrics, MetricNeeds } from "../../lib/inventoryMarket.js";
import type { WfmItemsLookup } from "../../types/ipc.js";
import type { Readable } from "svelte/store";

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

export const HYDRATION_BATCH_SIZE = 12;
export const HYDRATION_TICK_MS = 45;
export const METRIC_FLUSH_MS = 80;
export const MAX_DUCAT_RETRY_PER_ITEM = 2;
export const PRICE_TRANSIENT_RETRY_MS = 20_000;
export const PRICE_NO_DATA_RETRY_MS = 120_000;
export const ORDER_TRANSIENT_RETRY_MS = 20_000;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface HydrationTask {
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
  orderSummaryDebugCounters: OrderSummaryDebugCounters;
  orderBookDebugCounters: OrderBookDebugCounters;
  queued: number;
  pending: number;
}

export interface InventoryHydrationController {
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
