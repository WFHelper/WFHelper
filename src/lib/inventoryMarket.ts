import type { SharedFiltersState } from "../types/filters.js";
import type { ParsedItem, InventoryGroup, PartType } from "../types/inventory.js";
import type { WfmItemsLookup } from "../types/ipc.js";
import type { WfmOrdersResult } from "../types/market.js";
import type { RelicDatabase } from "../types/relics.js";
import { getCachedPriceState } from "./wfm/priceCache.js";
import { getCachedWfmItemMeta } from "./wfm/wfmItemMeta.js";
import { getCachedRankOrderSummary } from "../stores/hydration/hydrationCacheHelpers.js";
import { resolvePriceRank } from "../stores/hydration/hydrationHelpers.js";
import { normalizeLooseMarketName, normalizeMarketName, toMarketSlug } from "./marketNaming.js";
import {
  toFinitePositiveInt,
  toFiniteNumber,
  isRankedGroup,
  resolveRankedMaxRank,
} from "../../config/shared/numeric.js";
import { rendererPriceCacheKey } from "../../config/shared/wfmCacheKeys.js";
import { isExcludedRankedMarketItem } from "../../config/shared/wfmExclusions.js";

export type InventoryFilterTab = InventoryGroup | "resources";

export interface InventoryBaseItem extends ParsedItem {
  inventoryGroup: InventoryGroup;
  partType: PartType;
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
  platinumR0: number | null;
  platinumRmax: number | null;
  wtsR0: number | null;
  wtbR0: number | null;
  wtsRmax: number | null;
  wtbRmax: number | null;
  ducats: number | null;
  ducatonator: number | null;
  displayImageUrl: string | null;
  equippedSummary: string | null;
}

export interface ItemMetrics {
  platinum: number | null;
  platinumR0?: number | null;
  platinumRmax?: number | null;
  hasPriceR0?: boolean;
  hasPriceRmax?: boolean;
  wtsR0?: number | null;
  wtbR0?: number | null;
  wtsRmax?: number | null;
  wtbRmax?: number | null;
  hasOrdersR0?: boolean;
  hasOrdersRmax?: boolean;
  priceRank?: number | null;
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
  orders: boolean;
  network?: boolean;
}

export const INVENTORY_FILTERS: Array<{ key: InventoryFilterTab; label: string }> = [
  { key: "all_parts", label: "All Parts" },
  { key: "relics", label: "Relics" },
  { key: "mods", label: "Mods" },
  { key: "arcanes", label: "Arcanes" },
  { key: "full_sets", label: "Full Sets" },
  { key: "equipment", label: "Equipment" },
  { key: "resources", label: "Resources" },
  { key: "misc", label: "Misc" },
];

function lookupNameCandidates(itemName: string): string[] {
  const base = itemName.trim();
  const candidates = new Set<string>([base]);
  const componentBlueprintRe =
    /\b(chassis|systems|neuroptics|helmet|barrel|receiver|stock|blade|handle|hilt|string|disc|grip|link|gauntlet|ornament|harness|carapace|cerebrum|pod|wings|fuselage|engines|avionics) blueprint$/i;
  const componentBaseRe =
    /\b(chassis|systems|neuroptics|helmet|barrel|receiver|stock|blade|handle|hilt|string|disc|grip|link|gauntlet|ornament|harness|carapace|cerebrum|pod|wings|fuselage|engines|avionics)$/i;

  if (componentBlueprintRe.test(base)) {
    candidates.add(base.replace(/\s+blueprint$/i, ""));
  } else if (componentBaseRe.test(base)) {
    candidates.add(`${base} Blueprint`);
  }

  if (/^zariman ship /i.test(base)) {
    candidates.add(base.replace(/^zariman ship /i, "Parallax "));
  }

  if (/^prime archwing /i.test(base)) {
    candidates.add(base.replace(/^prime archwing /i, "Odonata Prime "));
  }

  if (/\bbane of\b/i.test(base)) {
    candidates.add(base.replace(/\bbane of\b/i, "Cleanse "));
  }
  if (/\bcleanse\b/i.test(base)) {
    candidates.add(base.replace(/\bcleanse\b/i, "Bane of "));
  }
  if (/\borokin\b/i.test(base)) {
    candidates.add(base.replace(/\borokin\b/i, "Corrupted"));
  }
  if (/\bcorrupted\b/i.test(base)) {
    candidates.add(base.replace(/\bcorrupted\b/i, "Orokin"));
  }

  if (/\bhelmet blueprint$/i.test(base)) {
    candidates.add(base.replace(/\bhelmet blueprint$/i, "Neuroptics Blueprint"));
    candidates.add(base.replace(/\bhelmet blueprint$/i, "Neuroptics"));
  }
  if (/\bneuroptics blueprint$/i.test(base)) {
    candidates.add(base.replace(/\bneuroptics blueprint$/i, "Helmet Blueprint"));
    candidates.add(base.replace(/\bneuroptics blueprint$/i, "Neuroptics"));
  }

  for (const candidate of [...candidates]) {
    const punctuationAlias = candidate
      .replace(/[-_–]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (punctuationAlias && punctuationAlias !== candidate) {
      candidates.add(punctuationAlias);
    }
  }

  return [...candidates];
}

function isSetSlug(slug: string | null | undefined): boolean {
  return typeof slug === "string" && slug.endsWith("_set");
}

function resolveCachedPlatinum(item: InventoryBaseItem): number | null {
  if (!item.marketSlug) return null;

  const rank = resolvePriceRank(item);
  const cacheKey = rendererPriceCacheKey(item.marketSlug, rank);
  const entry = getCachedPriceState(cacheKey);
  if (!entry || entry.status !== "ok") return null;
  return toFiniteNumber(entry.median);
}

function resolveCachedRankPlatinum(slug: string | null | undefined, rank: number): number | null {
  if (!slug) return null;
  const entry = getCachedPriceState(rendererPriceCacheKey(slug, rank));
  if (!entry || entry.status !== "ok") return null;
  return toFiniteNumber(entry.median);
}

function itemGroupFallback(item: ParsedItem): InventoryFilterTab {
  const label = item.categoryLabel.toLowerCase();
  if (label.includes("relic")) return "relics";
  if (label.includes("mod")) return "mods";
  if (label.includes("arcane")) return "arcanes";
  if (/^(warframe|primary|secondary|melee|companion|archwing|amp|necramech)$/.test(label)) {
    return "equipment";
  }
  return "misc";
}

function matchesFilterTab(item: ParsedItem, tab: InventoryFilterTab): boolean {
  const group = item.inventoryGroup || itemGroupFallback(item);
  return group === tab;
}

export function getLookupByName(
  itemName: string,
  lookup: WfmItemsLookup,
): WfmItemsLookup[string] | null {
  for (const candidate of lookupNameCandidates(itemName)) {
    const key = normalizeMarketName(candidate);
    const direct = lookup[key] || null;
    if (!direct) continue;

    const mappedName = typeof direct.item_name === "string" ? direct.item_name : null;
    if (
      mappedName &&
      normalizeLooseMarketName(mappedName) !== normalizeLooseMarketName(candidate)
    ) {
      continue;
    }

    return direct;
  }

  return null;
}

function getLookupByGameRef(
  gameRef: string,
  lookup: WfmItemsLookup,
): WfmItemsLookup[string] | null {
  if (!gameRef) return null;
  const key = normalizeMarketName(gameRef);
  const direct = lookup[key] || null;
  if (!direct) return null;

  const mappedRef =
    typeof direct.gameRef === "string" && direct.gameRef.trim().length > 0
      ? normalizeMarketName(direct.gameRef)
      : null;
  if (mappedRef && mappedRef !== key) return null;
  return direct;
}

function resolveSlug(item: ParsedItem, lookup: WfmItemsLookup): string | null {
  const lookupByGameRef = getLookupByGameRef(item.internalName, lookup);
  if (lookupByGameRef?.url_name) return toMarketSlug(lookupByGameRef.url_name);

  const lookupByName = getLookupByName(item.name, lookup);
  if (lookupByName?.url_name) return toMarketSlug(lookupByName.url_name);

  if (isRankedGroup(item.inventoryGroup)) {
    return null;
  }

  const generated = toMarketSlug(item.name);
  if (!generated) return null;

  if (item.inventoryGroup === "full_sets" || /\bset$/i.test(item.name)) {
    return generated.endsWith("_set") ? generated : `${generated}_set`;
  }

  return generated;
}

export function shouldHydrateMetrics(item: ParsedItem): boolean {
  const group = item.inventoryGroup || itemGroupFallback(item);
  if (isRankedGroup(group)) {
    const marketSlug =
      "marketSlug" in item && typeof item.marketSlug === "string" ? item.marketSlug : null;
    return item.tradable === true && !isExcludedRankedMarketItem(item.name, marketSlug);
  }

  return item.tradable === true || group === "full_sets" || group === "all_parts";
}

export function metricNeedsFromFilters(
  filters: SharedFiltersState,
  activeTab: InventoryFilterTab,
): MetricNeeds {
  const needsDucatsForTab = activeTab === "all_parts" || activeTab === "full_sets";
  const needsOrdersForTab = isRankedGroup(activeTab);
  return {
    price: true,
    ducats: needsDucatsForTab || filters.sortBy === "ducats" || filters.sortBy === "ducatonator",
    orders: needsOrdersForTab,
  };
}

export function buildOrderLookups(orders: WfmOrdersResult): {
  orderedNames: Record<string, true>;
  orderedSlugs: Record<string, true>;
} {
  const merged = [...orders.sell, ...orders.buy];
  const orderedNames = Object.fromEntries(
    merged
      .map((order) => normalizeMarketName(order.itemName || ""))
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
  relicDb?: RelicDatabase | null,
): InventoryBaseItem[] {
  return parsedItems
    .filter((item) => matchesFilterTab(item, activeTab))
    .map<InventoryBaseItem | null>((item) => {
      const group = (item.inventoryGroup || itemGroupFallback(item)) as InventoryGroup;
      const relicLookupInfo =
        group === "relics" ? (relicDb?.byUniqueName?.[item.internalName] ?? null) : null;
      const rawRelicGroupName = relicLookupInfo
        ? (relicDb?.groups?.[relicLookupInfo.groupKey]?.name ?? null)
        : null;
      const relicGroupName =
        rawRelicGroupName && !rawRelicGroupName.endsWith(" Relic")
          ? `${rawRelicGroupName} Relic`
          : rawRelicGroupName;
      const lookupByName = getLookupByName(relicGroupName || item.name, wfmLookup);
      const lookupByGameRef = getLookupByGameRef(item.internalName, wfmLookup);
      const mappedSlug = lookupByName?.url_name ? toMarketSlug(lookupByName.url_name) : null;
      const mappedGameRefSlug = lookupByGameRef?.url_name
        ? toMarketSlug(lookupByGameRef.url_name)
        : null;
      const displayName = relicGroupName || item.name;
      const fallbackRelicSlug = group === "relics" ? toMarketSlug(displayName) : null;
      const excludedRankedItem =
        isRankedGroup(group) &&
        isExcludedRankedMarketItem(
          displayName,
          mappedGameRefSlug ||
            mappedSlug ||
            (typeof item.marketSlug === "string" ? item.marketSlug : null),
        );

      if (group === "full_sets" && !isSetSlug(mappedSlug)) {
        return null;
      }

      if (group === "all_parts" && !mappedSlug && item.tradable !== true) {
        return null;
      }

      const isRankedListingItem = isRankedGroup(group);
      const slugCandidate =
        mappedGameRefSlug ||
        mappedSlug ||
        fallbackRelicSlug ||
        (group === "all_parts" && item.tradable !== true ? null : resolveSlug(item, wfmLookup));
      const cachedMeta = getCachedWfmItemMeta(slugCandidate);
      const canIndexMarket =
        !isRankedListingItem || (item.tradable === true && !excludedRankedItem);
      const marketSlug = canIndexMarket ? slugCandidate : null;
      const marketThumb =
        lookupByGameRef?.thumb ||
        lookupByName?.thumb ||
        lookupByGameRef?.icon ||
        lookupByName?.icon ||
        cachedMeta?.thumb ||
        cachedMeta?.icon ||
        null;
      const lookupMaxRank = toFinitePositiveInt(lookupByName?.maxRank);
      const resolvedMaxRank =
        isRankedListingItem && lookupMaxRank != null ? lookupMaxRank : item.maxRank;
      const rankCap =
        toFinitePositiveInt(resolvedMaxRank) ??
        (group === "mods" ? 10 : group === "arcanes" ? 5 : 30);
      const resolvedRank =
        typeof item.rank === "number" && Number.isFinite(item.rank)
          ? Math.max(0, Math.min(Math.floor(item.rank), rankCap))
          : 0;

      const orderPlaced =
        Boolean(orderedNames[normalizeMarketName(displayName)]) ||
        (marketSlug ? Boolean(orderedSlugs[marketSlug]) : false);

      return {
        ...item,
        name: displayName,
        internalName:
          typeof item.inventoryKey === "string" && item.inventoryKey.trim().length > 0
            ? item.inventoryKey
            : item.internalName,
        rank: resolvedRank,
        maxRank: resolvedMaxRank,
        inventoryGroup: group,
        partType: (item.partType || (item.isPrime ? "prime" : "normal")) as PartType,
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
): InventoryViewItem[] {
  return baseItems.map<InventoryViewItem>((item) => {
    const metric = metricsByKey[item.internalName] || null;
    const isRankedListingItem = isRankedGroup(item.inventoryGroup);
    const itemMaxRank =
      toFinitePositiveInt(item.maxRank) ?? resolveRankedMaxRank(item.inventoryGroup);
    const itemCurrentRank = toFinitePositiveInt(item.rank) ?? 0;

    const metricPlatinumR0Raw = metric?.platinumR0 ?? null;
    const metricPlatinumR0Value = toFiniteNumber(metricPlatinumR0Raw);
    const metricPlatinumRmaxRaw = metric?.platinumRmax ?? null;
    const metricPlatinumRmaxValue = toFiniteNumber(metricPlatinumRmaxRaw);

    const cachedPlatinumR0 = isRankedListingItem
      ? resolveCachedRankPlatinum(item.marketSlug, 0)
      : null;
    const cachedPlatinumRmax = isRankedListingItem
      ? resolveCachedRankPlatinum(item.marketSlug, itemMaxRank)
      : null;
    const metricPlatinumR0 = metricPlatinumR0Value ?? cachedPlatinumR0;
    const metricPlatinumRmax = metricPlatinumRmaxValue ?? cachedPlatinumRmax;

    const metricWtsR0Raw = metric?.wtsR0 ?? null;
    const metricWtbR0Raw = metric?.wtbR0 ?? null;
    const metricWtsRmaxRaw = metric?.wtsRmax ?? null;
    const metricWtbRmaxRaw = metric?.wtbRmax ?? null;

    const metricWtsR0 = toFiniteNumber(metricWtsR0Raw);
    const metricWtbR0 = toFiniteNumber(metricWtbR0Raw);
    const metricWtsRmax = toFiniteNumber(metricWtsRmaxRaw);
    const metricWtbRmax = toFiniteNumber(metricWtbRmaxRaw);

    const cachedOrdersR0 = isRankedListingItem
      ? getCachedRankOrderSummary(item.marketSlug, 0)
      : null;
    const cachedOrdersRmax = isRankedListingItem
      ? getCachedRankOrderSummary(item.marketSlug, itemMaxRank)
      : null;

    const selectedRankPlatinum =
      isRankedListingItem && itemCurrentRank >= itemMaxRank ? metricPlatinumRmax : metricPlatinumR0;

    const platinumRaw = metric?.platinum ?? null;
    const platinumFromMetrics = toFiniteNumber(platinumRaw);
    const platinum = platinumFromMetrics ?? selectedRankPlatinum ?? resolveCachedPlatinum(item);
    const ducatsRaw = item.ducats ?? metric?.ducats ?? null;
    const ducats = toFiniteNumber(ducatsRaw);
    const ducatonator =
      ducats != null && platinum != null && platinum > 0
        ? Number((ducats / platinum).toFixed(2))
        : null;

    const iconFromMeta = metric?.thumb || metric?.icon || null;
    const displayImageUrl = isRankedGroup(item.inventoryGroup)
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
      platinumR0: isRankedListingItem ? metricPlatinumR0 : null,
      platinumRmax: isRankedListingItem ? metricPlatinumRmax : null,
      wtsR0: isRankedListingItem ? (metricWtsR0 ?? cachedOrdersR0?.wts ?? null) : null,
      wtbR0: isRankedListingItem ? (metricWtbR0 ?? cachedOrdersR0?.wtb ?? null) : null,
      wtsRmax: isRankedListingItem ? (metricWtsRmax ?? cachedOrdersRmax?.wts ?? null) : null,
      wtbRmax: isRankedListingItem ? (metricWtbRmax ?? cachedOrdersRmax?.wtb ?? null) : null,
      ducats,
      ducatonator,
      displayImageUrl,
      equippedSummary,
    };
  });
}
