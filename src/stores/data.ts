import { writable, derived } from "svelte/store";
import { parseInventory } from "../lib/inventory.js";
import type { WfmItemsLookup } from "../types/ipc.js";
import type {
  ComponentInfo,
  ItemDbEntry,
  ParsedItem,
  RawInventoryData,
} from "../types/inventory.js";

export const itemDb = writable<Record<string, ItemDbEntry>>({});
export const wfmItems = writable<WfmItemsLookup>({});
export const inventoryData = writable<RawInventoryData | null>(null);

/** Reactive map of uniqueName → owned count, derived from MiscItems + Recipes + PendingRecipes. */
export const componentOwnership = derived(
  inventoryData,
  ($inv): Map<string, number> => {
    const owned = new Map<string, number>();
    if (!$inv) return owned;
    for (const arr of [$inv.MiscItems, $inv.Recipes]) {
      if (!Array.isArray(arr)) continue;
      for (const e of arr) {
        if (e.ItemType) owned.set(e.ItemType, (owned.get(e.ItemType) || 0) + (e.ItemCount || 1));
      }
    }
    if (Array.isArray($inv.PendingRecipes)) {
      for (const e of $inv.PendingRecipes) {
        if (e.ItemType) owned.set(e.ItemType, (owned.get(e.ItemType) || 0) + 1);
      }
    }
    return owned;
  },
);

/** Enrich raw db components with ownership counts from the reactive ownership map. */
export function enrichComponents(
  components: ComponentInfo[],
  ownership: Map<string, number>,
): ComponentInfo[] {
  return components.map((comp) => {
    const count = comp.uniqueName ? ownership.get(comp.uniqueName) || 0 : 0;
    return { ...comp, ownedCount: count, owned: count >= (comp.itemCount || 1) };
  });
}

export const parsedItems = derived(
  [inventoryData, itemDb],
  ([$inv, $db]): ParsedItem[] => {
    if (!$inv || !$db || typeof $db !== "object") return [];
    if (Object.keys($db).length === 0) return [];
    return parseInventory($inv, $db);
  },
);
