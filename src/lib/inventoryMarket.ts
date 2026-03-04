import type { SharedFiltersState } from "../types/filters.js";
import type { ParsedItem } from "../types/inventory.js";
import type { WfmItemsLookup } from "../types/ipc.js";
import type { WfmOrdersResult } from "../types/market.js";

export type InventoryFilterTab = "all_parts" | "relics" | "mods" | "arcanes" | "full_sets" | "misc";

export interface InventoryBaseItem extends ParsedItem {
  inventoryGroup: InventoryFilterTab;
  partType: "normal" | "prime";
  amount: number;
  favorite: boolean;
  equipped: boolean;
  orderPlaced: boolean;
  completeSets: number | boolean | null;
  marketSlug: string | null;
  marketThumb: string | null;
}

export interface InventoryViewItem extends InventoryBaseItem {
  platinum: number | null;
  ducats: number | null;
  ducatonator: number | null;
  displayImageUrl: string | null;
  equippedSummary: string | null;
  debugLabel: string;
}

export interface ItemMetrics {
  platinum: number | null;
  ducats: number | null;
  slug: string | null;
  thumb: string | null;
  icon: string | null;
  hasPrice: boolean;
  hasDucats: boolean;
  hasMeta: boolean;
}

export interface MetricNeeds {
  price: boolean;
  ducats: boolean;
}

export const INVENTORY_FILTERS: Array<{ key: InventoryFilterTab; label: string }> = [
  { key: "all_parts", label: "All Parts" },
  { key: "relics", label: "Relics" },
  { key: "mods", label: "Mods" },
  { key: "arcanes", label: "Arcanes" },
  { key: "full_sets", label: "Full Sets" },
  { key: "misc", label: "Misc" },
];

export function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeLooseName(value: string): string {
  return normalizeName(value).replace(/[^a-z0-9]+/g, "");
}

function lookupNameCandidates(itemName: string): string[] {
  const base = itemName.trim();
  const candidates = new Set<string>([base]);

  if (/\bhelmet blueprint$/i.test(base)) {
    candidates.add(base.replace(/\bhelmet blueprint$/i, "Neuroptics Blueprint"));
  }
  if (/\bneuroptics blueprint$/i.test(base)) {
    candidates.add(base.replace(/\bneuroptics blueprint$/i, "Helmet Blueprint"));
  }

  return [...candidates];
}

function toMarketSlug(name: string): string {
  return normalizeName(name)
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isSetSlug(slug: string | null | undefined): boolean {
  return typeof slug === "string" && slug.endsWith("_set");
}

export function itemGroupFallback(item: ParsedItem): InventoryFilterTab {
  const label = item.categoryLabel.toLowerCase();
  if (label.includes("relic")) return "relics";
  if (label.includes("mod")) return "mods";
  if (label.includes("arcane")) return "arcanes";
  return "misc";
}

export function matchesFilterTab(item: ParsedItem, tab: InventoryFilterTab): boolean {
  const group = item.inventoryGroup || itemGroupFallback(item);
  return group === tab;
}

export function getLookupByName(
  itemName: string,
  lookup: WfmItemsLookup,
): WfmItemsLookup[string] | null {
  for (const candidate of lookupNameCandidates(itemName)) {
    const key = normalizeName(candidate);
    const direct = lookup[key] || null;
    if (!direct) continue;

    const mappedName = typeof direct.item_name === "string" ? direct.item_name : null;
    if (mappedName && normalizeLooseName(mappedName) !== normalizeLooseName(candidate)) {
      continue;
    }

    return direct;
  }

  return null;
}

export function resolveSlug(item: ParsedItem, lookup: WfmItemsLookup): string | null {
  const lookupByName = getLookupByName(item.name, lookup);
  if (lookupByName?.url_name) return lookupByName.url_name;

  const generated = toMarketSlug(item.name);
  if (!generated) return null;

  if (item.inventoryGroup === "full_sets" || /\bset$/i.test(item.name)) {
    return generated.endsWith("_set") ? generated : `${generated}_set`;
  }

  return generated;
}

export function shouldHydrateMetrics(item: ParsedItem): boolean {
  const group = item.inventoryGroup || itemGroupFallback(item);
  return (
    item.tradable ||
    group === "full_sets" ||
    group === "all_parts" ||
    group === "relics" ||
    group === "mods" ||
    group === "arcanes"
  );
}

export function metricNeedsFromFilters(
  filters: SharedFiltersState,
  activeTab: InventoryFilterTab,
): MetricNeeds {
  const needsDucatsForTab = activeTab === "all_parts" || activeTab === "full_sets";
  return {
    price: true,
    ducats: needsDucatsForTab || filters.sortBy === "ducats" || filters.sortBy === "ducatonator",
  };
}

export function buildOrderLookups(orders: WfmOrdersResult): {
  orderedNames: Record<string, true>;
  orderedSlugs: Record<string, true>;
} {
  const merged = [...orders.sell, ...orders.buy];
  const orderedNames = Object.fromEntries(
    merged
      .map((order) => normalizeName(order.itemName || ""))
      .filter(Boolean)
      .map((name) => [name, true]),
  ) as Record<string, true>;

  const orderedSlugs = Object.fromEntries(
    merged
      .map((order) => (order.itemUrlName || "").trim().toLowerCase())
      .filter(Boolean)
      .map((slug) => [slug, true]),
  ) as Record<string, true>;

  return { orderedNames, orderedSlugs };
}

export function buildBaseInventoryItems(
  parsedItems: ParsedItem[],
  activeTab: InventoryFilterTab,
  wfmLookup: WfmItemsLookup,
  orderedNames: Record<string, true>,
  orderedSlugs: Record<string, true>,
): InventoryBaseItem[] {
  return parsedItems
    .filter((item) => matchesFilterTab(item, activeTab))
    .map<InventoryBaseItem | null>((item) => {
      const group = (item.inventoryGroup || itemGroupFallback(item)) as InventoryFilterTab;
      const lookupByName = getLookupByName(item.name, wfmLookup);

      if (group === "full_sets" && !isSetSlug(lookupByName?.url_name || null)) {
        return null;
      }

      const marketSlug = lookupByName?.url_name || resolveSlug(item, wfmLookup);
      const marketThumb = lookupByName?.thumb || lookupByName?.icon || null;

      const orderPlaced =
        Boolean(orderedNames[normalizeName(item.name)]) ||
        (marketSlug ? Boolean(orderedSlugs[marketSlug]) : false);

      return {
        ...item,
        inventoryGroup: group,
        partType: (item.partType || (item.isPrime ? "prime" : "normal")) as "normal" | "prime",
        amount: typeof item.amount === "number" ? item.amount : 1,
        favorite: Boolean(item.favorite),
        equipped: Boolean(item.equipped),
        orderPlaced,
        completeSets:
          typeof item.completeSets === "number" || typeof item.completeSets === "boolean"
            ? item.completeSets
            : null,
        marketSlug,
        marketThumb,
      };
    })
    .filter((item): item is InventoryBaseItem => item != null);
}

export function buildInventoryViewItems(
  baseItems: InventoryBaseItem[],
  metricsByKey: Record<string, ItemMetrics>,
  activeTab: InventoryFilterTab,
): InventoryViewItem[] {
  return baseItems.map<InventoryViewItem>((item) => {
    const metric = metricsByKey[item.internalName] || null;
    const platinum = metric?.platinum ?? null;
    const ducats = metric?.ducats ?? null;
    const ducatonator =
      ducats != null && platinum != null && platinum > 0
        ? Number((ducats / platinum).toFixed(2))
        : null;

    const iconFromMeta = metric?.thumb || metric?.icon || null;
    const displayImageUrl =
      item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes"
        ? item.marketThumb || iconFromMeta || item.imageUrl || null
        : item.imageUrl || item.marketThumb || iconFromMeta || null;

    const equippedInList = Array.isArray(item.equippedIn) ? item.equippedIn : [];
    const equippedSummary =
      equippedInList.length > 0
        ? `Equipped in ${equippedInList.slice(0, 2).join(", ")}${equippedInList.length > 2 ? " +" : ""}`
        : null;

    return {
      ...item,
      platinum,
      ducats,
      ducatonator,
      displayImageUrl,
      equippedSummary,
      debugLabel: item.debugReason || `show:inventory:${activeTab}:${item.inventoryGroup}`,
    };
  });
}

export function computeFilteredTotalCount(items: InventoryViewItem[]): number {
  return items.length;
}
