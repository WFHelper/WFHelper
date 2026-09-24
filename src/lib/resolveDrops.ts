import { ownedRelicQualities, relicGroupForDisplayName } from "./relic/relicInventory.js";
import type { DropInfo } from "../types/inventory.js";
import type { OwnedCounts, RelicDatabase } from "../types/relics.js";

interface DropsSource {
  drops?: DropInfo[];
  uniqueName?: string;
}

/** Drop sources for an item/component; itemDb fallback when its own drops are empty. */
export function resolveDrops(
  item: DropsSource | null | undefined,
  itemDb: Record<string, { drops?: DropInfo[] }>,
): DropInfo[] {
  if (!item) return [];
  if (item.drops && item.drops.length > 0) return item.drops;
  if (item.uniqueName) {
    const dbEntry = itemDb[item.uniqueName];
    if (dbEntry?.drops && dbEntry.drops.length > 0) return dbEntry.drops;
  }
  return [];
}

/** Relics the player holds in any refinement move to the front; both parts keep their order. */
export function ownedRelicDropsFirst(
  drops: readonly DropInfo[],
  relicDb: RelicDatabase | null,
  ownedCounts: OwnedCounts,
): DropInfo[] {
  const owned: DropInfo[] = [];
  const rest: DropInfo[] = [];
  for (const drop of drops) {
    const group = relicGroupForDisplayName(relicDb, drop.location);
    const held = group !== null && ownedRelicQualities(ownedCounts, group.key).length > 0;
    (held ? owned : rest).push(drop);
  }
  return [...owned, ...rest];
}
