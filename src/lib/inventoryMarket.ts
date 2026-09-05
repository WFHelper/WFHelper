import type { MessageKey } from "./i18n.js";
import type { SharedFiltersState } from "../types/filters.js";
import type { ParsedItem, InventoryGroup, PartType } from "../types/inventory.js";
import type { WfmItemsLookup } from "../types/ipc.js";
import type { WfmOrdersResult } from "../types/market.js";
import type { RelicDatabase } from "../types/relics.js";
import { getCachedPriceState } from "./wfm/priceCache.js";
import { getCachedWfmItemMeta, resolveSnapshotSetSlug } from "./wfm/wfmItemMeta.js";
import { getCachedRankOrderSummary } from "../stores/hydration/hydrationCacheHelpers.js";
import { resolvePriceRank } from "../stores/hydration/hydrationHelpers.js";
import { normalizeLooseMarketName, normalizeMarketName, toMarketSlug } from "./marketNaming.js";
import {
  toFinitePositiveInt,
  toFiniteNumber,
  isRankedGroup,
  resolveRankedMaxRank,
} from "../../config/shared/numeric.js";
import { formatWfmAssetUrl, sanitizeWfmSlug } from "../../config/shared/wfm.js";
import { rendererPriceCacheKey } from "../../config/shared/wfmCacheKeys.js";
import { isExcludedRankedMarketItem } from "../../config/shared/wfmExclusions.js";

export type InventoryFilterTab = InventoryGroup | "resources" | "everything";

/**
 * Groups the Everything tab can draw from, in tab order. Resources come from a
 * separate parse and are appended by the view, not by buildBaseInventoryItems.
 */
export const EVERYTHING_SOURCES: readonly InventoryFilterTab[] = [
  "all_parts",
  "relics",
  "mods",
  "arcanes",
  "full_sets",
  "equipment",
  "resources",
  "misc",
];

/** Set rows aggregate parts already listed, so they stay opt-in. */
export const EVERYTHING_DEFAULT_SOURCES: readonly InventoryFilterTab[] = EVERYTHING_SOURCES.filter(
  (source) => source !== "full_sets",
);

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
  /** Relic refinement, doubling as the WFM order subtype for this row. */
  subtype: string | null;
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
  /** Mod or arcane falling back to DE art because no WFM icon resolved. */
  usesFallbackArt: boolean;
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

export const INVENTORY_FILTERS: Array<{ key: InventoryFilterTab; labelKey: MessageKey }> = [
  { key: "everything", labelKey: "inventory.tab.everything" },
  { key: "all_parts", labelKey: "inventory.tab.allParts" },
  { key: "relics", labelKey: "common.relics" },
  { key: "mods", labelKey: "inventory.tab.mods" },
  { key: "arcanes", labelKey: "inventory.tab.arcanes" },
  // No incomplete_sets tab: those live on the Mastery page, plus a Full Sets toggle.
  { key: "full_sets", labelKey: "inventory.tab.fullSets" },
  { key: "equipment", labelKey: "inventory.tab.equipment" },
  { key: "resources", labelKey: "nav.resources" },
  { key: "misc", labelKey: "inventory.tab.misc" },
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

function isSetSlug(slug: string | null | undefined): boolean {
  return typeof slug === "string" && slug.endsWith("_set");
}

function generatedSetSlugCandidates(item: ParsedItem): string[] {
  const candidates = new Set<string>();
  const direct = resolveSlug(item, {});
  if (direct) candidates.add(direct);
  if (item.name.includes("&")) {
    const withAnd = toMarketSlug(item.name.replace(/\s*&\s*/g, " and "));
    if (withAnd) candidates.add(withAnd.endsWith("_set") ? withAnd : `${withAnd}_set`);
  }
  return [...candidates];
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
  // Incomplete sets are the Full Sets tab's own toggle, never a category of
  // their own, so Everything must not surface them.
  if (tab === "everything") return group !== "incomplete_sets";
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

/** Catalog record for a game uniqueName. null when the key is unknown or maps to
 *  a different gameRef, so a coincidental key collision never resolves. */
export function getLookupByGameRef(
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
  if (lookupByGameRef?.url_name) return sanitizeWfmSlug(lookupByGameRef.url_name);

  const lookupByName = getLookupByName(item.name, lookup);
  if (lookupByName?.url_name) return sanitizeWfmSlug(lookupByName.url_name);

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
  // Everything carries parts and ranked items at once, so it needs both.
  const needsDucatsForTab =
    activeTab === "all_parts" || activeTab === "full_sets" || activeTab === "everything";
  const needsOrdersForTab = isRankedGroup(activeTab) || activeTab === "everything";
  return {
    price: true,
    ducats: needsDucatsForTab || filters.sortBy === "ducats" || filters.sortBy === "ducatonator",
    orders: needsOrdersForTab,
  };
}

/** Order ranks per key; RANKLESS_ORDER marks orders without a modRank. */
type OrderRankLookup = Record<string, number[]>;

/** Order subtypes per key; null marks orders without one. */
type OrderSubtypeLookup = Record<string, (string | null)[]>;

const RANKLESS_ORDER = -1;

export function buildOrderLookups(orders: WfmOrdersResult): {
  orderedNames: OrderRankLookup;
  orderedSlugs: OrderRankLookup;
  orderedSubtypes: OrderSubtypeLookup;
} {
  const orderedNames: OrderRankLookup = {};
  const orderedSlugs: OrderRankLookup = {};
  // Name and slug keys cannot collide (slugs carry underscores), so subtype
  // marks share one map keyed by both.
  const orderedSubtypes: OrderSubtypeLookup = {};
  const mark = (lookup: OrderRankLookup, key: string, modRank: unknown): void => {
    if (!key) return;
    const rank =
      typeof modRank === "number" && Number.isFinite(modRank)
        ? Math.max(0, Math.floor(modRank))
        : RANKLESS_ORDER;
    (lookup[key] ??= []).push(rank);
  };
  const markSubtype = (key: string, subtype: unknown): void => {
    if (!key) return;
    (orderedSubtypes[key] ??= []).push(
      typeof subtype === "string" && subtype ? subtype.toLowerCase() : null,
    );
  };

  for (const order of [...orders.sell, ...orders.buy]) {
    const nameKey = normalizeMarketName(order.itemName || "");
    const slugKey = (order.itemUrlName || "").trim().toLowerCase();
    mark(orderedNames, nameKey, order.modRank);
    mark(orderedSlugs, slugKey, order.modRank);
    markSubtype(nameKey, order.subtype);
    markSubtype(slugKey, order.subtype);
  }
  return { orderedNames, orderedSlugs, orderedSubtypes };
}

export function buildBaseInventoryItems(
  parsedItems: ParsedItem[],
  activeTab: InventoryFilterTab,
  wfmLookup: WfmItemsLookup,
  orderedNames: OrderRankLookup,
  orderedSlugs: OrderRankLookup,
  relicDb?: RelicDatabase | null,
  orderedSubtypes?: OrderSubtypeLookup,
): InventoryBaseItem[] {
  // DE exports cannot distinguish sellable sets such as Shedu from junk such as
  // Seer. Prefer the complete snapshot index; legacy snapshots fall back here.
  const catalogLoaded = Object.keys(wfmLookup).length > 0;

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
      const mappedSlug = lookupByName?.url_name ? sanitizeWfmSlug(lookupByName.url_name) : null;
      const mappedGameRefSlug = lookupByGameRef?.url_name
        ? sanitizeWfmSlug(lookupByGameRef.url_name)
        : null;
      const isSetGroup = group === "full_sets" || group === "incomplete_sets";
      const snapshotSetSlug = isSetGroup
        ? resolveSnapshotSetSlug([
            mappedGameRefSlug,
            mappedSlug,
            typeof item.marketSlug === "string" ? item.marketSlug : null,
            ...generatedSetSlugCandidates(item),
          ])
        : undefined;
      const displayName = relicGroupName || item.name;
      const fallbackRelicSlug = group === "relics" ? toMarketSlug(displayName) : null;
      // WFM knows one relic item per group; the refinement is the order subtype.
      const relicQuality = relicLookupInfo?.quality ?? null;
      const visibleName = relicQuality
        ? `${displayName} (${relicQuality.charAt(0).toUpperCase()}${relicQuality.slice(1)})`
        : displayName;
      const excludedRankedItem =
        isRankedGroup(group) &&
        isExcludedRankedMarketItem(
          displayName,
          mappedGameRefSlug ||
            mappedSlug ||
            (typeof item.marketSlug === "string" ? item.marketSlug : null),
        );

      if (isSetGroup) {
        if (snapshotSetSlug === null) return null;
        if (snapshotSetSlug === undefined && catalogLoaded && !isSetSlug(mappedSlug)) return null;
      }

      if (group === "all_parts" && !mappedSlug && item.tradable !== true) {
        return null;
      }

      const isRankedListingItem = isRankedGroup(group);
      const slugCandidate =
        snapshotSetSlug ||
        mappedGameRefSlug ||
        mappedSlug ||
        fallbackRelicSlug ||
        (group === "all_parts" && item.tradable !== true ? null : resolveSlug(item, wfmLookup));
      const cachedMeta = getCachedWfmItemMeta(slugCandidate);
      // A built modular item is account-bound, and it carries the name of its
      // defining part, so a same-name listing prices the loose part instead.
      const isModularBuild = Array.isArray(item.modularParts) && item.modularParts.length > 0;
      const canIndexMarket =
        !isModularBuild &&
        (!isRankedListingItem || (item.tradable === true && !excludedRankedItem));
      const marketSlug = canIndexMarket ? slugCandidate : null;
      // formatWfmAssetUrl also heals persisted caches that still hold direct
      // warframe.market URLs (challenge-gated since mid-2026) into mirror URLs.
      const marketThumb = formatWfmAssetUrl(
        lookupByGameRef?.thumb ||
          lookupByName?.thumb ||
          lookupByGameRef?.icon ||
          lookupByName?.icon ||
          cachedMeta?.thumb ||
          cachedMeta?.icon ||
          null,
      );
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

      const orderRanks = [
        ...(orderedNames[normalizeMarketName(displayName)] ?? []),
        ...((marketSlug && orderedSlugs[marketSlug]) || []),
      ];
      const orderSubtypes = [
        ...(orderedSubtypes?.[normalizeMarketName(displayName)] ?? []),
        ...((marketSlug && orderedSubtypes?.[marketSlug]) || []),
      ];
      // Rank-split rows only match orders for their own rank; a rank-less
      // order (parts, sets) marks every row of the item. Refinement rows only
      // match orders for their own subtype; a subtype-less order marks all.
      const orderPlaced =
        orderRanks.length > 0 &&
        (!isRankedListingItem ||
          orderRanks.some((rank) => rank === RANKLESS_ORDER || rank === resolvedRank)) &&
        (relicQuality == null ||
          orderSubtypes.some((subtype) => subtype === null || subtype === relicQuality));

      return {
        ...item,
        name: visibleName,
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
        subtype: relicQuality,
      };
    })
    .filter((item): item is InventoryBaseItem => item != null);
}

// Generic so callers that hang an extra field on the base item (market orders
// carry sourceOrderId) get it back on the view item instead of re-joining.
export function buildInventoryViewItems<T extends InventoryBaseItem>(
  baseItems: T[],
  metricsByKey: Record<string, ItemMetrics>,
): (T & InventoryViewItem)[] {
  return baseItems.map<T & InventoryViewItem>((item) => {
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

    const iconFromMeta = formatWfmAssetUrl(metric?.thumb || metric?.icon || null);
    // For mods and arcanes the WFM thumb beats DE's flat icon, but the framed
    // wiki card beats both, so cardArt wins wherever it exists.
    const displayImageUrl =
      isRankedListingItem && !item.cardArt
        ? item.marketThumb || iconFromMeta || item.imageUrl || null
        : item.imageUrl || item.marketThumb || iconFromMeta || null;
    const usesFallbackArt =
      isRankedListingItem && !item.cardArt && !item.marketThumb && !iconFromMeta;

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
      usesFallbackArt,
      equippedSummary,
    };
  });
}
