import { writable, derived } from "svelte/store";
import { aggregateComponentOwnership } from "../../config/shared/componentOwnership.js";
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

/** Reactive map of uniqueName -> owned count, derived from MiscItems + Recipes + PendingRecipes. */
export const componentOwnership = derived(
  inventoryData,
  ($inv): Map<string, number> =>
    $inv
      ? aggregateComponentOwnership($inv.MiscItems, $inv.Recipes, $inv.PendingRecipes)
      : new Map(),
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

export const parsedItems = derived([inventoryData, itemDb], ([$inv, $db]): ParsedItem[] => {
  if (!$inv || !$db || typeof $db !== "object") return [];
  if (Object.keys($db).length === 0) return [];
  return parseInventory($inv, $db);
});

/**
 * Foundry building / recipe list. Memoised on input identity - parsing the
 * full itemDb costs ~1 s on large accounts; only real input changes re-parse.
 */
let _foundryCache: FoundryData = { building: [], recipes: [] };
let _foundryInvRef: RawInventoryData | null = null;
let _foundryDbRef: Record<string, ItemDbEntry> | null = null;

export const foundryData = derived([inventoryData, itemDb], ([$inv, $db]): FoundryData => {
  if ($inv === _foundryInvRef && $db === _foundryDbRef) return _foundryCache;
  _foundryInvRef = $inv;
  _foundryDbRef = $db;
  if (!$inv || !$db || Object.keys($db).length === 0) {
    _foundryCache = { building: [], recipes: [] };
  } else {
    _foundryCache = parseFoundry($inv, $db);
  }
  return _foundryCache;
});
