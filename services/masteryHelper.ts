/**
 * Builds a complete list of all masterable items in the game,
 * then compares against the user's inventory to show owned / missing / mastered.
 */

import * as itemDb from "./itemDatabase";
import type { ComponentEntry } from "./types/gameData";
import { MAX_ITEM_RANK } from "../config/game/constants";
import { aggregateComponentOwnership } from "../config/shared/componentOwnership";
import { sanitizeDisplayName } from "../config/shared/displayName";
import { toFiniteNumber } from "../config/shared/numeric";
import type { MasteryStatus } from "../config/shared/masteryTypes";

const MASTERABLE_DB_CATEGORIES = new Set(["Warframe", "Weapon", "Companion", "Railjack"]);

// productCategory -> display label
const PRODUCT_DISPLAY: Record<string, string> = {
  Suits: "Warframes",
  LongGuns: "Primary",
  Pistols: "Secondary",
  Melee: "Melee",
  Sentinels: "Companions",
  SentinelWeapons: "Companions",
  SpaceSuits: "Archwing",
  SpaceGuns: "Archwing",
  SpaceMelee: "Archwing",
  OperatorAmps: "Amps",
  MechSuits: "Necramech",
  CrewShipWeapons: "Railjack",
};

// Path patterns -> display category (fallback when productCategory is missing)
const PATH_CATEGORY_RULES: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\/OperatorAmps?\//i, category: "Amps" },
  { pattern: /\/OperatorAmplifiers?\//i, category: "Amps" },
  { pattern: /\/Sentinels\/.*Weapons?\//i, category: "Companions" },
  { pattern: /\/Sentinels?\//i, category: "Companions" },
  { pattern: /\/Pets?\//i, category: "Companions" },
  { pattern: /\/SpaceSuits?\//i, category: "Archwing" },
  { pattern: /\/SpaceGuns?\//i, category: "Archwing" },
  { pattern: /\/SpaceMelee\//i, category: "Archwing" },
  { pattern: /\/MechSuits?\//i, category: "Necramech" },
  { pattern: /\/CrewShip.*Weapons?\//i, category: "Railjack" },
  { pattern: /\/Suits\//i, category: "Warframes" },
  { pattern: /\/ModularMelee\b|\/Ostron.*Melee|\/Zaw/i, category: "Melee" },
  {
    pattern: /\/ModularPistol|\/SolarisUnited.*Secondary|\/Kitgun.*Pistol/i,
    category: "Secondary",
  },
  { pattern: /\/ModularPrimary|\/SolarisUnited.*Primary|\/Kitgun.*Rifle/i, category: "Primary" },
  { pattern: /\/LongGuns\//i, category: "Primary" },
  { pattern: /\/Pistols\//i, category: "Secondary" },
  { pattern: /\/Melee\//i, category: "Melee" },
];

const KEYWORD_RULES: Array<{ pattern: RegExp; keywords: string[] }> = [
  { pattern: /\/ModularMelee\b|\/Ostron.*Melee|\/InfZaw|\/Zaw/i, keywords: ["zaw", "modular"] },
  {
    pattern: /\/ModularPistol|\/ModularPrimary|\/SolarisUnited.*(?:Secondary|Primary)|\/Kitgun/i,
    keywords: ["kitgun", "modular"],
  },
  { pattern: /\/OperatorAmps?\//i, keywords: ["amp", "operator"] },
  { pattern: /\/OperatorAmplifiers?\//i, keywords: ["amp", "operator"] },
  { pattern: /\/Hoverboard\//i, keywords: ["k-drive", "kdrive", "hoverboard"] },
  { pattern: /\/MechSuits?\//i, keywords: ["necramech", "mech"] },
  { pattern: /\/Archwing|\/SpaceSuits?\//i, keywords: ["archwing"] },
  { pattern: /\/SpaceGuns?\//i, keywords: ["archgun", "arch-gun"] },
  { pattern: /\/SpaceMelee\//i, keywords: ["archmelee", "arch-melee"] },
  { pattern: /\/CrewShip/i, keywords: ["railjack"] },
  { pattern: /\/Sentinels?\//i, keywords: ["sentinel", "companion"] },
  { pattern: /\/Pets?\//i, keywords: ["companion", "pet"] },
  { pattern: /Prime/i, keywords: ["prime"] },
  { pattern: /Wraith/i, keywords: ["wraith"] },
  { pattern: /Vandal/i, keywords: ["vandal"] },
  { pattern: /Prisma/i, keywords: ["prisma"] },
  { pattern: /Kuva/i, keywords: ["kuva", "lich"] },
  { pattern: /Tenet/i, keywords: ["tenet", "sister"] },
  { pattern: /Incarnon/i, keywords: ["incarnon"] },
];

function getKeywords(uniqueName: string, itemName: string): string[] {
  const tags = new Set<string>();
  for (const { pattern, keywords } of KEYWORD_RULES) {
    if (pattern.test(uniqueName) || pattern.test(itemName)) {
      for (const kw of keywords) tags.add(kw);
    }
  }
  return [...tags];
}

// Hard-coded exalted weapon names to exclude even if not flagged
const EXALTED_NAMES = new Set([
  "regulators",
  "regulators prime",
  "iron staff",
  "iron staff prime",
  "exalted blade",
  "exalted blade prime",
  "dex pixia",
  "dex pixia prime",
  "diwata",
  "diwata prime",
  "artemis bow",
  "artemis bow prime",
  "valkyr talons",
  "valkyr talons prime",
  "desert wind",
  "desert wind prime",
  "shattered lash",
]);

// Inventory JSON key -> maxRank
const INV_CATEGORIES: Record<string, number> = {
  Suits: MAX_ITEM_RANK,
  LongGuns: MAX_ITEM_RANK,
  Pistols: MAX_ITEM_RANK,
  Melee: MAX_ITEM_RANK,
  Sentinels: MAX_ITEM_RANK,
  SentinelWeapons: MAX_ITEM_RANK,
  SpaceSuits: MAX_ITEM_RANK,
  SpaceGuns: MAX_ITEM_RANK,
  SpaceMelee: MAX_ITEM_RANK,
  OperatorAmps: MAX_ITEM_RANK,
  MechSuits: MAX_ITEM_RANK,
  KubrowPets: MAX_ITEM_RANK,
  MoaPets: MAX_ITEM_RANK,
  Hoverboards: MAX_ITEM_RANK,
};

const VENARI_UNIQUE_NAME_PATTERN = /\/Powersuits\/Khora\/Kavat\/Khora(?:Prime)?KavatPowerSuit$/i;
const WEAPON_AFFINITY_PER_RANK_SQUARED = 500;
const SUIT_AFFINITY_PER_RANK_SQUARED = 1_000;
const SUIT_INVENTORY_KEYS = new Set([
  "Suits",
  "Sentinels",
  "SpaceSuits",
  "MechSuits",
  "KubrowPets",
  "MoaPets",
  "Hoverboards",
]);
const MASTERED_FLAG_KEYS = [
  "Mastered",
  "mastered",
  "IsMastered",
  "isMastered",
  "Completed",
  "completed",
  "IsComplete",
  "isComplete",
];

const SYNTHETIC_MASTERABLE_ITEMS: MasterableItem[] = [
  {
    name: "Mote Amp",
    uniqueName:
      "/Lotus/Weapons/Sentients/OperatorAmplifiers/SentTrainingAmplifier/OperatorTrainingAmpWeapon",
    category: "Amps",
    imageUrl: null,
    isPrime: false,
    masteryReq: 0,
    vaulted: false,
    tradable: false,
    keywords: ["amp", "operator"],
    debugReason: "show:synthetic; cat:profile-amp; dbCat:?; product:OperatorAmps; type:Amp",
    components: [],
  },
  {
    name: "Plexus",
    uniqueName: "/Lotus/Types/Game/CrewShip/RailjackHarness",
    category: "Companions",
    imageUrl: null,
    isPrime: false,
    masteryReq: 0,
    vaulted: false,
    tradable: false,
    keywords: ["plexus", "railjack"],
    debugReason: "show:synthetic; cat:profile-companions; dbCat:?; product:CrewShip; type:Plexus",
    components: [],
  },
];

const MASTERABLE_UNIQUE_NAME_ALIASES: Record<string, string[]> = {
  "/Lotus/Types/Game/CrewShip/RailjackHarness": [
    "/Lotus/Types/Game/CrewShip/RailJack/DefaultHarness",
  ],
  "/Lotus/Weapons/Tenno/Bayonet/TnBayonetRifleWeapon": [
    "/Lotus/Weapons/Tenno/Bayonet/TnBayonetMeleeWeapon",
  ],
  "/Lotus/Weapons/Tenno/Bayonet/TnBayonetMeleeWeapon": [
    "/Lotus/Weapons/Tenno/Bayonet/TnBayonetRifleWeapon",
  ],
};

function xpToRank(
  xp: number,
  maxRank: number = MAX_ITEM_RANK,
  affinityPerRankSquared: number = WEAPON_AFFINITY_PER_RANK_SQUARED,
): number {
  if (!xp || xp <= 0) return 0;
  return Math.min(maxRank, Math.floor(Math.sqrt(xp / affinityPerRankSquared)));
}

function pickBoolean(obj: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const lower = value.trim().toLowerCase();
      if (lower === "true" || lower === "yes" || lower === "1") return true;
      if (lower === "false" || lower === "no" || lower === "0") return false;
    }
  }
  return null;
}

function extractMasteredFlag(entry: Record<string, unknown>): boolean | null {
  return pickBoolean(entry, MASTERED_FLAG_KEYS);
}

function getMasteryMaxRank(itemType: string, fallbackMaxRank: number): number {
  const dbItem = itemDb.lookupItem(itemType);
  const name = (dbItem?.name || "").toLowerCase();
  const path = itemType.toLowerCase();

  if (
    fallbackMaxRank > MAX_ITEM_RANK ||
    /(?:^|[\s/])kuva(?:[\s/]|$)/i.test(`${itemType} ${dbItem?.name || ""}`) ||
    /(?:^|[\s/])tenet(?:[\s/]|$)/i.test(`${itemType} ${dbItem?.name || ""}`) ||
    /(?:^|[\s/])coda(?:[\s/]|$)/i.test(`${itemType} ${dbItem?.name || ""}`) ||
    path.includes("infestedlich") ||
    name === "paracesis" ||
    path.includes("ballassword") ||
    path.includes("mechsuits") ||
    path.includes("entrati")
  ) {
    return 40;
  }

  return fallbackMaxRank;
}

function getInventoryAffinityPerRankSquared(invKey: string): number {
  return SUIT_INVENTORY_KEYS.has(invKey)
    ? SUIT_AFFINITY_PER_RANK_SQUARED
    : WEAPON_AFFINITY_PER_RANK_SQUARED;
}

function getValueAtPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || !(key in cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function pickNumber(obj: Record<string, unknown>, paths: string[][]): number | null {
  for (const p of paths) {
    const v = getValueAtPath(obj, p);
    const n = toFiniteNumber(v);
    if (n != null) return n;
  }
  return null;
}

function extractProfileMastery(
  inventoryData: Record<string, unknown>,
): { rank: number | null; percentToNext: number | null } | null {
  const rank = pickNumber(inventoryData, [
    ["MasteryRank"],
    ["MasteryLevel"],
    ["PlayerLevel"],
    ["PlayerRank"],
    ["LevelInfo", "MasteryRank"],
    ["LevelInfo", "PlayerLevel"],
  ]);

  let percentToNext = pickNumber(inventoryData, [
    ["MasteryPercent"],
    ["MasteryProgressPercent"],
    ["PlayerLevelProgressPercent"],
    ["LevelInfo", "MasteryPercent"],
    ["LevelInfo", "ProgressPercent"],
  ]);

  if (percentToNext == null) {
    const currentXp = pickNumber(inventoryData, [
      ["MasteryXP"],
      ["MasteryXp"],
      ["PlayerXP"],
      ["PlayerXp"],
      ["LevelInfo", "MasteryXP"],
      ["LevelInfo", "CurrentXP"],
    ]);
    const nextXp = pickNumber(inventoryData, [
      ["NextMasteryXP"],
      ["NextLevelXP"],
      ["MasteryXPForNextRank"],
      ["LevelInfo", "NextXP"],
      ["LevelInfo", "NextLevelXP"],
    ]);
    if (currentXp != null && nextXp != null && nextXp > 0) {
      percentToNext = (currentXp / nextXp) * 100;
    }
  }

  if (rank == null && percentToNext == null) return null;
  if (percentToNext != null) {
    percentToNext = Math.max(0, Math.min(100, Number(percentToNext.toFixed(1))));
  }
  return { rank, percentToNext };
}

function getExcludeReason(
  uniqueName: string,
  name: string | null,
  item: { exalted?: boolean; productCategory?: string | null; type?: string },
): string | null {
  if (uniqueName.includes("/Recipes/")) return "recipe";
  if (uniqueName.includes("/StoreItems/")) return "store-item";
  if (uniqueName.includes("/OperatorLoadOuts/")) return "operator-loadout";
  if (uniqueName.includes("/QuestVersions/")) return "quest-version";
  if (uniqueName.includes("/PrototypeVersions/")) return "prototype-version";

  // Exalted weapons (level with parent frame)
  // WFCD can provide exalted as an array on warframes (linked exalted weapons).
  // Exclude only when the item itself is explicitly flagged as exalted.
  if (item && item.exalted === true) return "wfcd-exalted-flag";
  if (
    item &&
    item.productCategory === "SpecialItems" &&
    !VENARI_UNIQUE_NAME_PATTERN.test(uniqueName)
  ) {
    return "specialitems-product-category";
  }
  if (item && typeof item.type === "string" && /exalted/i.test(item.type)) return "type-exalted";
  if (/\/ExaltedWeapons?\//i.test(uniqueName)) return "path-exaltedweapons";
  if (/\/SpecialItems\//i.test(uniqueName)) return "path-specialitems";
  if (name && EXALTED_NAMES.has(name.toLowerCase())) return "name-exalted-list";

  // Cosmetics, skins, decorations
  if (/\/Cosmetics?\//i.test(uniqueName)) return "cosmetic";
  if (/\/Decorations?\//i.test(uniqueName)) return "decoration";

  // NPC / test / debug
  if (/\/NPC\//i.test(uniqueName)) return "npc";
  if (/\/Test\//i.test(uniqueName)) return "test";
  if (/\/Developers?\//i.test(uniqueName)) return "developer";
  if (/\/FixedGun/i.test(uniqueName)) return "fixed-gun";

  // Training amps
  if (/\/SentTrainingAmps?\//i.test(uniqueName)) return "training-amp";
  if (/\/SentTrainingAmplifiers?\//i.test(uniqueName)) return "training-amp";

  // Name-based
  if (name) {
    const n = name.toLowerCase();
    if (n.endsWith(" blueprint") || n.endsWith(" component")) return "name-blueprint-component";
  }

  return null;
}

function resolveDisplayCategoryInfo(
  item: { productCategory?: string | null; category?: string; type?: string },
  uniqueName: string,
): { category: string; source: string } {
  // K-Drive boards are currently exported with Weapon/Pistols metadata.
  // Keep them in a dedicated misc bucket instead of Secondary.
  if (/\/Hoverboard\//i.test(uniqueName) || /k-drive/i.test(String(item.type || ""))) {
    return { category: "Misc", source: "override:k-drive" };
  }

  // Pet companion entries (hounds/moas/etc.) can also arrive as Weapon/Pistols.
  if (/\/Pets?\//i.test(uniqueName) || /\bpets?\b/i.test(String(item.type || ""))) {
    return { category: "Companions", source: "override:pets" };
  }

  // Operator amplifier parts should always be listed under Amps, even when productCategory is Pistols.
  if (/\/OperatorAmplifiers?\//i.test(uniqueName)) {
    return { category: "Amps", source: "path:OperatorAmplifiers" };
  }
  if (item.productCategory && PRODUCT_DISPLAY[item.productCategory as string]) {
    return {
      category: PRODUCT_DISPLAY[item.productCategory as string],
      source: `productCategory:${item.productCategory}`,
    };
  }
  for (const { pattern, category } of PATH_CATEGORY_RULES) {
    if (pattern.test(uniqueName)) return { category, source: `path:${pattern}` };
  }
  if (item.category === "Warframe")
    return { category: "Warframes", source: "db-category:Warframe" };
  if (item.category === "Companion")
    return { category: "Companions", source: "db-category:Companion" };
  if (item.category === "Railjack") return { category: "Railjack", source: "db-category:Railjack" };
  return { category: "Other", source: "fallback:Other" };
}

function isAmpPrismMasterableOverride(item: { name?: string }, uniqueName: string): boolean {
  if (!/\/OperatorAmplifiers?\//i.test(uniqueName)) return false;
  if (/\/SentTrainingAmplifier/i.test(uniqueName)) return false;
  if (!/\/Barrel\//i.test(uniqueName)) return false;
  const n = (item.name || "").toLowerCase();
  // Keep to prism-only override (scaffolds/braces should not grant mastery).
  return n.includes(" prism");
}

function isVenariMasterableOverride(uniqueName: string): boolean {
  return VENARI_UNIQUE_NAME_PATTERN.test(uniqueName);
}

type InventoryMasteryEntry = Record<string, unknown> & {
  ItemType?: string;
  XP?: number;
  Features?: number;
};

interface OwnedMasteryRecord {
  rank: number;
  maxRank: number;
  owned: boolean;
  mastered: boolean;
  fromXPInfo?: boolean;
}

function readOwnedMasteryRecord(
  entry: InventoryMasteryEntry,
  fallbackMaxRank: number,
  owned: boolean,
  affinityPerRankSquared: number,
): OwnedMasteryRecord | null {
  if (!entry.ItemType) return null;

  const maxRank = getMasteryMaxRank(entry.ItemType, fallbackMaxRank);
  const xpRank = xpToRank(entry.XP || 0, maxRank, affinityPerRankSquared);
  const featuresRank = extractOvercapFeatureRank(entry, maxRank);
  const rank = Math.max(xpRank, featuresRank ?? 0);
  const masteredFlag = extractMasteredFlag(entry);
  const record: OwnedMasteryRecord = {
    rank,
    maxRank,
    owned,
    mastered: masteredFlag === true || rank >= maxRank,
  };
  if (!owned) record.fromXPInfo = true;
  return record;
}

function extractOvercapFeatureRank(entry: InventoryMasteryEntry, maxRank: number): number | null {
  if (maxRank <= MAX_ITEM_RANK) return null;
  const features = toFiniteNumber(entry.Features);
  if (features == null) return null;

  const rank = Math.floor(features) + 1;
  if (rank <= MAX_ITEM_RANK || rank > maxRank) return null;
  return rank;
}

interface MasterableItem {
  name: string;
  uniqueName: string;
  category: string;
  imageUrl: string | null;
  isPrime: boolean;
  masteryReq: number;
  vaulted: boolean;
  tradable: boolean;
  keywords: string[];
  debugReason: string;
  components: ComponentEntry[];
}

interface MasteryProgressItem extends MasterableItem {
  status: MasteryStatus;
  rank: number;
  maxRank: number;
  currentlyOwned: boolean;
}

function betterMasteryRecord(
  current: OwnedMasteryRecord | undefined,
  candidate: OwnedMasteryRecord | undefined,
): OwnedMasteryRecord | undefined {
  if (!candidate) return current;
  if (!current) return candidate;

  if (candidate.mastered !== current.mastered) {
    return candidate.mastered ? candidate : current;
  }

  if (candidate.rank !== current.rank) {
    return candidate.rank > current.rank ? candidate : current;
  }

  if (candidate.maxRank !== current.maxRank) {
    return candidate.maxRank > current.maxRank ? candidate : current;
  }

  if (candidate.owned !== current.owned) {
    return candidate.owned ? candidate : current;
  }

  return current;
}

export function getAllMasterableItems(): MasterableItem[] {
  const allItems = itemDb.getAllItems();
  const items: MasterableItem[] = [];
  const seenNames = new Set<string>();

  for (const [uniqueName, item] of Object.entries(allItems)) {
    const displayName = sanitizeDisplayName(item.name || "Unknown");

    if (!MASTERABLE_DB_CATEGORIES.has(item.category)) {
      continue;
    }
    const ampPrismOverride = isAmpPrismMasterableOverride(item, uniqueName);
    const venariOverride = isVenariMasterableOverride(uniqueName);
    if (item.masterable === false && !ampPrismOverride && !venariOverride) {
      continue;
    }

    const excludeReason = getExcludeReason(uniqueName, displayName, item);
    if (excludeReason) {
      continue;
    }

    const nameKey = displayName.toLowerCase();
    if (seenNames.has(nameKey)) {
      continue;
    }
    seenNames.add(nameKey);

    const display = resolveDisplayCategoryInfo(item, uniqueName);
    const keywords = getKeywords(uniqueName, displayName);
    if (display.category === "Railjack") {
      continue;
    }
    const masterableSource = ampPrismOverride
      ? "amp-prism-override"
      : venariOverride
        ? "venari-override"
        : item.masterable === true
          ? "wfcd-masterable:true"
          : "default";

    items.push({
      name: displayName,
      uniqueName,
      category: display.category,
      imageUrl: item.imageUrl || null,
      isPrime: item.isPrime || false,
      masteryReq: item.masteryReq || 0,
      vaulted: item.vaulted || false,
      tradable: item.tradable || item.isPrime || false,
      keywords,
      debugReason: `show:${masterableSource}; cat:${display.source}; dbCat:${item.category || "?"}; product:${item.productCategory || "?"}; type:${item.type || "?"}`,
      // Components from wfcd (blueprints, barrels, etc.)
      components: item.components || [],
    });
  }

  for (const item of SYNTHETIC_MASTERABLE_ITEMS) {
    if (!seenNames.has(item.name.toLowerCase())) {
      items.push(item);
    }
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

export function computeMasteryProgress(inventoryData: Record<string, unknown>): {
  items: MasteryProgressItem[];
  stats: {
    total: number;
    mastered: number;
    inProgress: number;
    missing: number;
    byCategory: Record<
      string,
      { total: number; mastered: number; inProgress: number; missing: number }
    >;
    profileMastery: { rank: number | null; percentToNext: number | null } | null;
  };
} {
  if (!inventoryData)
    return {
      items: [],
      stats: {
        total: 0,
        mastered: 0,
        inProgress: 0,
        missing: 0,
        byCategory: {},
        profileMastery: null,
      },
    };

  const allMasterable = getAllMasterableItems();
  const componentOwnership = aggregateComponentOwnership(
    inventoryData.MiscItems,
    inventoryData.Recipes,
    inventoryData.PendingRecipes,
  );

  // Build owned map: uniqueName -> { rank, maxRank, owned }
  const ownedMap = new Map<string, OwnedMasteryRecord>();

  for (const [invKey, maxRank] of Object.entries(INV_CATEGORIES)) {
    const arr = inventoryData[invKey];
    if (!Array.isArray(arr)) continue;
    const affinityPerRankSquared = getInventoryAffinityPerRankSquared(invKey);
    for (const entry of arr as InventoryMasteryEntry[]) {
      const record = readOwnedMasteryRecord(entry, maxRank as number, true, affinityPerRankSquared);
      if (record && entry.ItemType) {
        ownedMap.set(entry.ItemType, record);
      }
    }
  }

  // XPInfo: items sold but XP still counts
  const xpInfo = inventoryData.XPInfo;
  if (Array.isArray(xpInfo)) {
    for (const entry of xpInfo as InventoryMasteryEntry[]) {
      if (!entry.ItemType) continue;
      const existing = ownedMap.get(entry.ItemType);
      const dbItem = itemDb.lookupItem(entry.ItemType);
      const record = readOwnedMasteryRecord(
        entry,
        existing?.maxRank ?? MAX_ITEM_RANK,
        false,
        dbItem?.category === "Warframe" || dbItem?.category === "Companion"
          ? SUIT_AFFINITY_PER_RANK_SQUARED
          : WEAPON_AFFINITY_PER_RANK_SQUARED,
      );
      if (!record) continue;

      if (existing) {
        ownedMap.set(entry.ItemType, {
          ...existing,
          maxRank: Math.max(existing.maxRank, record.maxRank),
          mastered: existing.mastered || record.mastered,
        });
        continue;
      }

      ownedMap.set(entry.ItemType, record);
    }
  }

  // Name-based fallback matching
  const ownedByName = new Map<string, OwnedMasteryRecord & { uniqueName: string }>();
  for (const [uname, data] of ownedMap) {
    const dbItem = itemDb.lookupItem(uname);
    if (dbItem) {
      ownedByName.set(dbItem.name.toLowerCase(), { ...data, uniqueName: uname });
    }
  }

  // Annotate each masterable item with ownership + component status
  const items: MasteryProgressItem[] = allMasterable.map((item) => {
    let owned = ownedMap.get(item.uniqueName);
    owned = betterMasteryRecord(owned, ownedByName.get(item.name.toLowerCase()));
    for (const alias of MASTERABLE_UNIQUE_NAME_ALIASES[item.uniqueName] ?? []) {
      owned = betterMasteryRecord(owned, ownedMap.get(alias));
    }

    let status: MasteryStatus = "missing";
    let rank = 0;
    let maxRank = MAX_ITEM_RANK;
    let currentlyOwned = false;

    if (owned) {
      rank = owned.rank;
      maxRank = owned.maxRank;
      currentlyOwned = owned.owned !== false;
      status = owned.mastered || rank >= maxRank ? "mastered" : "progress";
    }

    // Annotate components with ownership
    const components = (item.components || []).map((comp: ComponentEntry) => {
      const ownedCount = comp.uniqueName ? componentOwnership.get(comp.uniqueName) || 0 : 0;
      return {
        name: comp.name || "",
        uniqueName: comp.uniqueName || "",
        tradable: comp.tradable || false,
        itemCount: comp.itemCount || 1,
        ownedCount,
        owned: ownedCount >= (comp.itemCount || 1),
        drops: comp.drops || [],
      };
    });

    return { ...item, status, rank, maxRank, currentlyOwned, components };
  });

  // Stats
  const total = items.length;
  const mastered = items.filter((i) => i.status === "mastered").length;
  const inProgress = items.filter((i) => i.status === "progress").length;
  const missing = items.filter((i) => i.status === "missing").length;

  const byCategory: Record<
    string,
    { total: number; mastered: number; inProgress: number; missing: number }
  > = {};
  for (const item of items) {
    if (!byCategory[item.category]) {
      byCategory[item.category] = { total: 0, mastered: 0, inProgress: 0, missing: 0 };
    }
    byCategory[item.category].total++;
    byCategory[item.category][item.status === "progress" ? "inProgress" : item.status]++;
  }

  return {
    items,
    stats: {
      total,
      mastered,
      inProgress,
      missing,
      byCategory,
      profileMastery: extractProfileMastery(inventoryData),
    },
  };
}
