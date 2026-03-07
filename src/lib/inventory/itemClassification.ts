import type { InventoryGroup, ItemDbEntry, RawInventoryData } from "../../types/inventory.js";

// --- Internal type shared across inventory sub-modules ----------------------

export interface ResolvedItem extends ItemDbEntry {
  name: string;
  imageUrl: string | null;
}

// --- Category / classification constants ------------------------------------

interface CategoryDef {
  key: keyof RawInventoryData;
  cat: string;
  label: string;
}

export const CATEGORIES: CategoryDef[] = [
  { key: "Suits", cat: "warframes", label: "Warframe" },
  { key: "LongGuns", cat: "primary", label: "Primary" },
  { key: "Pistols", cat: "secondary", label: "Secondary" },
  { key: "Melee", cat: "melee", label: "Melee" },
  { key: "Sentinels", cat: "companions", label: "Companion" },
  { key: "SentinelWeapons", cat: "companions", label: "Companion" },
  { key: "SpaceSuits", cat: "archwing", label: "Archwing" },
  { key: "SpaceGuns", cat: "archwing", label: "Archwing" },
  { key: "SpaceMelee", cat: "archwing", label: "Archwing" },
  { key: "OperatorAmps", cat: "amps", label: "Amp" },
  { key: "MechSuits", cat: "necramech", label: "Necramech" },
];

export const PRODUCT_TO_FILTER: Record<string, string> = {
  Suits: "warframes",
  LongGuns: "primary",
  Pistols: "secondary",
  Melee: "melee",
  Sentinels: "companions",
  SentinelWeapons: "companions",
  SpaceSuits: "archwing",
  SpaceGuns: "archwing",
  SpaceMelee: "archwing",
  OperatorAmps: "amps",
  MechSuits: "necramech",
};

export const EQUIPMENT_COLLECTION_KEYS = new Set(CATEGORIES.map((entry) => String(entry.key)));

interface SupplementalCollectionDef {
  key: string;
  cat: string;
  label: string;
}

export const SUPPLEMENTAL_COLLECTIONS: SupplementalCollectionDef[] = [
  { key: "MiscItems", cat: "misc", label: "Misc" },
  { key: "FusionTreasures", cat: "misc", label: "Misc" },
  { key: "Recipes", cat: "misc", label: "Recipe" },
  { key: "LevelKeys", cat: "relics", label: "Relic" },
  { key: "RawUpgrades", cat: "misc", label: "Misc" },
  { key: "Upgrades", cat: "mods", label: "Mod" },
  { key: "Arcanes", cat: "arcanes", label: "Arcane" },
];

export const GROUP_PRIORITY: Record<InventoryGroup, number> = {
  misc: 1,
  all_parts: 2,
  arcanes: 3,
  mods: 4,
  relics: 5,
  full_sets: 6,
};

// --- Item resolution --------------------------------------------------------

export function resolveItem(
  internalName: string,
  itemDb: Record<string, ItemDbEntry>,
): ResolvedItem {
  const dbEntry = itemDb[internalName];
  if (dbEntry?.name) {
    return {
      ...dbEntry,
      name: dbEntry.name,
      imageUrl: dbEntry.imageUrl ?? null,
    };
  }
  if (!internalName) return { name: "Unknown", imageUrl: null };

  const segments = internalName.split("/");
  let name = segments[segments.length - 1] || "Unknown";
  name = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return { name, imageUrl: null, category: "Unknown" };
}

// --- Classification predicates ----------------------------------------------

export function isArcaneUpgrade(
  internalName: string,
  dbEntry: ItemDbEntry = {},
  resolved: ResolvedItem,
): boolean {
  if (/\/Arcanes?\//i.test(internalName)) return true;
  if (/\/CosmeticEnhancers?\//i.test(internalName)) return true;

  const category = String(dbEntry.category || "").toLowerCase();
  const type = String(dbEntry.type || "").toLowerCase();
  const name = String(resolved.name || "").toLowerCase();

  if (category.includes("arcane")) return true;
  if (type.includes("arcane")) return true;
  if (name.startsWith("arcane ")) return true;

  return false;
}

export function isFocusUpgrade(
  internalName: string,
  dbEntry: ItemDbEntry = {},
  resolved: ResolvedItem,
): boolean {
  if (/\/Upgrades\/Focus\//i.test(internalName)) return true;

  const category = String(dbEntry.category || "").toLowerCase();
  const type = String(dbEntry.type || "").toLowerCase();
  const name = String(resolved.name || "").toLowerCase();

  if (type.includes("focus way")) return true;
  if (category.includes("focus")) return true;
  if (name.includes("waybound")) return true;

  return false;
}

export function isLikelyModUpgrade(
  internalName: string,
  dbEntry: ItemDbEntry = {},
  resolved: ResolvedItem,
): boolean {
  if (/\/FusionBundles\//i.test(internalName)) return false;

  if (/\/Upgrades\/Mods\//i.test(internalName)) return true;
  if (/\/Mods\//i.test(internalName)) return true;

  const category = String(dbEntry.category || "").toLowerCase();
  const type = String(dbEntry.type || "").toLowerCase();
  const name = String(resolved.name || "").toLowerCase();

  if (category.includes("resource") || category.includes("fusion")) return false;
  if (type.includes("resource") || type.includes("fusion")) return false;

  if (category.includes("mod")) return true;
  if (type.includes(" mod") || type.endsWith("mod") || type.includes("augment")) return true;
  if (/\bmod\b/.test(name)) return true;

  return false;
}

export function isRelicLikeItem(
  internalName: string,
  dbEntry: ItemDbEntry = {},
  resolved?: ResolvedItem,
): boolean {
  if (/\/Relics?\//i.test(internalName)) return true;
  if (/VoidProjection/i.test(internalName)) return true;

  const category = String(dbEntry.category || "").toLowerCase();
  const type = String(dbEntry.type || "").toLowerCase();
  const name = String(resolved?.name || dbEntry.name || "").toLowerCase();

  if (category.includes("relic")) return true;
  if (type.includes("relic")) return true;
  if (/\brelic\b/.test(name)) return true;

  return false;
}

export function isSceneLikeItem(
  internalName: string,
  dbEntry: ItemDbEntry = {},
  resolved?: ResolvedItem,
): boolean {
  if (/\/PhotoBooth\//i.test(internalName)) return true;

  const type = String(dbEntry.type || "").toLowerCase();
  const name = String(resolved?.name || dbEntry.name || "").toLowerCase();

  if (type.includes("captura") || type.includes("scene")) return true;
  if (name.endsWith(" scene")) return true;

  return false;
}

export function isAyatanLikeItem(
  internalName: string,
  dbEntry: ItemDbEntry = {},
  resolved?: ResolvedItem,
): boolean {
  if (/\/FusionTreasures\//i.test(internalName)) return true;

  const type = String(dbEntry.type || "").toLowerCase();
  const name = String(resolved?.name || dbEntry.name || "").toLowerCase();

  if (type.includes("ayatan") || type.includes("star") || type.includes("sculpture")) return true;
  if (name.includes("ayatan") || name.includes("amber star") || name.includes("cyan star")) {
    return true;
  }

  return false;
}

export function isBuildPartItem(
  internalName: string,
  dbEntry: ItemDbEntry = {},
  resolved: ResolvedItem,
): boolean {
  if (isSceneLikeItem(internalName, dbEntry, resolved)) return false;
  if (isAyatanLikeItem(internalName, dbEntry, resolved)) return false;
  if (isRelicLikeItem(internalName, dbEntry, resolved)) return false;

  if (/\/Types\/Keys\//i.test(internalName)) return false;

  const type = String(dbEntry.type || "").toLowerCase();
  const category = String(dbEntry.category || "").toLowerCase();
  const name = String(resolved.name || "").toLowerCase();

  if (
    type.includes("resource") ||
    type.includes("booster") ||
    type.includes("key") ||
    type.includes("fish") ||
    type.includes("captura") ||
    type.includes("ayatan")
  ) {
    return false;
  }

  if (category.includes("fish") || category.includes("captura")) {
    return false;
  }

  // If a data source explicitly marks this as non-tradable, never include it
  // as a build part regardless of name heuristics.
  if (dbEntry.tradable === false) return false;

  const pathLooksLikePart =
    /\/Types\/Recipes\//i.test(internalName) ||
    /\/WeaponParts?\//i.test(internalName) ||
    /\/WarframeParts?\//i.test(internalName) ||
    /\/LandingCraftRecipes\//i.test(internalName);

  const weaponPartRecipePath = /\/Types\/Recipes\/Weapons\/WeaponParts?\//i.test(internalName);

  const nameLooksLikePart =
    /\b(blueprint|barrel|receiver|stock|blade|handle|hilt|chassis|systems|neuroptics|fuselage|engines|avionics|carapace|cerebrum|pod|wings|harness|link|disc|gauntlet|grip|ornament)\b/i.test(
      name,
    );

  const flaggedBuildComponent = dbEntry.isBuildComponent === true;
  if (!pathLooksLikePart && !nameLooksLikePart && !flaggedBuildComponent) return false;

  const primeLike =
    resolved.isPrime === true || /\bprime\b/i.test(name) || /prime/i.test(internalName);
  const tradableLikely =
    dbEntry.tradable === true ||
    (primeLike && pathLooksLikePart && nameLooksLikePart) ||
    (weaponPartRecipePath && nameLooksLikePart);

  return tradableLikely;
}

export function canonicalBuildPartName(internalName: string, name: string): string {
  if (
    /\/Types\/Recipes\/WarframeRecipes\//i.test(internalName) &&
    /\bHelmet Blueprint$/i.test(name)
  ) {
    return name.replace(/\bHelmet Blueprint$/i, "Neuroptics Blueprint");
  }

  return name;
}

// --- Visibility / group inference -------------------------------------------

export function shouldHide(
  internalName: string,
  dbEntry: ItemDbEntry = {},
  resolved: ResolvedItem,
): boolean {
  if (/\/Upgrades\/Focus\//i.test(internalName)) return true;
  if (/\/Types\/Boosters?\//i.test(internalName)) return true;
  if (/\/Types\/Keys\//i.test(internalName) && !isRelicLikeItem(internalName, dbEntry, resolved)) {
    return true;
  }

  if (dbEntry.exalted === true) return true;
  if (dbEntry.productCategory === "SpecialItems") return true;
  if (typeof dbEntry.type === "string" && /exalted/i.test(dbEntry.type)) {
    return true;
  }
  if (
    /^(Exalted Blade|Regulators(?: Prime)?|Iron Staff(?: Prime)?|Dex Pixia(?: Prime)?|Artemis Bow(?: Prime)?|Desert Wind(?: Prime)?)$/i.test(
      resolved.name,
    )
  ) {
    return true;
  }
  if (/\/ExaltedWeapons?\//.test(internalName)) return true;
  if (/\/SpecialItems\//.test(internalName)) return true;
  return false;
}

export function inferCategory(
  internalName: string,
  defaultCat: string,
  dbEntry: ItemDbEntry = {},
): string {
  if (/\/OperatorAmplifiers?\//i.test(internalName)) return "amps";
  if (typeof dbEntry.productCategory === "string" && PRODUCT_TO_FILTER[dbEntry.productCategory]) {
    return PRODUCT_TO_FILTER[dbEntry.productCategory];
  }
  return defaultCat;
}

export function deriveGroup(
  sourceKey: string,
  internalName: string,
  dbEntry: ItemDbEntry,
  resolved: ResolvedItem,
): InventoryGroup {
  const category = String(dbEntry.category || "").toLowerCase();
  const type = String(dbEntry.type || "").toLowerCase();
  const hasArcaneWord = (value: string): boolean => /\barcane\b/.test(value);
  const hasModWord = (value: string): boolean => /\bmods?\b/.test(value);

  if (isFocusUpgrade(internalName, dbEntry, resolved)) return "misc";

  if (EQUIPMENT_COLLECTION_KEYS.has(sourceKey)) return "misc";

  if (sourceKey === "LevelKeys") {
    return isRelicLikeItem(internalName, dbEntry, resolved) ? "relics" : "misc";
  }

  if (sourceKey === "Arcanes") return "arcanes";
  if (sourceKey === "Upgrades" || sourceKey === "RawUpgrades") {
    if (isArcaneUpgrade(internalName, dbEntry, resolved)) return "arcanes";
    return isLikelyModUpgrade(internalName, dbEntry, resolved) ? "mods" : "misc";
  }

  if (isRelicLikeItem(internalName, dbEntry, resolved)) return "relics";
  if (isArcaneUpgrade(internalName, dbEntry, resolved)) return "arcanes";

  if (hasArcaneWord(category)) return "arcanes";
  if (hasModWord(category)) return "mods";

  if (hasArcaneWord(type)) return "arcanes";
  if (hasModWord(type)) return "mods";

  if (isBuildPartItem(internalName, dbEntry, resolved)) return "all_parts";

  return "misc";
}
