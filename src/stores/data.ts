import { writable, derived } from "svelte/store";
import { parseInventory } from "../lib/inventory.js";
import { parseFoundry } from "../lib/inventory/foundryResources.js";
import type { WfmItemsLookup } from "../types/ipc.js";
import type {
  ComponentInfo,
  FoundryData,
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

/**
 * Foundry building / recipe list.
 *
 * Memoised across subscriptions: parsing the full itemDb is expensive (~1 s
 * on large accounts), so we cache the last result keyed on the identity of
 * the two inputs. Switching tabs (subscribing / unsubscribing) no longer
 * re-parses; only a real change to inventory or itemDb triggers work.
 */
let _foundryCache: FoundryData = { building: [], recipes: [] };
let _foundryInvRef: RawInventoryData | null = null;
let _foundryDbRef: Record<string, ItemDbEntry> | null = null;

export const foundryData = derived(
  [inventoryData, itemDb],
  ([$inv, $db]): FoundryData => {
    if ($inv === _foundryInvRef && $db === _foundryDbRef) return _foundryCache;
    _foundryInvRef = $inv;
    _foundryDbRef = $db;
    if (!$inv || !$db || Object.keys($db).length === 0) {
      _foundryCache = { building: [], recipes: [] };
    } else {
      _foundryCache = parseFoundry($inv, $db);
    }
    return _foundryCache;
  },
);

// Eagerly subscribe so the parse runs once as soon as inventory + itemDb are
// loaded \u2014 the first Foundry tab visit then just reads the cached result.
foundryData.subscribe(() => {});
