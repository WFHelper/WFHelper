export interface InventoryItemWithType {
  ItemType?: unknown;
  ItemCount?: unknown;
}

function addOwnedCount(owned: Map<string, number>, entry: InventoryItemWithType, fallbackCount: number): void {
  const itemType = typeof entry.ItemType === "string" ? entry.ItemType : "";
  if (!itemType) return;
  const count = typeof entry.ItemCount === "number" && Number.isFinite(entry.ItemCount)
    ? entry.ItemCount
    : fallbackCount;
  owned.set(itemType, (owned.get(itemType) || 0) + (count || fallbackCount));
}

export function aggregateComponentOwnership(
  miscItems: unknown,
  recipes: unknown,
  pendingRecipes: unknown,
): Map<string, number> {
  const owned = new Map<string, number>();
  for (const slice of [miscItems, recipes]) {
    if (!Array.isArray(slice)) continue;
    for (const entry of slice) {
      if (entry && typeof entry === "object") {
        addOwnedCount(owned, entry as InventoryItemWithType, 1);
      }
    }
  }
  if (Array.isArray(pendingRecipes)) {
    for (const entry of pendingRecipes) {
      if (entry && typeof entry === "object") {
        addOwnedCount(owned, entry as InventoryItemWithType, 1);
      }
    }
  }
  return owned;
}
