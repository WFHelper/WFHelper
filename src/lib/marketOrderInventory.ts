import { isRankedGroup, toFinitePositiveInt } from "../../config/shared/numeric.js";
import { WFM_ORDER_SUBTYPES } from "../../config/shared/wfmOrders.js";
import { isResourceItem, resolveItem, shouldHide } from "./inventory/itemClassification.js";
import { gameRefKey, normalizeMarketName, toMarketSlug } from "./marketNaming.js";
import { type InventoryBaseItem } from "./inventoryMarket.js";
import type { ListingInventoryMatch } from "./marketListing.js";
import type { InventoryGroup, ItemDbEntry, ParsedItem } from "../types/inventory.js";
import type { WfmItemsLookup } from "../types/ipc.js";
import type { WfmOrder } from "../types/market.js";

type MarketOrderInventoryItem = InventoryBaseItem & { sourceOrderId: string };
type WfmCatalogEntry = WfmItemsLookup[string];

// Both indexes below are keyed on the identity of their source, which only
// changes on a reload, so a rebuild costs nothing on the per-order hot path.
function createLazyIdentityCache<S, T>(build: (source: S) => T): (source: S) => T {
  let cache: { source: S; value: T } | null = null;
  return (source: S): T => {
    if (!cache || cache.source !== source) cache = { source, value: build(source) };
    return cache.value;
  };
}

// The lookup carries an entry per name and per game reference, so scanning it
// once per order is thousands of comparisons.
const catalogBySlug = createLazyIdentityCache((wfmItems: WfmItemsLookup) => {
  const index = new Map<string, WfmCatalogEntry>();
  for (const item of Object.values(wfmItems)) {
    const slug = toMarketSlug(item.url_name);
    if (slug && !index.has(slug)) index.set(slug, item);
  }
  return index;
});

function catalogEntryForOrder(order: WfmOrder, wfmItems: WfmItemsLookup): WfmCatalogEntry | null {
  const slug = toMarketSlug(order.itemUrlName || order.itemName);
  if (!slug) return null;
  return catalogBySlug(wfmItems).get(slug) ?? null;
}

type ParsedItemIndex = {
  byName: Map<string, ParsedItem[]>;
  bySlug: Map<string, ParsedItem[]>;
  byGameRef: Map<string, ParsedItem[]>;
};

// The item database names every refinement of a relic identically ("Axi A1
// Relic"); this pattern only recognises quality-suffixed name variants.
const RELIC_REFINEMENT_RE = new RegExp(
  `^(.+\\brelic)\\s*\\(?\\s*(${WFM_ORDER_SUBTYPES.join("|")})\\s*\\)?$`,
  "i",
);

function relicBaseName(name: string): string | null {
  const match = RELIC_REFINEMENT_RE.exec(name.trim());
  return match ? match[1].trim() : null;
}

// DE encodes the refinement as a metal suffix on the projection uniqueName
// (verified 1:1 across all 3096 catalog relics); display names never carry it.
const RELIC_QUALITY_BY_METAL: Record<string, string> = {
  Bronze: "intact",
  Silver: "exceptional",
  Gold: "flawless",
  Platinum: "radiant",
};

function relicQualityForItem(item: ParsedItem): string {
  if (typeof item.internalName === "string" && item.internalName.includes("/Projections/")) {
    const metal = /(Bronze|Silver|Gold|Platinum)$/.exec(item.internalName)?.[1];
    if (metal) return RELIC_QUALITY_BY_METAL[metal];
  }
  const match = RELIC_REFINEMENT_RE.exec(String(item.name ?? "").trim());
  return match ? match[2].toLowerCase() : "intact";
}

// Three reactive computations call this per order, so scanning the inventory
// three times each was O(orders * inventory).
const indexParsedItems = createLazyIdentityCache((parsedItems: ParsedItem[]) => {
  const index: ParsedItemIndex = { byName: new Map(), bySlug: new Map(), byGameRef: new Map() };
  const add = (bucket: Map<string, ParsedItem[]>, key: string, item: ParsedItem): void => {
    const rows = bucket.get(key);
    if (rows) rows.push(item);
    else bucket.set(key, [item]);
  };
  for (const item of parsedItems) {
    // The parser types name as string but odd inventory rows have leaked other
    // primitives; one bad row must not take down every market-inventory join.
    const name = typeof item.name === "string" ? item.name : String(item.name ?? "");
    add(index.byName, normalizeMarketName(name), item);
    add(index.bySlug, toMarketSlug(name), item);
    add(index.byGameRef, gameRefKey(item.internalName), item);
    const relicBase = relicBaseName(name);
    if (relicBase) {
      add(index.byName, normalizeMarketName(relicBase), item);
      add(index.bySlug, toMarketSlug(relicBase), item);
    }
  }
  return index;
});

/** Every inventory row the order could be about, best join first. A mod is one
 *  row per rank, so the caller needs all of them to judge a ranked listing. */
function matchingParsedItems(
  order: WfmOrder,
  parsedItems: ParsedItem[],
  wfmItems: WfmItemsLookup,
): ParsedItem[] {
  const index = indexParsedItems(parsedItems);
  // warframe.market renames a handful of items to keep them apart, so the game
  // reference is the only join that survives "Mutalist Alad V Assassinate (Key)".
  const gameRef = gameRefKey(catalogEntryForOrder(order, wfmItems)?.gameRef);
  const matches: ParsedItem[] = [];
  // Name beats slug beats game reference; each bucket keeps inventory order.
  const push = (rows: ParsedItem[] | undefined): void => {
    for (const item of rows ?? []) {
      if (!matches.includes(item)) matches.push(item);
    }
  };
  push(index.byName.get(normalizeMarketName(order.itemName)));
  push(index.bySlug.get(toMarketSlug(order.itemUrlName || order.itemName)));
  if (gameRef) push(index.byGameRef.get(gameRef));
  return matches;
}

function parsedItemForOrder(
  order: WfmOrder,
  parsedItems: ParsedItem[],
  wfmItems: WfmItemsLookup,
): ParsedItem | null {
  return matchingParsedItems(order, parsedItems, wfmItems)[0] ?? null;
}

function lookupMaxRank(order: WfmOrder, wfmItems: WfmItemsLookup): number | null {
  return toFinitePositiveInt(catalogEntryForOrder(order, wfmItems)?.maxRank);
}

function inventoryGroupForOrder(order: WfmOrder, parsedItem: ParsedItem | null): InventoryGroup {
  if (parsedItem?.inventoryGroup) return parsedItem.inventoryGroup;
  if (parsedItem?.categoryLabel?.toLowerCase().includes("arcane")) return "arcanes";
  if (parsedItem?.categoryLabel?.toLowerCase().includes("mod")) return "mods";
  if (order.modRank != null) return "mods";
  return "all_parts";
}

function ownedCountForOrder(parsedItem: ParsedItem | null): number {
  if (!parsedItem) return 0;
  if (typeof parsedItem.amount === "number") return parsedItem.amount;
  return parsedItem.currentlyOwned ? 1 : 0;
}

export function ownedCountForMarketOrder(
  order: WfmOrder,
  parsedItems: ParsedItem[],
  wfmItems: WfmItemsLookup = {},
): number {
  return ownedCountForOrder(parsedItemForOrder(order, parsedItems, wfmItems));
}

// Mirrors the two early returns in parseInventory: an item the parser never keeps
// can never be proven owned, so resources, gems and scenes stay unflagged.
function inventoryCouldHoldOrder(
  order: WfmOrder,
  wfmItems: WfmItemsLookup,
  itemDb: Record<string, ItemDbEntry>,
): boolean {
  const gameRef = catalogEntryForOrder(order, wfmItems)?.gameRef;
  if (!gameRef) return false;
  const dbEntry = itemDb[gameRef] || {};
  const resolved = resolveItem(gameRef, itemDb);
  if (shouldHide(gameRef, dbEntry, resolved, true)) return false;
  return !isResourceItem(gameRef, dbEntry, resolved);
}

/** Whether a live sell order is still backed by the inventory. "match" doubles
 *  as "no opinion" so an unprovable listing is never accused of being dead. */
export function orderInventoryMatch(
  order: WfmOrder,
  parsedItems: ParsedItem[],
  wfmItems: WfmItemsLookup,
  itemDb: Record<string, ItemDbEntry>,
): ListingInventoryMatch {
  if (order.orderType !== "sell") return { state: "match" };

  let owned = matchingParsedItems(order, parsedItems, wfmItems).filter(
    (item) => ownedCountForOrder(item) > 0,
  );
  // A refinement-specific listing is only backed by that refinement; an intact
  // stack cannot fulfil a radiant order.
  const orderSubtype = typeof order.subtype === "string" ? order.subtype.toLowerCase() : null;
  if (orderSubtype && RELIC_REFINEMENT_RE.exec(`${order.itemName} (${orderSubtype})`)) {
    owned = owned.filter((item) => relicQualityForItem(item) === orderSubtype);
  }
  if (owned.length === 0) {
    return inventoryCouldHoldOrder(order, wfmItems, itemDb)
      ? { state: "missing" }
      : { state: "match" };
  }

  const listed = toFinitePositiveInt(order.quantity) ?? 1;
  // A stack split across rank rows still backs one listing, so the rows that
  // survive the rank check are summed rather than read one at a time.
  const backing = (rows: ParsedItem[]): ListingInventoryMatch => {
    const total = rows.reduce((sum, item) => sum + ownedCountForOrder(item), 0);
    return total < listed ? { state: "partial", owned: total, listed } : { state: "match" };
  };

  if (order.modRank == null) return backing(owned);
  // A rank the inventory did not carry would reach the badge as "Rank NaN".
  const ranked = owned.filter(
    (item) => isRankedGroup(item.inventoryGroup) && Number.isFinite(item.rank),
  );
  if (ranked.length === 0) return backing(owned);
  const listedRank = Math.max(0, Math.floor(order.modRank));
  const atRank = ranked.filter((item) => Math.floor(item.rank) === listedRank);
  if (atRank.length > 0) return backing(atRank);
  return { state: "rank-mismatch", ownedRank: Math.floor(ranked[0].rank) };
}

export function buildMarketOrderInventoryItem(
  order: WfmOrder,
  parsedItems: ParsedItem[],
  wfmItems: WfmItemsLookup,
): MarketOrderInventoryItem {
  const parsedItem = parsedItemForOrder(order, parsedItems, wfmItems);
  const inventoryGroup = inventoryGroupForOrder(order, parsedItem);
  const isRankedListing = isRankedGroup(inventoryGroup);
  const rank = isRankedListing ? Math.max(0, Math.floor(order.modRank ?? 0)) : 0;
  const maxRank =
    toFinitePositiveInt(parsedItem?.maxRank) ??
    lookupMaxRank(order, wfmItems) ??
    (inventoryGroup === "mods" ? 10 : inventoryGroup === "arcanes" ? 5 : 0);
  const marketSlug = toMarketSlug(order.itemUrlName || order.itemName);
  const ownedCount = ownedCountForOrder(parsedItem);
  const subtype = typeof order.subtype === "string" && order.subtype ? order.subtype : null;
  const subtypeName = subtype
    ? `${order.itemName} (${subtype.charAt(0).toUpperCase()}${subtype.slice(1)})`
    : order.itemName;

  return {
    ...(parsedItem ?? {}),
    sourceOrderId: order.id,
    name: subtypeName,
    internalName: `market-order:${marketSlug || order.id}:r${rank}${subtype ? `:${subtype}` : ""}`,
    category: parsedItem?.category ?? (inventoryGroup === "mods" ? "Mods" : "Market"),
    categoryLabel: parsedItem?.categoryLabel ?? (inventoryGroup === "mods" ? "Mod" : "Market Item"),
    rank,
    maxRank,
    imageUrl: parsedItem?.imageUrl ?? order.itemThumb,
    isPrime: parsedItem?.isPrime ?? /\bprime\b/i.test(order.itemName),
    masteryReq: parsedItem?.masteryReq ?? 0,
    vaulted: parsedItem?.vaulted ?? false,
    tradable: true,
    description: parsedItem?.description ?? "",
    components: parsedItem?.components ?? [],
    drops: parsedItem?.drops ?? [],
    wikiaUrl: parsedItem?.wikiaUrl ?? null,
    inventoryGroup,
    partType: parsedItem?.partType ?? (/\bprime\b/i.test(order.itemName) ? "prime" : "normal"),
    amount: ownedCount,
    favorite: parsedItem?.favorite ?? false,
    equipped: parsedItem?.equipped ?? false,
    orderPlaced: true,
    completeSets: parsedItem?.completeSets ?? null,
    marketSlug: marketSlug || null,
    marketThumb: order.itemThumb ?? null,
    subtype,
  };
}
