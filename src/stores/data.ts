import { writable, derived } from "svelte/store";
import { parseInventory } from "../lib/inventory.js";
import type { WfmItemsLookup } from "../types/ipc.js";
import type {
  ItemDbEntry,
  ParsedItem,
  RawInventoryData,
} from "../types/inventory.js";

export const itemDb = writable<Record<string, ItemDbEntry>>({});
export const wfmItems = writable<WfmItemsLookup>({});
export const inventoryData = writable<RawInventoryData | null>(null);

export const parsedItems = derived(
  [inventoryData, itemDb],
  ([$inv, $db]): ParsedItem[] => {
    if (!$inv || !$db || typeof $db !== "object") return [];
    if (Object.keys($db).length === 0) return [];
    return parseInventory($inv, $db);
  },
);
