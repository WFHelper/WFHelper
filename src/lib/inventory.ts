/**
 * Inventory parsing barrel.
 *
 * Heavy lifting is delegated to sub-modules under `./inventory/`:
 *   - itemClassification  -- type detection, visibility, group inference
 *   - rankExtraction      -- rank/maxRank parsing from entries & fingerprints
 *   - entryNormalization  -- boolean/amount/equip-context extraction, collection flattening
 *   - fullSets            -- full-set item generation from itemDb components
 *   - foundryResources    -- parseFoundry & parseResources
 *
 * This file contains the `parseInventory` orchestrator and re-exports the
 * public API consumed by the rest of the app.
 */

import type {
  InventoryGroup,
  ItemDbEntry,
  ParsedItem,
  RawInventoryData,
  RawInventoryEntry,
} from "../types/inventory.js";

import {
  CATEGORIES,
  SUPPLEMENTAL_COLLECTIONS,
  resolveItem,
  shouldHide,
  deriveGroup,
  inferCategory,
  isFocusUpgrade,
  canonicalBuildPartName,
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
} from "./inventory/entryNormalization.js";

import { buildFullSetItems } from "./inventory/fullSets.js";


export { parseFoundry, parseResources } from "./inventory/foundryResources.js";


export function parseInventory(
  data: RawInventoryData,
  itemDb: Record<string, ItemDbEntry>,
): ParsedItem[] {
  const itemMap = new Map<string, ParsedItem>();

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

    if (shouldHide(internalName, dbEntry, resolved)) return;

    const group = deriveGroup(sourceKey, internalName, dbEntry, resolved);
    let finalCat = inferCategory(internalName, defaultCat, dbEntry);
    let finalLabel = CATEGORIES.find((c) => c.cat === finalCat)?.label || defaultLabel;

    if (group === "arcanes") {
      finalCat = "arcanes";
      finalLabel = "Arcane";
    } else if (group === "mods") {
      finalCat = "mods";
      finalLabel = "Mod";
    } else if (group === "relics") {
      finalCat = "relics";
      finalLabel = "Relic";
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
    const inferredEquipped =
      equipped !== undefined ? equipped : equippedIn.length > 0 ? true : undefined;

    const displayName = canonicalBuildPartName(internalName, resolved.name);

    const dbDucats =
      typeof dbEntry.ducats === "number" && Number.isFinite(dbEntry.ducats) ? dbEntry.ducats : null;

    const instanceKey = toRankedInstanceKey(internalName, group, rank, maxRank);

    const nextItem: ParsedItem = {
      name: displayName,
      internalName,
      category: finalCat,
      categoryLabel: finalLabel,
      rank,
      maxRank,
      imageUrl: resolved.imageUrl ?? null,
      isPrime: resolved.isPrime ?? false,
      partType: resolved.isPrime ? "prime" : "normal",
      masteryReq: resolved.masteryReq ?? 0,
      vaulted: resolved.vaulted ?? false,
      tradable: dbEntry.tradable ?? resolved.isPrime ?? false,
      amount,
      inventoryGroup: group,
      leveledUp: rank > 0 || leveledSignal,
      description: typeof dbEntry.description === "string" ? dbEntry.description : "",
      components: Array.isArray(dbEntry.components) ? dbEntry.components : [],
      drops: Array.isArray(dbEntry.drops) ? dbEntry.drops : [],
      wikiaUrl: typeof dbEntry.wikiaUrl === "string" ? dbEntry.wikiaUrl : null,
      ducats: dbDucats,
      keywords: [sourceKey.toLowerCase()],
      inventoryKey: instanceKey,
    };

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

  for (const { key, cat, label } of CATEGORIES) {
    const entries = normalizeCollectionEntries(data[key]);
    if (entries.length === 0) continue;
    for (const entry of entries) {
      addEntry(entry, String(key), cat, label);
    }
  }

  const record = data as Record<string, unknown>;
  for (const { key, cat, label } of SUPPLEMENTAL_COLLECTIONS) {
    const entries = normalizeCollectionEntries(record[key]);
    if (entries.length === 0) continue;

    for (const entry of entries) {
      addEntry(entry, key, cat, label);
    }
  }

  const ownedCounts = new Map<string, number>();
  for (const [internalName, item] of itemMap) {
    ownedCounts.set(internalName, item.amount || 0);
  }

  return [...itemMap.values(), ...buildFullSetItems(itemDb, ownedCounts)];
}
