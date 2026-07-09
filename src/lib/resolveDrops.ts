import type { DropInfo } from "../types/inventory.js";

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
