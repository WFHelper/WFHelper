import fs from "node:fs";
import path from "node:path";

import * as itemDb from "./itemDatabase";
import type { ComponentEntry } from "./types/gameData";
import { MAX_ITEM_RANK } from "../config/game/constants";
import { aggregateComponentOwnership } from "../config/shared/componentOwnership";
import { sanitizeDisplayName } from "../config/shared/displayName";
import { withoutFoundryPending } from "../config/shared/foundryPending";
import { masteryRankToXp, masteryXpToRank } from "../config/shared/masteryXp";
import { toFiniteNumber } from "../config/shared/numeric";
import type { MasteryStatus } from "../config/shared/masteryTypes";

// Newer items arrive as "Warframes"/"Primary", older ones singular; accept both.
const MASTERABLE_DB_CATEGORIES = new Set([
  "Warframe",
  "Weapon",
  "Companion",
  "Railjack",
  "Warframes",
  "Primary",
  "Secondary",
  "Melee",
  "Companions",
  "Archwing",
]);

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

const KITGUN_CHAMBER_NAMES = new Set([
  "catchmoon",
  "gaze",
  "rattleguts",
  "sporelacer",
  "tombfinger",
  "vermisplicer",
]);
const ZAW_STRIKE_PATH_PATTERN = /\/Ostron\/Melee\/ModularMelee/i;
const MODULAR_COMPANION_MODEL_PATTERN =
  /\/Pets\/(?:MoaPets\/MoaPetParts\/MoaPetHead[^/]*|ZanukaPets\/ZanukaPetParts\/ZanukaPetPartHead[ABC])$/i;
const VINQUIBUS_PRIMARY_UNIQUE_NAME = "/Lotus/Weapons/Tenno/Bayonet/TnBayonetRifleWeapon";
const VINQUIBUS_MELEE_UNIQUE_NAME = "/Lotus/Weapons/Tenno/Bayonet/TnBayonetMeleeWeapon";
const GILDED_FEATURE_MASK = 8;

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

// XPInfo lacks containers; explicit identities keep pet weapons at weapon rate.
function isSuitRateXpInfoItem(
  itemType: string,
  dbItem: { category?: string; type?: string } | null,
): boolean {
  return (
    dbItem?.category === "Warframe" ||
    dbItem?.category === "Companion" ||
    MODULAR_COMPANION_MODEL_PATTERN.test(itemType) ||
    /\/Hoverboard/i.test(itemType) ||
    /k-drive/i.test(String(dbItem?.type || "")) ||
    /\/CrewShip\/(?:RailJack\/Default)?Harness$/i.test(itemType) ||
    /RailjackHarness$/i.test(itemType)
  );
}

const VENARI_UNIQUE_NAME_PATTERN = /\/Powersuits\/Khora\/Kavat\/Khora(?:Prime)?KavatPowerSuit$/i;
const WEAPON_AFFINITY_PER_RANK_SQUARED = 500;
const SUIT_AFFINITY_PER_RANK_SQUARED = 1_000;

// Account mastery: each gear rank grants affinityPerRankSquared / 5 mastery
// (weapons 100, suits 200). Rank thresholds live in config/shared/masteryXp.
const JUNCTION_MASTERY_XP = 1_000;
const INTRINSIC_MASTERY_XP = 1_500;
const MAX_INTRINSIC_RANK = 10;
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
  // Hound suits are model-specific; credit them to the model head when an
  // inventory carries suit XP without ModularParts.
  "/Lotus/Types/Friendly/Pets/ZanukaPets/ZanukaPetParts/ZanukaPetPartHeadA": [
    "/Lotus/Types/Friendly/Pets/ZanukaPets/ZanukaPetAPowerSuit",
  ],
  "/Lotus/Types/Friendly/Pets/ZanukaPets/ZanukaPetParts/ZanukaPetPartHeadB": [
    "/Lotus/Types/Friendly/Pets/ZanukaPets/ZanukaPetBPowerSuit",
  ],
  "/Lotus/Types/Friendly/Pets/ZanukaPets/ZanukaPetParts/ZanukaPetPartHeadC": [
    "/Lotus/Types/Friendly/Pets/ZanukaPets/ZanukaPetCPowerSuit",
  ],
  [VINQUIBUS_PRIMARY_UNIQUE_NAME]: [VINQUIBUS_MELEE_UNIQUE_NAME],
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

let _exportLevelCaps: { caps: Map<string, number>; known: Set<string> } | null = null;

/** Overcapped ranks straight from DE's export, which is authoritative. */
function getExportLevelCaps(): { caps: Map<string, number>; known: Set<string> } {
  if (_exportLevelCaps) return _exportLevelCaps;
  const caps = new Map<string, number>();
  const known = new Set<string>();
  try {
    const pep = require("warframe-public-export-plus") as Record<string, unknown>;
    for (const [tableName, table] of Object.entries(pep)) {
      if (!tableName.startsWith("Export") || !table || typeof table !== "object") continue;
      for (const [uniqueName, entry] of Object.entries(table as Record<string, unknown>)) {
        known.add(uniqueName);
        const cap = toFiniteNumber((entry as { maxLevelCap?: unknown })?.maxLevelCap);
        if (cap != null && cap > MAX_ITEM_RANK) caps.set(uniqueName, cap);
      }
    }
  } catch {
    /* export unavailable, heuristics below still apply */
  }
  _exportLevelCaps = { caps, known };
  return _exportLevelCaps;
}

function getMasteryMaxRank(itemType: string, fallbackMaxRank: number): number {
  const dbItem = itemDb.lookupItem(itemType);
  const name = (dbItem?.name || "").toLowerCase();
  const path = itemType.toLowerCase();

  // The export knows every rank-40 family, so no cap there means 30. Heuristics
  // below are only for items it omits (they over-capped strays like Onos).
  const { caps, known } = getExportLevelCaps();
  const exportCap = caps.get(itemType);
  if (exportCap != null) return Math.max(exportCap, fallbackMaxRank);
  if (known.has(itemType)) return fallbackMaxRank;

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

function getUnlockedMaxRank(entry: InventoryMasteryEntry, maxRank: number, owned: boolean): number {
  if (!owned || maxRank <= MAX_ITEM_RANK) return maxRank;
  const polarized = Math.max(0, Math.floor(toFiniteNumber(entry.Polarized) ?? 0));
  return Math.min(maxRank, MAX_ITEM_RANK + polarized * 2);
}

function hasGildedFeature(entry: InventoryMasteryEntry): boolean {
  const features = toFiniteNumber(entry.Features);
  return features != null && (Math.floor(features) & GILDED_FEATURE_MASK) !== 0;
}

function requiresGilding(
  invKey: string,
  entry: InventoryMasteryEntry,
  modularPart: string | null,
): boolean {
  if (invKey === "MoaPets") return true;
  if (invKey === "KubrowPets") return Array.isArray(entry.ModularParts);
  if (invKey === "OperatorAmps") return modularPart != null;
  return ["LongGuns", "Pistols", "Melee"].includes(invKey) && modularPart != null;
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

interface ProfileMasteryInfo {
  rank: number | null;
  percentToNext: number | null;
  totalXp: number | null;
  xpIntoRank: number | null;
  xpForNext: number | null;
  testReady: boolean;
}

// Node tag -> mastery grant. ExportRegions carries masteryExp per node; junctions
// export 0 there but award a flat 1000 in game. Loaded once, empty on failure.
let _regionMastery: Record<string, number> | null = null;
const _regionIsJunction: Record<string, boolean> = {};
function getRegionMastery(): Record<string, number> {
  if (_regionMastery) return _regionMastery;
  _regionMastery = {};

  let regions: Record<string, Record<string, unknown>> | null = null;
  try {
    const pep = require("warframe-public-export-plus") as {
      ExportRegions?: Record<string, Record<string, unknown>>;
    };
    if (pep?.ExportRegions) regions = pep.ExportRegions;
  } catch {
    /* package main export unavailable, try disk */
  }
  if (!regions) {
    try {
      const pkgDir = path.dirname(require.resolve("warframe-public-export-plus/package.json"));
      regions = JSON.parse(
        fs.readFileSync(path.join(pkgDir, "ExportRegions.json"), "utf8"),
      ) as Record<string, Record<string, unknown>>;
    } catch {
      regions = null;
    }
  }

  for (const [tag, node] of Object.entries(regions ?? {})) {
    const junction = node.missionType === "MT_JUNCTION";
    _regionIsJunction[tag] = junction;
    _regionMastery[tag] = junction ? JUNCTION_MASTERY_XP : (toFiniteNumber(node.masteryExp) ?? 0);
  }
  return _regionMastery;
}

// Node mastery is granted once normally and once again on Steel Path tier 1.
function computeMissionMasteryXp(inventoryData: Record<string, unknown>): number {
  const missions = inventoryData.Missions;
  if (!Array.isArray(missions)) return 0;
  const regions = getRegionMastery();

  let xp = 0;
  for (const entry of missions as Array<Record<string, unknown>>) {
    const tag = typeof entry.Tag === "string" ? entry.Tag : null;
    if (!tag || !(tag in regions)) continue;
    const completes = toFiniteNumber(entry.Completes) ?? 0;
    const steelPath = toFiniteNumber(entry.Tier) === 1;
    if (completes <= 0 && !steelPath) continue;
    xp += regions[tag];
    if (steelPath) xp += regions[tag];
  }
  return xp;
}

interface ProgressPair {
  done: number;
  total: number;
}
interface AccountCompletionStats {
  starChart: {
    normal: ProgressPair;
    junctions: ProgressPair;
    steelPath: ProgressPair;
    steelPathJunctions: ProgressPair;
  };
  intrinsics: { railjack: ProgressPair; drifter: ProgressPair };
}

/** Star chart + intrinsic completion. Display only; totals from ExportRegions. */
function computeAccountCompletion(inventoryData: Record<string, unknown>): AccountCompletionStats {
  const regions = getRegionMastery();

  let normalTotal = 0;
  let junctionTotal = 0;
  for (const [tag, xp] of Object.entries(regions)) {
    if (xp <= 0) continue;
    if (_regionIsJunction[tag]) junctionTotal++;
    else normalTotal++;
  }

  let normalDone = 0;
  let junctionDone = 0;
  let steelDone = 0;
  let steelJunctionDone = 0;
  const missions = Array.isArray(inventoryData?.Missions) ? inventoryData.Missions : [];
  for (const entry of missions as Array<Record<string, unknown>>) {
    const tag = typeof entry.Tag === "string" ? entry.Tag : null;
    if (!tag || !(tag in regions) || regions[tag] <= 0) continue;
    const completes = toFiniteNumber(entry.Completes) ?? 0;
    const steel = (toFiniteNumber(entry.Tier) ?? 0) >= 1;
    if (completes <= 0 && !steel) continue;
    if (_regionIsJunction[tag]) {
      junctionDone++;
      if (steel) steelJunctionDone++;
    } else {
      normalDone++;
      if (steel) steelDone++;
    }
  }

  const skills = (inventoryData?.PlayerSkills || {}) as Record<string, unknown>;
  const sumRanks = (match: RegExp): number => {
    let ranks = 0;
    for (const [key, value] of Object.entries(skills)) {
      if (!match.test(key)) continue;
      const rank = toFiniteNumber(value);
      if (rank != null && rank > 0) ranks += Math.min(rank, MAX_INTRINSIC_RANK);
    }
    return ranks;
  };
  const capFor = (match: RegExp): number =>
    Object.keys(skills).filter((key) => match.test(key)).length * MAX_INTRINSIC_RANK;

  const RAILJACK = /^LPS_(?!DRIFT_)/;
  const DRIFTER = /^LPS_DRIFT_/;
  return {
    starChart: {
      normal: { done: normalDone, total: normalTotal },
      junctions: { done: junctionDone, total: junctionTotal },
      steelPath: { done: steelDone, total: normalTotal },
      steelPathJunctions: { done: steelJunctionDone, total: junctionTotal },
    },
    intrinsics: {
      railjack: { done: sumRanks(RAILJACK), total: capFor(RAILJACK) },
      drifter: { done: sumRanks(DRIFTER), total: capFor(DRIFTER) },
    },
  };
}

// LPS_* entries are intrinsic ranks (railjack + drifter), 1500 mastery each.
// LPP_* are unspent point pools and grant nothing.
function computeIntrinsicMasteryXp(inventoryData: Record<string, unknown>): number {
  const skills = inventoryData.PlayerSkills;
  if (!skills || typeof skills !== "object") return 0;

  let ranks = 0;
  for (const [key, value] of Object.entries(skills as Record<string, unknown>)) {
    if (!key.startsWith("LPS_")) continue;
    const rank = toFiniteNumber(value);
    if (rank != null && rank > 0) ranks += Math.min(rank, MAX_INTRINSIC_RANK);
  }
  return ranks * INTRINSIC_MASTERY_XP;
}

function extractProfileMastery(
  inventoryData: Record<string, unknown>,
  totalXp: number | null,
): ProfileMasteryInfo | null {
  const rank =
    pickNumber(inventoryData, [
      ["MasteryRank"],
      ["MasteryLevel"],
      ["PlayerLevel"],
      ["PlayerRank"],
      ["LevelInfo", "MasteryRank"],
      ["LevelInfo", "PlayerLevel"],
    ]) ?? (totalXp != null ? masteryXpToRank(totalXp) : null);

  // Preferred: progress from the mastery XP we computed ourselves.
  if (rank != null && totalXp != null) {
    const currentThreshold = masteryRankToXp(rank);
    const nextThreshold = masteryRankToXp(rank + 1);
    const xpForNext = nextThreshold - currentThreshold;

    // Test not taken yet: keep the overflowing figure, don't clamp to the bar.
    if (totalXp >= nextThreshold) {
      return {
        rank,
        percentToNext: 100,
        totalXp,
        xpIntoRank: totalXp - currentThreshold,
        xpForNext,
        testReady: true,
      };
    }

    // Reconstruction undercounts big accounts; below the rank floor, trust the
    // game rank and drop the bar rather than show a fake "0 / N".
    if (totalXp < currentThreshold) {
      return {
        rank,
        percentToNext: null,
        totalXp,
        xpIntoRank: null,
        xpForNext: null,
        testReady: false,
      };
    }

    const xpIntoRank = totalXp - currentThreshold;
    return {
      rank,
      percentToNext: Math.min(100, Number(((xpIntoRank / xpForNext) * 100).toFixed(1))),
      totalXp,
      xpIntoRank,
      xpForNext,
      testReady: false,
    };
  }

  // Fallback: percent fields some helper exports include.
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
  return {
    rank,
    percentToNext,
    totalXp: null,
    xpIntoRank: null,
    xpForNext: null,
    testReady: false,
  };
}

function getExcludeReason(
  uniqueName: string,
  name: string | null,
  item: { exalted?: boolean; productCategory?: string | null; type?: string },
): string | null {
  if (uniqueName === VINQUIBUS_MELEE_UNIQUE_NAME) return "shared-mastery-variant";
  if (uniqueName.includes("/Recipes/")) return "recipe";
  if (uniqueName.includes("/StoreItems/")) return "store-item";
  if (uniqueName.includes("/OperatorLoadOuts/")) return "operator-loadout";
  if (uniqueName.includes("/QuestVersions/")) return "quest-version";
  if (uniqueName.includes("/PrototypeVersions/")) return "prototype-version";

  // Exclude only explicitly flagged exalted weapons; WFCD links can be incidental.
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

  // Scaffold/brace grant nothing, but the Mote Prism is an amp in its own right.
  if (/\/SentTrainingAmps?\/|\/SentTrainingAmplifiers?\//i.test(uniqueName)) {
    return isAmpPrismMasterableOverride({ name: name ?? undefined }, uniqueName)
      ? null
      : "training-amp";
  }

  // Modular pet chassis: mastery tracks the model head (Lambeo Moa, Bhaira
  // Hound, ...), never the power suit the build is stored under.
  if (/\/Pets\/(?:MoaPets\/MoaPet|ZanukaPets\/ZanukaPet[ABC])PowerSuit$/.test(uniqueName)) {
    return "modular-pet-chassis";
  }

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
  if (ZAW_STRIKE_PATH_PATTERN.test(uniqueName)) {
    return { category: "Melee", source: "override:zaw-strike" };
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
  // Builds keep the prism at .../Barrel/<part>, the Mote preset as a bare leaf.
  if (!/\/Barrel\/|Barrel$/i.test(uniqueName)) return false;
  const n = (item.name || "").toLowerCase();
  // Keep to prism-only override (scaffolds/braces should not grant mastery).
  return n.includes(" prism");
}

function isKitgunChamberMasterableOverride(item: { name?: string }, uniqueName: string): boolean {
  if (!/\/(?:Barrel|Barrels)\//i.test(uniqueName)) return false;
  return KITGUN_CHAMBER_NAMES.has((item.name || "").trim().toLowerCase());
}

function isVenariMasterableOverride(uniqueName: string): boolean {
  return VENARI_UNIQUE_NAME_PATTERN.test(uniqueName);
}

type InventoryMasteryEntry = Record<string, unknown> & {
  ItemType?: string;
  XP?: number;
  Features?: number;
  Polarized?: number;
  ModularParts?: unknown[];
};

interface OwnedMasteryRecord {
  /** Current rank (post-forma this resets to 0) - drives the level bar. */
  rank: number;
  /** Highest rank ever reached - mastery credit is banked at this rank. */
  masteryRank: number;
  maxRank: number;
  owned: boolean;
  mastered: boolean;
  masteryPerRank: number;
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
  const unlockedMaxRank = getUnlockedMaxRank(entry, maxRank, owned);
  const xpRank = xpToRank(entry.XP || 0, unlockedMaxRank, affinityPerRankSquared);
  const featuresRank = extractOvercapFeatureRank(entry, maxRank);
  const rank = Math.min(unlockedMaxRank, Math.max(xpRank, featuresRank ?? 0));
  const masteredFlag = extractMasteredFlag(entry);
  const record: OwnedMasteryRecord = {
    rank,
    masteryRank: rank,
    maxRank,
    owned,
    mastered: masteredFlag === true || rank >= maxRank,
    masteryPerRank: affinityPerRankSquared / 5,
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

const SUIT_MASTERY_CATEGORIES = new Set(["Warframes", "Companions", "Necramech"]);
// Archwing and Misc mix suits with weapons, so their database paths break the tie.
const SUIT_MASTERY_PATH_RE = /\/(?:SpaceSuits?|Powersuits\/Archwing|Hoverboard)\//i;

/** Owned items carry their own rate; missing ones fall back to their type. */
function itemMasteryPerRank(category: string, uniqueName: string): number {
  const isSuit = SUIT_MASTERY_CATEGORIES.has(category) || SUIT_MASTERY_PATH_RE.test(uniqueName);
  const perRankSquared = isSuit ? SUIT_AFFINITY_PER_RANK_SQUARED : WEAPON_AFFINITY_PER_RANK_SQUARED;
  return perRankSquared / 5;
}

/** A recipe component once ownership has been resolved against the inventory. */
interface MasteryComponentEntry extends ComponentEntry {
  ownedCount: number;
  owned: boolean;
}

interface MasteryProgressItem extends MasterableItem {
  status: MasteryStatus;
  rank: number;
  maxRank: number;
  currentlyOwned: boolean;
  masteryXp: number;
  /** Mastery still on the table: what maxing this item would add. */
  masteryXpRemaining: number;
  components: MasteryComponentEntry[];
}

function betterMasteryRecord(
  current: OwnedMasteryRecord | undefined,
  candidate: OwnedMasteryRecord | undefined,
): OwnedMasteryRecord | undefined {
  if (!candidate) return current;
  if (!current) return candidate;

  // Bank the highest rank either record saw; display fields pick a winner below.
  const masteryRank = Math.max(current.masteryRank, candidate.masteryRank);

  if (candidate.mastered !== current.mastered) {
    return { ...(candidate.mastered ? candidate : current), masteryRank };
  }

  if (candidate.rank !== current.rank) {
    return { ...(candidate.rank > current.rank ? candidate : current), masteryRank };
  }

  if (candidate.maxRank !== current.maxRank) {
    return { ...(candidate.maxRank > current.maxRank ? candidate : current), masteryRank };
  }

  if (candidate.owned !== current.owned) {
    return { ...(candidate.owned ? candidate : current), masteryRank };
  }

  return { ...current, masteryRank };
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
    const kitgunChamberOverride = isKitgunChamberMasterableOverride(item, uniqueName);
    const venariOverride = isVenariMasterableOverride(uniqueName);
    if (
      item.masterable === false &&
      !ampPrismOverride &&
      !kitgunChamberOverride &&
      !venariOverride
    ) {
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
      : kitgunChamberOverride
        ? "kitgun-chamber-override"
        : venariOverride
          ? "venari-override"
          : item.masterable === true
            ? "wfcd-masterable:true"
            : "default";

    items.push({
      name: displayName,
      ...itemDb.localizedNameFields(uniqueName, displayName),
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
    profileMastery: ProfileMasteryInfo | null;
    completion: AccountCompletionStats;
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
        completion: computeAccountCompletion({}),
      },
    };

  const allMasterable = getAllMasterableItems();
  const usableInventory = withoutFoundryPending(inventoryData, itemDb.isReusableBlueprint);
  const componentOwnership = aggregateComponentOwnership(usableInventory);

  // Build owned map: uniqueName -> { rank, maxRank, owned }
  const ownedMap = new Map<string, OwnedMasteryRecord>();
  const masterableNames = new Set(allMasterable.map((item) => item.uniqueName));

  // A kit masters through one part (strike/chamber/prism/deck) while the build
  // carries a generic ItemType. That part is the masterable one in the catalog.
  const modularMasteryPart = (entry: InventoryMasteryEntry): string | null => {
    const parts = (entry as { ModularParts?: unknown }).ModularParts;
    if (!Array.isArray(parts)) return null;
    for (const part of parts) {
      if (typeof part === "string" && masterableNames.has(part)) return part;
    }
    return null;
  };

  for (const [invKey, maxRank] of Object.entries(INV_CATEGORIES)) {
    const arr = inventoryData[invKey];
    if (!Array.isArray(arr)) continue;
    const affinityPerRankSquared = getInventoryAffinityPerRankSquared(invKey);
    for (const entry of arr as InventoryMasteryEntry[]) {
      const record = readOwnedMasteryRecord(entry, maxRank as number, true, affinityPerRankSquared);
      if (!record) continue;
      const part = modularMasteryPart(entry);
      if (requiresGilding(invKey, entry, part) && !hasGildedFeature(entry)) {
        record.rank = 0;
        record.masteryRank = 0;
        record.mastered = false;
      }
      const keys = [part ?? entry.ItemType];
      for (const key of keys) {
        if (!key) continue;
        // Several builds can share one part; mastery keeps the best rank reached.
        const existing = ownedMap.get(key);
        ownedMap.set(key, existing && existing.rank > record.rank ? existing : record);
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
      const isSuit = isSuitRateXpInfoItem(entry.ItemType, dbItem);
      const record = readOwnedMasteryRecord(
        entry,
        existing?.maxRank ?? MAX_ITEM_RANK,
        false,
        isSuit ? SUIT_AFFINITY_PER_RANK_SQUARED : WEAPON_AFFINITY_PER_RANK_SQUARED,
      );
      if (!record) continue;

      if (existing) {
        ownedMap.set(entry.ItemType, {
          ...existing,
          maxRank: Math.max(existing.maxRank, record.maxRank),
          mastered: existing.mastered || record.mastered,
          // Forma resets owned rank to 0; keep credit at the highest rank.
          masteryRank: Math.max(existing.masteryRank, record.masteryRank),
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
    // Overcapped families cap at 40 owned or not, else unowned reads "0/30".
    let maxRank = getMasteryMaxRank(item.uniqueName, MAX_ITEM_RANK);
    let currentlyOwned = false;
    let masteryXp = 0;

    if (owned) {
      rank = owned.rank;
      maxRank = owned.maxRank;
      currentlyOwned = owned.owned !== false;
      status = owned.mastered || rank >= maxRank ? "mastered" : "progress";
      // Credit the highest historical rank; a mastered flag banks the full max.
      const creditRank = owned.mastered ? maxRank : owned.masteryRank;
      masteryXp = Math.min(creditRank, maxRank) * owned.masteryPerRank;
    }

    // Annotate components with ownership. DE lists a doubled ingredient as two
    // rows of one, so merge by uniqueName first - checking each row against the
    // same owned total would let a single copy satisfy both halves.
    const mergedComponents: ComponentEntry[] = [];
    const componentIndexByUniqueName = new Map<string, number>();
    for (const comp of item.components || []) {
      const key = comp.uniqueName || "";
      const existing = key ? componentIndexByUniqueName.get(key) : undefined;
      if (existing === undefined) {
        if (key) componentIndexByUniqueName.set(key, mergedComponents.length);
        mergedComponents.push({ ...comp, itemCount: comp.itemCount || 1 });
        continue;
      }
      const target = mergedComponents[existing];
      target.itemCount = (target.itemCount || 1) + (comp.itemCount || 1);
    }

    const components = mergedComponents.map((comp: ComponentEntry) => {
      const ownedCount = comp.uniqueName ? componentOwnership.get(comp.uniqueName) || 0 : 0;
      return {
        name: comp.name || "",
        ...itemDb.localizedNameFields(comp.uniqueName, comp.name || ""),
        uniqueName: comp.uniqueName || "",
        tradable: comp.tradable || false,
        itemCount: comp.itemCount || 1,
        ownedCount,
        owned: ownedCount >= (comp.itemCount || 1),
        drops: comp.drops || [],
      };
    });

    const perRank = owned?.masteryPerRank ?? itemMasteryPerRank(item.category, item.uniqueName);
    const masteryXpRemaining = Math.max(0, maxRank * perRank - masteryXp);

    return {
      ...item,
      status,
      rank,
      maxRank,
      currentlyOwned,
      masteryXp,
      masteryXpRemaining,
      components,
    };
  });

  // Account mastery XP only makes sense when the inventory actually has XP data.
  let totalMasteryXp: number | null = null;
  if (Array.isArray(inventoryData.XPInfo) && inventoryData.XPInfo.length > 0) {
    let gearXp = 0;
    for (const item of items) gearXp += item.masteryXp;
    totalMasteryXp =
      gearXp + computeMissionMasteryXp(inventoryData) + computeIntrinsicMasteryXp(inventoryData);
  }

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
      profileMastery: extractProfileMastery(inventoryData, totalMasteryXp),
      completion: computeAccountCompletion(inventoryData),
    },
  };
}
