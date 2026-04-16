import type { DropInfo } from "../types/inventory.js";

interface DropsSource {
  drops?: DropInfo[];
  uniqueName?: string;
}

/**
 * Resolve drop sources for an item/component, falling back to itemDb when
 * the item's own drops array is empty.
 */
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
