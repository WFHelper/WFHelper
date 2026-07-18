import type { InventoryBaseItem, ItemMetrics, MetricNeeds } from "../../lib/inventoryMarket.js";
import type { WfmItemsLookup } from "../../types/ipc.js";
import type { Readable } from "svelte/store";

export const HYDRATION_BATCH_SIZE = 12;
export const HYDRATION_TICK_MS = 45;
export const METRIC_FLUSH_MS = 80;
export const MAX_DUCAT_RETRY_PER_ITEM = 2;
export const PRICE_TRANSIENT_RETRY_MS = 20_000;
export const PRICE_NO_DATA_RETRY_MS = 120_000;
export const ORDER_TRANSIENT_RETRY_MS = 20_000;

export interface HydrationTask {
  key: string;
  item: InventoryBaseItem;
  lookup: WfmItemsLookup;
  needs: MetricNeeds;
}

export interface InventoryHydrationController {
  metricsByKey: Readable<Record<string, ItemMetrics>>;
  enqueue: (items: InventoryBaseItem[], lookup: WfmItemsLookup, needs: MetricNeeds) => void;
  /** Pause processing but keep cached metrics. */
  pause: () => void;
  /** Resume processing after a pause. */
  resume: () => void;
}
