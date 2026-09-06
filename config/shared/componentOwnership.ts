interface InventoryItemWithType {
  ItemType?: unknown;
  ItemCount?: unknown;
}

const DEFAULT_OWNED_COUNT = 1;

/** Stacked slices carry a count; built gear is one row per copy. */
const STACKED_COLLECTIONS = ["MiscItems", "Recipes"] as const;

/** Built gear lives in its own collection, and a built weapon or frame can be a
 *  recipe ingredient - Aklex Prime consumes two built Lex Primes. Reading only
 *  the stacked slices reports gear the player is holding as missing. */
const BUILT_GEAR_COLLECTIONS = [
  "Suits",
  "LongGuns",
  "Pistols",
  "Melee",
  "SpecialItems",
  "SentinelWeapons",
  "Sentinels",
  "SpaceGuns",
  "SpaceMelee",
  "SpaceSuits",
  "MechSuits",
  "Hoverboards",
  "OperatorAmps",
  "KubrowPets",
  "MoaPets",
] as const;

function entryItemType(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const value = (entry as InventoryItemWithType).ItemType;
  return typeof value === "string" ? value : "";
}

function addOwned(owned: Map<string, number>, itemType: string, count: number): void {
  owned.set(itemType, (owned.get(itemType) || 0) + count);
}

/** Owned copies per uniqueName. Pass an inventory that already went through
 *  withoutFoundryPending, so Recipes excludes blueprints the foundry spent. */
export function aggregateComponentOwnership(inventory: unknown): Map<string, number> {
  const owned = new Map<string, number>();
  const slices = (inventory ?? {}) as Record<string, unknown>;

  for (const key of STACKED_COLLECTIONS) {
    const slice = slices[key];
    if (!Array.isArray(slice)) continue;
    for (const entry of slice) {
      const itemType = entryItemType(entry);
      if (!itemType) continue;
      const raw = (entry as InventoryItemWithType).ItemCount;
      const count = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_OWNED_COUNT;
      addOwned(owned, itemType, count);
    }
  }

  for (const key of BUILT_GEAR_COLLECTIONS) {
    const slice = slices[key];
    if (!Array.isArray(slice)) continue;
    for (const entry of slice) {
      const itemType = entryItemType(entry);
      // One row is one copy here; an ItemCount on built gear is not a stack.
      if (itemType) addOwned(owned, itemType, 1);
    }
  }

  return owned;
}
