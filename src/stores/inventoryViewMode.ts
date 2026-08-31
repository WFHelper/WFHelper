import { persistedString } from "../lib/persistence.js";

export type InventoryViewMode = "cards" | "list";

/** Toggle order in the header; also the allow-list the persisted value degrades to. */
export const INVENTORY_VIEW_MODES: readonly InventoryViewMode[] = ["cards", "list"];

const STORAGE_KEY = "wf_inventory_view_mode";

export const inventoryViewMode = persistedString<InventoryViewMode>(
  STORAGE_KEY,
  INVENTORY_VIEW_MODES,
  "cards",
);
