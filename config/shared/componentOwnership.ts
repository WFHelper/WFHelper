interface InventoryItemWithType {
  ItemType?: unknown;
  ItemCount?: unknown;
}

const DEFAULT_OWNED_COUNT = 1;

function addOwnedCount(owned: Map<string, number>, entry: InventoryItemWithType): void {
  const itemType = typeof entry.ItemType === "string" ? entry.ItemType : "";
  if (!itemType) return;
  const count = typeof entry.ItemCount === "number" && Number.isFinite(entry.ItemCount)
    ? entry.ItemCount
    : DEFAULT_OWNED_COUNT;
  owned.set(itemType, (owned.get(itemType) || 0) + count);
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
        addOwnedCount(owned, entry as InventoryItemWithType);
      }
    }
  }
  if (Array.isArray(pendingRecipes)) {
    for (const entry of pendingRecipes) {
      if (entry && typeof entry === "object") {
        addOwnedCount(owned, entry as InventoryItemWithType);
      }
    }
  }
  return owned;
}
