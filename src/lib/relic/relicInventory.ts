import type { RawInventoryData } from "../../types/inventory.js";
import type { OwnedCounts, RelicDatabase } from "../../types/relics.js";

export function parseOwnedRelics(
  inventoryData: RawInventoryData | null,
  relicDb: RelicDatabase | null,
): OwnedCounts {
  const owned: OwnedCounts = {};
  if (!inventoryData || !relicDb) return owned;

  const countedByItemType = new Map<string, number>();

  const ensureOwnedSlot = (groupKey: string): void => {
    if (!owned[groupKey]) {
      owned[groupKey] = {
        intact: 0,
        exceptional: 0,
        flawless: 0,
        radiant: 0,
      };
    }
  };

  const addEntries = (entries: unknown, allowOverwriteExisting = false): number => {
    if (!Array.isArray(entries)) return 0;
    let hits = 0;

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const raw = entry as { ItemType?: string; ItemCount?: number };
      if (!raw.ItemType) continue;

      const info = relicDb.byUniqueName[raw.ItemType];
      if (!info) continue;

      const count = typeof raw.ItemCount === "number" ? raw.ItemCount : 1;

      if (countedByItemType.has(raw.ItemType)) {
        if (allowOverwriteExisting) {
          const existing = countedByItemType.get(raw.ItemType) || 0;
          countedByItemType.set(raw.ItemType, Math.max(existing, count));
        }
        continue;
      }

      countedByItemType.set(raw.ItemType, count);
      hits += count;
    }

    return hits;
  };

  // Primary source from API-helper and many inventory exports.
  addEntries(inventoryData.LevelKeys, true);

  // Additional commonly used collections can carry relic projections as well.
  addEntries(inventoryData.MiscItems);
  addEntries((inventoryData as Record<string, unknown>).Recipes);

  // Legacy fallback for exporters with different schemas.
  if (countedByItemType.size === 0) {
    for (const value of Object.values(inventoryData)) {
      addEntries(value);
    }
  }

  for (const [itemType, count] of countedByItemType) {
    const info = relicDb.byUniqueName[itemType];
    if (!info) continue;
    ensureOwnedSlot(info.groupKey);
    owned[info.groupKey][info.quality] += count;
  }

  return owned;
}
