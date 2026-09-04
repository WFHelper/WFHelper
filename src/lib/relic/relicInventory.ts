import { collectRelicInventoryCounts } from "../../../config/shared/relicCounts.js";
import type { RawInventoryData } from "../../types/inventory.js";
import type { OwnedCounts, RelicDatabase, RelicGroup } from "../../types/relics.js";

/** Group for a projection uniqueName of any refinement; null when unknown or
 *  the relic database has not loaded yet. */
export function relicGroupForUniqueName(
  relicDb: RelicDatabase | null,
  uniqueName: string,
): RelicGroup | null {
  const ref = relicDb?.byUniqueName[uniqueName];
  return ref ? (relicDb?.groups[ref.groupKey] ?? null) : null;
}

/** Group for a drop-table label ("Lith A1 Relic", "Lith A1 Relic (Radiant)").
 *  The group key is the bare "<tier> <code>", so the suffix and any refinement
 *  in parentheses are dropped before matching. */
export function relicGroupForDisplayName(
  relicDb: RelicDatabase | null,
  displayName: string,
): RelicGroup | null {
  if (!relicDb) return null;
  const cleaned = String(displayName || "")
    .replace(/\([^()]*\)/g, " ")
    .replace(/\bRelic\b/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;

  const direct = relicDb.groups[cleaned];
  if (direct) return direct;

  const wanted = cleaned.toLowerCase();
  return (
    Object.values(relicDb.groups).find(
      (group) => `${group.tier} ${group.code}`.toLowerCase() === wanted,
    ) ?? null
  );
}

export function parseOwnedRelics(
  inventoryData: RawInventoryData | null,
  relicDb: RelicDatabase | null,
): OwnedCounts {
  const owned: OwnedCounts = {};
  if (!inventoryData || !relicDb) return owned;

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

  const countedByItemType = collectRelicInventoryCounts(
    inventoryData,
    (itemType) => relicDb.byUniqueName[itemType] !== undefined,
  );

  for (const [itemType, count] of countedByItemType) {
    const info = relicDb.byUniqueName[itemType];
    if (!info) continue;
    ensureOwnedSlot(info.groupKey);
    owned[info.groupKey][info.quality] += count;
  }

  return owned;
}
