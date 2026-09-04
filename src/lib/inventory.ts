import type {
  InventoryGroup,
  ItemDbEntry,
  ParsedItem,
  RawInventoryData,
  RawInventoryEntry,
} from "../types/inventory.js";

import {
  CATEGORIES,
  MODULAR_COLLECTION_KEYS,
  PET_COLLECTION_KEY,
  SUPPLEMENTAL_COLLECTIONS,
  resolveItem,
  resolveModularBuild,
  shouldHide,
  deriveGroup,
  inferCategory,
  isFocusUpgrade,
  isCatalogListedRankedItem,
  isMarketListedMissionKey,
  canonicalBuildPartName,
  isResourceItem,
} from "./inventory/itemClassification.js";

import { normalizeRank, hasAnyRankSignal } from "./inventory/rankExtraction.js";

import {
  pickBoolean,
  parseAmount,
  extractEquipContexts,
  normalizeCollectionEntries,
  preferGroup,
  mergeOptionalBoolean,
  mergeEquipContexts,
  collectEquippedUpgradeIds,
  entryInstanceId,
} from "./inventory/entryNormalization.js";

import { buildFullSetItems } from "./inventory/fullSets.js";

import { gameRefKey } from "./marketNaming.js";

export { parseFoundry, parseResources } from "./inventory/foundryResources.js";

export function parseInventory(
  data: RawInventoryData,
  itemDb: Record<string, ItemDbEntry>,
  // Holds gameRefKey-folded references: warframe.market does not promise DE's
  // casing on gameRef, so the lookup below folds its side too.
  marketGameRefs: ReadonlySet<string> = new Set(),
): ParsedItem[] {
  const itemMap = new Map<string, ParsedItem>();
  const sellableEquipmentCounts = new Map<string, number>();
  const equippedUpgradeIds = collectEquippedUpgradeIds(data);

  const toRankedInstanceKey = (
    baseInternalName: string,
    group: InventoryGroup,
    rank: number,
    maxRank: number,
  ): string => {
    if (group !== "mods" && group !== "arcanes") {
      return baseInternalName;
    }

    return `${baseInternalName}#r${rank}m${maxRank}`;
  };

  const addEntry = (
    entry: RawInventoryEntry,
    sourceKey: string,
    defaultCat: string,
    defaultLabel: string,
  ): void => {
    if (!entry?.ItemType) return;

    const internalName = entry.ItemType;
    const resolved = resolveItem(internalName, itemDb);
    const dbEntry = itemDb[internalName] || {};
    const modular = resolveModularBuild(sourceKey, entry, internalName, itemDb);
    // A built modular item and a hatched pet are both bound to the account, so
    // neither may be priced or counted in the inventory value totals.
    const accountBound = modular !== null || sourceKey === PET_COLLECTION_KEY;

    const marketListed = marketGameRefs.has(gameRefKey(internalName));
    if (!modular && shouldHide(internalName, dbEntry, resolved, marketListed)) return;
    if (!modular && isResourceItem(internalName, dbEntry, resolved)) return;

    let group = deriveGroup(sourceKey, internalName, dbEntry, resolved);
    // With the catalog loaded, an unlisted recipe row is a crafted component nobody
    // can sell, and a display-name collision would still price it in the parts tab.
    const recipePath = /\/Types\/Recipes\//i.test(internalName);
    if (group === "all_parts" && recipePath && marketGameRefs.size > 0 && !marketListed) {
      group = "misc";
    }
    let finalCat = inferCategory(internalName, defaultCat, dbEntry);
    let finalLabel = CATEGORIES.find((c) => c.cat === finalCat)?.label || defaultLabel;

    if (modular) {
      group = "equipment";
      finalCat = modular.category;
      finalLabel = modular.categoryLabel;
    } else if (group === "arcanes") {
      finalCat = "arcanes";
      finalLabel = "Arcane";
    } else if (group === "mods") {
      finalCat = "mods";
      finalLabel = "Mod";
    } else if (group === "relics") {
      finalCat = "relics";
      finalLabel = "Relic";
    } else if (
      group === "misc" &&
      (sourceKey === "LevelKeys" || isMarketListedMissionKey(internalName, marketListed))
    ) {
      // LevelKeys defaults to the relic label because that is most of what it holds;
      // market-listed mission keys arrive from other collections and are keys too.
      finalCat = "misc";
      finalLabel = "Key";
    } else if (group === "misc" && (sourceKey === "Upgrades" || sourceKey === "RawUpgrades")) {
      finalCat = "misc";
      finalLabel = "Misc";
    } else if (isFocusUpgrade(internalName, dbEntry, resolved)) {
      finalCat = "misc";
      finalLabel = "Focus";
    }

    const { rank, maxRank } = normalizeRank(entry, group, dbEntry);
    const amount = parseAmount(entry);
    const leveledSignal = hasAnyRankSignal(entry);
    const equippedIn = extractEquipContexts(entry);
    const favorite = pickBoolean(entry, ["Favorite", "IsFavorite", "favorite", "isFavorite"]);
    const equipped = pickBoolean(entry, [
      "Equipped",
      "IsEquipped",
      "Installed",
      "IsInstalled",
      "InUse",
    ]);
    // Mods/arcanes have no boolean flag - equipment configs reference the
    // equipped instance's ItemId instead.
    const instanceId = entryInstanceId(entry);
    const configEquipped = instanceId && equippedUpgradeIds.has(instanceId) ? true : undefined;
    const inferredEquipped =
      equipped !== undefined
        ? equipped
        : (configEquipped ?? (equippedIn.length > 0 ? true : undefined));

    const englishName = modular
      ? modular.name
      : canonicalBuildPartName(internalName, resolved.name);
    // The renderer prefers displayName, so a build has to carry the naming
    // part's localized name or none at all; the base row's would be generic.
    const localizedName = modular ? modular.displayName : resolved.displayName;

    const dbDucats =
      typeof dbEntry.ducats === "number" && Number.isFinite(dbEntry.ducats) ? dbEntry.ducats : null;

    // Two kitguns share one ItemType, so a build is keyed by its instance and
    // only falls back to the fitted parts when the payload carries no ItemId.
    const instanceKey = modular
      ? `${internalName}#b${instanceId ?? modular.partNames.join("|")}`
      : toRankedInstanceKey(internalName, group, rank, maxRank);

    // For recipe paths the catalog is the authority: WFM lists the exact
    // uniqueName it trades (frame parts only as ...Blueprint, weapon parts
    // bare), so a crafted ...Component never shows as sellable. The item-DB
    // flag covers the row until the catalog has loaded.
    const catalogTradable = recipePath
      ? marketGameRefs.size > 0
        ? marketListed
        : (dbEntry.tradable ?? resolved.isPrime ?? false)
      : isMarketListedMissionKey(internalName, marketListed) ||
        isCatalogListedRankedItem(group, marketListed) ||
        (dbEntry.tradable ?? resolved.isPrime ?? false);

    const rawXp = Number(entry.XP || 0);
    if (
      !accountBound &&
      group === "equipment" &&
      rank === 0 &&
      (!Number.isFinite(rawXp) || rawXp <= 0)
    ) {
      sellableEquipmentCounts.set(
        internalName,
        (sellableEquipmentCounts.get(internalName) || 0) + amount,
      );
    }

    const nextItem: ParsedItem = {
      name: englishName,
      ...(localizedName ? { displayName: localizedName } : {}),
      ...(resolved.cardArt ? { cardArt: true as const } : {}),
      internalName,
      category: finalCat,
      categoryLabel: finalLabel,
      rank,
      maxRank,
      imageUrl: modular ? modular.imageUrl : (resolved.imageUrl ?? null),
      isPrime: resolved.isPrime ?? false,
      partType: resolved.isPrime ? "prime" : "normal",
      masteryReq: resolved.masteryReq ?? 0,
      vaulted: resolved.vaulted ?? false,
      tradable: accountBound ? false : catalogTradable,
      amount,
      inventoryGroup: group,
      leveledUp: rank > 0 || leveledSignal,
      description: typeof dbEntry.description === "string" ? dbEntry.description : "",
      components: Array.isArray(dbEntry.components) ? dbEntry.components : [],
      drops: Array.isArray(dbEntry.drops) ? dbEntry.drops : [],
      wikiaUrl: typeof dbEntry.wikiaUrl === "string" ? dbEntry.wikiaUrl : null,
      ducats: accountBound ? null : dbDucats,
      keywords: [sourceKey.toLowerCase()],
      inventoryKey: instanceKey,
    };

    if (modular && modular.partNames.length > 0) nextItem.modularParts = modular.partNames;
    if (favorite !== undefined) nextItem.favorite = favorite;
    if (inferredEquipped !== undefined) nextItem.equipped = inferredEquipped;
    if (equippedIn.length > 0) nextItem.equippedIn = equippedIn;

    const existing = itemMap.get(instanceKey);
    if (!existing) {
      itemMap.set(instanceKey, nextItem);
      return;
    }

    existing.amount = (existing.amount || 0) + (nextItem.amount || 0);
    existing.rank = Math.max(existing.rank, nextItem.rank);
    existing.maxRank = Math.max(existing.maxRank, nextItem.maxRank);
    existing.leveledUp = Boolean(existing.leveledUp || nextItem.leveledUp);
    const mergedFavorite = mergeOptionalBoolean(existing.favorite, nextItem.favorite);
    if (mergedFavorite !== undefined) {
      existing.favorite = mergedFavorite;
    }
    const mergedEquipped = mergeOptionalBoolean(existing.equipped, nextItem.equipped);
    if (mergedEquipped !== undefined) {
      existing.equipped = mergedEquipped;
    }
    const mergedEquippedIn = mergeEquipContexts(existing.equippedIn, nextItem.equippedIn);
    if (mergedEquippedIn) {
      existing.equippedIn = mergedEquippedIn;
    }
    existing.inventoryGroup = preferGroup(
      existing.inventoryGroup,
      nextItem.inventoryGroup || "misc",
    );

    if (existing.category === "misc" && nextItem.category !== "misc") {
      existing.category = nextItem.category;
      existing.categoryLabel = nextItem.categoryLabel;
    }

    if (Array.isArray(existing.keywords)) {
      const nextKeywords = Array.isArray(nextItem.keywords) ? nextItem.keywords : [];
      for (const keyword of nextKeywords) {
        if (!existing.keywords.includes(keyword)) {
          existing.keywords.push(keyword);
        }
      }
    }
  };

  const record = data as Record<string, unknown>;

  for (const { key, cat, label } of CATEGORIES) {
    const entries = normalizeCollectionEntries(data[key]);
    if (entries.length === 0) continue;
    for (const entry of entries) {
      addEntry(entry, String(key), cat, label);
    }
  }

  // Not in CATEGORIES: DE keeps builds and hatched pets in the same collections.
  for (const key of MODULAR_COLLECTION_KEYS) {
    for (const entry of normalizeCollectionEntries(record[key])) {
      if (!entry.ItemType) continue;
      if (resolveModularBuild(key, entry, entry.ItemType, itemDb)) {
        addEntry(entry, key, "misc", "Misc");
        continue;
      }
      // A plain Kubrow or Kavat carries no ModularParts and would otherwise
      // never reach the inventory at all.
      if (key === PET_COLLECTION_KEY) addEntry(entry, key, "companions", "Companion");
    }
  }

  for (const { key, cat, label } of SUPPLEMENTAL_COLLECTIONS) {
    const entries = normalizeCollectionEntries(record[key]);
    if (entries.length === 0) continue;

    for (const entry of entries) {
      addEntry(entry, key, cat, label);
    }
  }

  const ownedCounts = new Map<string, number>();
  const combinedTotals = new Map<string, number>();
  for (const [instanceKey, item] of itemMap) {
    ownedCounts.set(instanceKey, item.amount || 0);
    if (item.inventoryGroup !== "mods" && item.inventoryGroup !== "arcanes") continue;
    const name = item.internalName;
    combinedTotals.set(name, (combinedTotals.get(name) || 0) + (item.amount || 0));
  }
  for (const item of itemMap.values()) {
    const total = combinedTotals.get(item.internalName);
    if (total !== undefined) item.combinedAmount = total;
  }

  return [...itemMap.values(), ...buildFullSetItems(itemDb, ownedCounts, sellableEquipmentCounts)];
}
