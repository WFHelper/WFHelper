import { writable, derived } from "svelte/store";
import { ownedComponentCount } from "../../config/shared/componentNames.js";
import { aggregateComponentOwnership } from "../../config/shared/componentOwnership.js";
import { withoutFoundryPending } from "../../config/shared/foundryPending.js";
import { parseInventory } from "../lib/inventory.js";
import { parseFoundry } from "../lib/inventory/foundryResources.js";
import { gameRefKey } from "../lib/marketNaming.js";
import { hideFoundryClaims } from "./preferences.js";
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
/** mtime of the file behind `inventoryData`; dates its undated point-in-time fields. */
export const inventoryModifiedAt = writable<number | null>(null);

/** What the account can actually use: blueprints handed to the foundry are gone
 *  from the in-game inventory but stay in Recipes until the build is claimed. */
const usableInventory = derived(
  [inventoryData, hideFoundryClaims, itemDb],
  ([$inv, $hide, $db]): RawInventoryData | null =>
    $inv && $hide
      ? withoutFoundryPending($inv, (uniqueName) => $db[uniqueName]?.reusableBlueprint === true)
      : $inv,
);

/** Reactive map of uniqueName -> owned count, derived from MiscItems + Recipes. */
export const componentOwnership = derived(
  usableInventory,
  ($inv): Map<string, number> => ($inv ? aggregateComponentOwnership($inv) : new Map()),
);

/** Enrich raw db components with ownership counts from the reactive ownership map. */
export function enrichComponents(
  components: ComponentInfo[],
  ownership: Map<string, number>,
): ComponentInfo[] {
  return components.map((comp) => {
    const count = ownedComponentCount(comp.uniqueName, ownership);
    return { ...comp, ownedCount: count, owned: count >= (comp.itemCount || 1) };
  });
}

let _marketRefsWfmRef: WfmItemsLookup | null = null;
let _marketRefsCache: ReadonlySet<string> = new Set();

/** Game references warframe.market lists, so the parser can spare the tradable
 *  items inside an otherwise hidden class. A failed catalog load leaves this empty
 *  and the market side goes equally quiet, so the two degrade together. */
const marketGameRefs = derived(wfmItems, ($wfm): ReadonlySet<string> => {
  if ($wfm === _marketRefsWfmRef) return _marketRefsCache;
  const refs = new Set<string>();
  for (const item of Object.values($wfm)) {
    const key = gameRefKey(item.gameRef);
    if (key) refs.add(key);
  }
  _marketRefsWfmRef = $wfm;
  _marketRefsCache = refs;
  return refs;
});

// Same one-second parse as foundryData below, and a catalog write re-emits every
// input, so this caches by input identity too.
let _parsedCache: ParsedItem[] = [];
let _parsedInvRef: RawInventoryData | null = null;
let _parsedDbRef: Record<string, ItemDbEntry> | null = null;
let _parsedRefsRef: ReadonlySet<string> | null = null;

export const parsedItems = derived(
  [usableInventory, itemDb, marketGameRefs],
  ([$inv, $db, $marketGameRefs]): ParsedItem[] => {
    if ($inv === _parsedInvRef && $db === _parsedDbRef && $marketGameRefs === _parsedRefsRef) {
      return _parsedCache;
    }
    _parsedInvRef = $inv;
    _parsedDbRef = $db;
    _parsedRefsRef = $marketGameRefs;
    const parsable = $inv && $db && typeof $db === "object" && Object.keys($db).length > 0;
    _parsedCache = parsable ? parseInventory($inv, $db, $marketGameRefs) : [];
    return _parsedCache;
  },
);

// Parsing the full itemDb costs about one second on large accounts, so cache by
// input identity.
let _foundryCache: FoundryData = { building: [], recipes: [] };
let _foundryInvRef: RawInventoryData | null = null;
let _foundryDbRef: Record<string, ItemDbEntry> | null = null;

export const foundryData = derived([usableInventory, itemDb], ([$inv, $db]): FoundryData => {
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
