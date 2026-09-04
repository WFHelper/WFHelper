import { isInfestedMechPart } from "../../../config/shared/componentNames.js";
import { isRankedGroup } from "../../../config/shared/numeric.js";
import {
  fallbackNameFromUniqueName,
  sanitizeDisplayName,
} from "../../../config/shared/displayName.js";
import type {
  InventoryGroup,
  ItemDbEntry,
  RawInventoryData,
  RawInventoryEntry,
} from "../../types/inventory.js";

export interface ResolvedItem extends ItemDbEntry {
  name: string;
  imageUrl: string | null;
}

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

const PRODUCT_TO_FILTER: Record<string, string> = {
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

const EQUIPMENT_COLLECTION_KEYS = new Set(CATEGORIES.map((entry) => String(entry.key)));

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

export function resolveItem(
  internalName: string,
  itemDb: Record<string, ItemDbEntry>,
): ResolvedItem {
  const dbEntry = itemDb[internalName];
  if (dbEntry?.name) {
    const name = sanitizeDisplayName(dbEntry.name);
    return {
      ...dbEntry,
      name,
      imageUrl: dbEntry.imageUrl ?? null,
    };
  }
  if (!internalName) return { name: "Unknown", imageUrl: null };

  return { name: fallbackNameFromUniqueName(internalName), imageUrl: null, category: "Unknown" };
}

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
  if (/photobooth/i.test(internalName)) return true;

  const type = String(dbEntry.type || "").toLowerCase();
  const name = String(resolved?.name || dbEntry.name || "").toLowerCase();

  if (type.includes("captura") || type.includes("scene")) return true;
  if (name.endsWith(" scene")) return true;

  return false;
}

export function isAuxiliaryInventoryItem(
  internalName: string,
  dbEntry: ItemDbEntry = {},
  resolved?: ResolvedItem,
): boolean {
  if (isSceneLikeItem(internalName, dbEntry, resolved)) return true;
  if (/\/Types\/Items\/ShipFeatureItems\//i.test(internalName)) return true;
  if (/\/Types\/Items\/SongItems\//i.test(internalName)) return true;
  if (/\/Types\/Keys\/.*Quest/i.test(internalName)) return true;
  if (/QuestKeyChain/i.test(internalName)) return true;

  const category = String(dbEntry.category || "").toLowerCase();
  const type = String(dbEntry.type || "").toLowerCase();

  if (category.includes("quest") || type.includes("quest")) return true;
  if (type.includes("song") || type.includes("fragment")) return true;

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

function hasBuildPartPath(internalName: string): boolean {
  return (
    /\/Types\/Recipes\//i.test(internalName) ||
    /\/WeaponParts?\//i.test(internalName) ||
    /\/WarframeParts?\//i.test(internalName) ||
    /\/LandingCraftRecipes\//i.test(internalName) ||
    isInfestedMechPart(internalName)
  );
}

function hasBuildPartName(name: string): boolean {
  return /\b(blueprint|barrel|receiver|stock|blade|handle|hilt|chassis|systems|neuroptics|fuselage|engines|avionics|carapace|cerebrum|pod|wings|harness|link|disc|gauntlet|grip|ornament|rivet)\b/i.test(
    name,
  );
}

export function isResourceItem(
  internalName: string,
  dbEntry: ItemDbEntry = {},
  resolved?: ResolvedItem,
): boolean {
  if (isAuxiliaryInventoryItem(internalName, dbEntry, resolved)) return false;
  if (isAyatanLikeItem(internalName, dbEntry, resolved)) return false;
  if (isRelicLikeItem(internalName, dbEntry, resolved)) return false;

  const name = String(resolved?.name || dbEntry.name || "").toLowerCase();
  if (hasBuildPartPath(internalName) || hasBuildPartName(name)) return false;

  const category = String(dbEntry.category || "").toLowerCase();
  const type = String(dbEntry.type || "").toLowerCase();

  if (category.includes("resource")) return true;
  if (type.includes("resource")) return true;

  // Legacy/test data can have classic resource paths without category metadata.
  return /^\/Lotus\/Types\/Items\/(?!MiscItems\/)[^/]+$/i.test(internalName);
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
    (!isInfestedMechPart(internalName) && type.includes("resource")) ||
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

  const pathLooksLikePart = hasBuildPartPath(internalName);

  const weaponPartRecipePath = /\/Types\/Recipes\/Weapons\/WeaponParts?\//i.test(internalName);

  const nameLooksLikePart = hasBuildPartName(name);

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
  let result = name;
  // DE keeps the crafted part under ...Component beside the tradable ...Blueprint
  // recipe, but the item DB names the Component entry after the blueprint players
  // trade (WFCD keys the blueprint under the Component path). The raw Component
  // row is the crafted part, so keeping the suffix would mislabel it.
  if (/\/Types\/Recipes\/\S*Component$/i.test(internalName)) {
    result = result.replace(/\s+Blueprint$/i, "");
  }
  if (/\/Types\/Recipes\/WarframeRecipes\//i.test(internalName)) {
    result = result.replace(/\bHelmet(?= Blueprint$|$)/i, "Neuroptics");
  }
  return result;
}

/** warframe.market listing a key by game reference is the only signal that it is
 *  tradable stock; the item database flags every Types/Keys path quest-only. */
export function isMarketListedMissionKey(internalName: string, marketListed: boolean): boolean {
  return marketListed && /\/Types\/Keys\//i.test(internalName);
}

/** A mod or arcane the catalog lists under its own game reference is tradable.
 *  The bundled item data has no entry at all for a freshly added one and calls
 *  158 listed mods untradable outright, so the listing is the better authority.
 *  Sets are never a ranked group, so an assembled Warframe stays out. */
export function isCatalogListedRankedItem(
  group: string | null | undefined,
  marketListed: boolean,
): boolean {
  return marketListed && isRankedGroup(group);
}

export function shouldHide(
  internalName: string,
  dbEntry: ItemDbEntry = {},
  resolved: ResolvedItem,
  marketListed = false,
): boolean {
  if (isMarketListedMissionKey(internalName, marketListed)) return false;

  if (isAuxiliaryInventoryItem(internalName, dbEntry, resolved)) return true;
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

const WEAPON_SLOT_FILTERS = new Set(["primary", "secondary", "melee"]);

// DE exports every modular part with productCategory "Pistols" (amp prisms,
// kitgun chambers, zaw strikes, K-Drive decks, Moa heads), so any bucket that
// trusts productCategory files them under Secondary. Kitgun and zaw paths carry
// no "kitguns"/"zaws" segment, only the SUModular/InfKitGun/ModularMelee ones.
export const MODULAR_PART_PATH =
  /\/(?:kdrives|zaws|kitguns|hoverboard|moapets|operatoramplifiers?)\/|\/(?:infkitgun|modularmelee|sumodular)[a-z0-9]*\//i;

// Pet and sentinel parts hit the same "Pistols" export trap. Kept apart from the
// modular family because classifyForFoundry answers Companion here and Modular
// there; inferCategory only cares that either one matched.
export const PET_PART_PATH =
  /\/(?:pets|zanukapets|creaturepets|catbrowpets|kubrowpets|sentinels)\//i;

export function inferCategory(
  internalName: string,
  defaultCat: string,
  dbEntry: ItemDbEntry = {},
): string {
  if (/\/OperatorAmplifiers?\//i.test(internalName)) return "amps";
  const mapped =
    typeof dbEntry.productCategory === "string"
      ? PRODUCT_TO_FILTER[dbEntry.productCategory]
      : undefined;
  if (!mapped) return defaultCat;
  if (
    WEAPON_SLOT_FILTERS.has(mapped) &&
    (MODULAR_PART_PATH.test(internalName) || PET_PART_PATH.test(internalName))
  ) {
    return defaultCat;
  }
  return mapped;
}

interface ModularBuild {
  /** English display name, taken from the part that defines the build. */
  name: string;
  /** Active game language, absent when the naming part has no localized name. */
  displayName?: string;
  category: string;
  categoryLabel: string;
  /** The defining part's icon; a build of its own has none to show. */
  imageUrl: string | null;
  /** Every fitted part, resolved for display. */
  partNames: string[];
}

interface ModularKind {
  cat: string;
  label: string;
  /** Part the build is named after: chamber, strike, prism, deck, model head. */
  definingPart: RegExp | null;
}

const MODULAR_KINDS: Record<string, ModularKind> = {
  LongGuns: { cat: "primary", label: "Kitgun", definingPart: /\/Barrels?\//i },
  Pistols: { cat: "secondary", label: "Kitgun", definingPart: /\/Barrels?\//i },
  Melee: { cat: "melee", label: "Zaw", definingPart: /\/Tips?\//i },
  OperatorAmps: { cat: "amps", label: "Amp", definingPart: /\/Barrel\//i },
  // K-Drives have no filter chip of their own; Misc is where their parts sit.
  Hoverboards: { cat: "misc", label: "K-Drive", definingPart: /Deck$/i },
  MoaPets: { cat: "companions", label: "Moa", definingPart: /MoaPetHead/i },
  KubrowPets: { cat: "companions", label: "Companion", definingPart: null },
};

// MoaPets stores Hounds too, and their model part is the Zanuka head.
const HOUND_KIND: ModularKind = {
  cat: "companions",
  label: "Hound",
  definingPart: /ZanukaPetPartHead/i,
};

/** Hatched Kubrows, Kavats and Deimos pets all live here. */
export const PET_COLLECTION_KEY = "KubrowPets";

/** Modular collections DE keeps outside CATEGORIES, so parseInventory walks
 *  them separately and takes only the builds they hold. */
export const MODULAR_COLLECTION_KEYS = ["Hoverboards", "MoaPets", PET_COLLECTION_KEY];

// Everything in these two is a build; elsewhere ModularParts is what tells a
// build apart from a normal weapon or a plain kubrow.
const ALWAYS_MODULAR_COLLECTIONS = new Set(["Hoverboards", "MoaPets"]);

function modularPartList(entry: RawInventoryEntry): string[] {
  const raw = (entry as { ModularParts?: unknown }).ModularParts;
  if (!Array.isArray(raw)) return [];
  return raw.filter((part): part is string => typeof part === "string" && part.length > 0);
}

/** A built kitgun/zaw/amp/K-Drive/Moa: DE stores it under a generic ItemType
 *  with the fitted parts in ModularParts, so the name has to come from a part. */
export function resolveModularBuild(
  sourceKey: string,
  entry: RawInventoryEntry,
  internalName: string,
  itemDb: Record<string, ItemDbEntry>,
): ModularBuild | null {
  const kind =
    sourceKey === "MoaPets" && /\/ZanukaPets\//i.test(internalName)
      ? HOUND_KIND
      : MODULAR_KINDS[sourceKey];
  if (!kind) return null;

  const parts = modularPartList(entry);
  if (parts.length === 0 && !ALWAYS_MODULAR_COLLECTIONS.has(sourceKey)) return null;

  const pattern = kind.definingPart;
  const defining = pattern ? parts.find((part) => pattern.test(part)) : undefined;
  const definingEntry = itemDb[defining ?? ""];
  const baseEntry = itemDb[internalName];
  // name and displayName must come from the SAME entry. Inheriting the base
  // item's localized name would render the generic weapon (a plain "Kitgun") in
  // every non-English client while `name` already says the fitted part.
  const naming = definingEntry?.name ? definingEntry : baseEntry?.name ? baseEntry : null;
  const name = naming?.name || kind.label;
  const localized = naming?.displayName;

  return {
    name: sanitizeDisplayName(name),
    ...(localized ? { displayName: sanitizeDisplayName(localized) } : {}),
    category: kind.cat,
    categoryLabel: kind.label,
    imageUrl: definingEntry?.imageUrl ?? baseEntry?.imageUrl ?? null,
    partNames: parts.map((part) =>
      sanitizeDisplayName(itemDb[part]?.name || fallbackNameFromUniqueName(part)),
    ),
  };
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

  // KubrowPets sits outside CATEGORIES because it mixes plain pets with modular
  // Deimos ones, but both are companions the player equips.
  if (EQUIPMENT_COLLECTION_KEYS.has(sourceKey) || sourceKey === PET_COLLECTION_KEY) {
    return "equipment";
  }

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
