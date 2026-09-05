import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import { fetchWithTimeout } from "../config/shared/fetchWithTimeout";
import { MISSION_TYPE_LABELS } from "../config/shared/missionTypes";
import type {
  AlertRaw,
  CalendarDayRaw,
  CalendarEventRaw,
  SeasonChallengeRaw,
  WorldStateRaw,
  WorldStateDate,
} from "./types/gameData";

import fs from "fs";
import path from "path";

import { WORLD_STATE_CONFIG } from "../config/runtime/worldState";
import { toIconMirrorUrl } from "./itemDatabase";
import {
  factionLabel,
  loadRegionTranslation,
  localizedDictValue,
  nodeLabel,
  resolveDict,
} from "./regionNames";
import { titleCase } from "../config/shared/textNormalize";
import { fetchJsonWithTimeout } from "./worldStateFetch";
import { computeSteelPathHonors } from "./worldStateSteelPath";

const log = withScope("worldStateParser");

const FETCH_URLS = WORLD_STATE_CONFIG.fetchUrls;
const ORACLE_WORLDSTATE_URL = WORLD_STATE_CONFIG.oracleWorldStateUrl;
const ORACLE_BOUNTY_CYCLE_URL = WORLD_STATE_CONFIG.oracleBountyCycleUrl;
const EARTH_CYCLE_URL = WORLD_STATE_CONFIG.earthCycleUrl;
const WARFRAMESTAT_BASE_URL = WORLD_STATE_CONFIG.warframestatBaseUrl;
const FETCH_TIMEOUT_MS = WORLD_STATE_CONFIG.fetchTimeoutMs;
const CYCLE_FETCH_TIMEOUT_MS = WORLD_STATE_CONFIG.cycleFetchTimeoutMs;
const EARTH_CYCLE_FETCH_TIMEOUT_MS = WORLD_STATE_CONFIG.earthCycleFetchTimeoutMs;

// Orb Vallis constants - from browse.wf live.ts updateVallis()
const VALLIS_EPOCH_MS = new Date(WORLD_STATE_CONFIG.vallisEpochIso).getTime();
const VALLIS_PERIOD_MS = WORLD_STATE_CONFIG.vallisPeriodMs;
const VALLIS_WARM_MS = WORLD_STATE_CONFIG.vallisWarmMs;

// Plains / Cambion night duration - from browse.wf live.ts updateDayNightCycle()
const POE_NIGHT_MS = WORLD_STATE_CONFIG.poeNightMs;

const DUVIRI_MOOD_PERIOD_MS = WORLD_STATE_CONFIG.duviriMoodPeriodMs;
const DUVIRI_MOODS = WORLD_STATE_CONFIG.duviriMoods;

const REGION_TRANSLATION = loadRegionTranslation();

/** Late-load one public-export table: package first, then its shipped JSON. */
function loadPepExport(exportKey: string): Record<string, unknown> {
  try {
    const pep = require("warframe-public-export-plus");
    const data = pep?.[exportKey];
    if (data && typeof data === "object") return data as Record<string, unknown>;
  } catch {
    /* fall through to the on-disk copy */
  }
  try {
    const pkgDir = path.dirname(require.resolve("warframe-public-export-plus/package.json"));
    const data = JSON.parse(fs.readFileSync(path.join(pkgDir, `${exportKey}.json`), "utf8"));
    if (data && typeof data === "object") return data as Record<string, unknown>;
  } catch {
    log.warn(`[WorldState] failed to load ${exportKey}`);
  }
  return {};
}

interface ChallengeExportEntry {
  name?: string;
  requiredCount?: number;
  standing?: number;
}

/** Lazy-loaded challenge lookup: Lotus challenge path -> ExportChallenges entry */
let _challengeLookup: Record<string, ChallengeExportEntry> | null = null;
function getChallengeLookup(): Record<string, ChallengeExportEntry> {
  if (!_challengeLookup) {
    _challengeLookup = loadPepExport("ExportChallenges") as Record<string, ChallengeExportEntry>;
  }
  return _challengeLookup;
}

/** Lazy-loaded MT_ lookup: mission type -> ExportMissionTypes entry */
let _missionTypeLookup: Record<string, { name?: string }> | null = null;
function getMissionTypeLookup(): Record<string, { name?: string }> {
  if (!_missionTypeLookup) {
    _missionTypeLookup = loadPepExport("ExportMissionTypes") as Record<string, { name?: string }>;
  }
  return _missionTypeLookup;
}

/** Browse.wf icon overrides for items missing from public exports */
const BROWSE_WF = "https://browse.wf";
const BARO_ICON_OVERRIDES: Record<string, string> = {
  "/Lotus/Types/Items/ShipDecos/Plushies/PlushyNecraLoid":
    BROWSE_WF + "/Lotus/Interface/Icons/StoreIcons/ShipDecos/Decorations/NecraloidFloof.png",
};

function toBrowseMirrorUrl(iconPath: string | null | undefined): string | null {
  const trimmed = typeof iconPath === "string" ? iconPath.trim() : "";
  if (!trimmed) return null;
  return toIconMirrorUrl(trimmed.startsWith("http") ? trimmed : BROWSE_WF + trimmed);
}

/** Resolve a browse.wf icon for an item path, checking exports then overrides */
function resolveBaroIcon(itemPath: string): string | null {
  if (BARO_ICON_OVERRIDES[itemPath]) return toBrowseMirrorUrl(BARO_ICON_OVERRIDES[itemPath]);
  const entry = getItemLookup()[itemPath];
  if (entry && typeof (entry as Record<string, unknown>).icon === "string") {
    return toBrowseMirrorUrl((entry as Record<string, unknown>).icon as string);
  }
  return null;
}

/** Lazy-loaded item lookup: maps Lotus item paths -> { name: string } from ExportResources + ExportRecipes */
let _itemLookup: Record<
  string,
  { name?: string; era?: string; category?: string; resultType?: string }
> | null = null;
function getItemLookup(): Record<
  string,
  { name?: string; era?: string; category?: string; resultType?: string }
> {
  if (_itemLookup) return _itemLookup;
  _itemLookup = {};
  try {
    const pep = require("warframe-public-export-plus");
    for (const key of [
      "ExportResources",
      "ExportRecipes",
      "ExportUpgrades",
      "ExportGear",
      "ExportRelics",
      "ExportKeys",
      "ExportWeapons",
      "ExportWarframes",
      "ExportSentinels",
    ]) {
      const data = pep?.[key];
      if (data && typeof data === "object") {
        Object.assign(_itemLookup, data);
      }
    }
  } catch {
    try {
      const pkgDir = path.dirname(require.resolve("warframe-public-export-plus/package.json"));
      for (const file of [
        "ExportResources.json",
        "ExportRecipes.json",
        "ExportUpgrades.json",
        "ExportGear.json",
        "ExportRelics.json",
        "ExportKeys.json",
        "ExportWeapons.json",
        "ExportWarframes.json",
        "ExportSentinels.json",
      ]) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(pkgDir, file), "utf8"));
          if (data && typeof data === "object") Object.assign(_itemLookup, data);
        } catch {
          /* skip missing file */
        }
      }
    } catch {
      log.warn("[WorldState] failed to load item data for invasion rewards");
    }
  }
  return _itemLookup;
}

/** Dict values embed icon tags such as "<SHARD_BLUE_SIMPLE>" that have no glyph
 *  outside the game, so display names drop them. */
function stripDictTags(value: string): string {
  return value
    .replace(/<[A-Z0-9_]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Resolve a Lotus item path (e.g. /Lotus/Types/Items/...) to a display name */
function resolveItemName(itemPath: string): string {
  const items = getItemLookup();
  const entry = items[itemPath];
  if (entry?.name) {
    const resolved = resolveDictValue(entry.name);
    if (resolved) return stripDictTags(resolved);
  }
  // Recipe fallback: resolve name via resultType (e.g. MummyQuestKeyBlueprint -> "Sands of Inaros Blueprint")
  if (entry?.resultType) {
    const result = items[entry.resultType];
    if (result?.name) {
      const resolved = resolveDictValue(result.name);
      if (resolved) return `${stripDictTags(resolved)} Blueprint`;
    }
  }
  // Relic fallback: ExportRelics entries have era + category but no name
  if (entry?.era && entry?.category) return `${entry.era} ${entry.category} Relic`;
  // Fallback: extract readable name from path slug
  const readable = prettifyPathSlug(itemPath);
  // Glyphs are stored as "AvatarImage..." in data - display as "Glyph ..."
  if (readable.startsWith("Avatar Image")) return readable.replace("Avatar Image", "Glyph").trim();
  return readable;
}

const FACTION_LABEL: Record<string, string> = {
  FC_GRINEER: "Grineer",
  FC_CORPUS: "Corpus",
  FC_INFESTATION: "Infested",
  FC_OROKIN: "Orokin",
  FC_SENTIENT: "Sentient",
};

export function emptyWorldState(): Record<string, unknown> {
  return {
    fissures: [],
    voidTrader: null,
    vaultTrader: null,
    sortie: null,
    archonHunt: null,
    nightwave: null,
    descents: null,
    calendarSeason: null,
    alerts: [],
    steelPath: computeSteelPathHonors(),
    duviriCycle: null,
    earthCycle: null,
    cetusCycle: null,
    vallisCycle: null,
    cambionCycle: null,
    invasions: [],
    bounties: [],
    dailyDeals: [],
  };
}

function deDate(obj: WorldStateDate | null | undefined): string | null {
  if (!obj) return null;
  const ms = obj?.["$date"]?.["$numberLong"];
  return ms ? new Date(Number(ms)).toISOString() : null;
}

const VOID_TIER: Record<string, string> = {
  VoidT1: "Lith",
  VoidT2: "Meso",
  VoidT3: "Neo",
  VoidT4: "Axi",
  VoidT5: "Requiem",
  VoidT6: "Omnia",
  // Steel Path variants (modifier ends with "Hard")
  VoidT1Hard: "Lith",
  VoidT2Hard: "Meso",
  VoidT3Hard: "Neo",
  VoidT4Hard: "Axi",
  VoidT5Hard: "Requiem",
  VoidT6Hard: "Omnia",
};

// Sortie modifiers have no dictionary entry of any language, so these stay the
// English community labels; anything unmapped degrades to its title-cased tail.
const SORTIE_MODIFIER: Record<string, string> = {
  SORTIE_MODIFIER_ARMOR: "Enhanced Enemy Armor",
  SORTIE_MODIFIER_SHIELDS: "Augmented Enemy Shields",
  SORTIE_MODIFIER_HEALTH: "Enhanced Enemy Health",
  SORTIE_MODIFIER_EXIMUS: "Eximus Stronghold",
  SORTIE_MODIFIER_LOW_ENERGY: "Energy Reduction",
  SORTIE_MODIFIER_LOW_GRAVITY: "Low Gravity",
  SORTIE_MODIFIER_HIGH_GRAVITY: "High Gravity",
  SORTIE_MODIFIER_RADIATION: "Enemy Elemental Enhancement: Radiation",
  SORTIE_MODIFIER_VIRAL: "Enemy Elemental Enhancement: Viral",
  SORTIE_MODIFIER_CORROSIVE: "Enemy Elemental Enhancement: Corrosive",
  SORTIE_MODIFIER_MAGNETIC: "Enemy Elemental Enhancement: Magnetic",
  SORTIE_MODIFIER_GAS: "Enemy Elemental Enhancement: Gas",
  SORTIE_MODIFIER_EXPLOSION: "Enemy Elemental Enhancement: Blast",
  SORTIE_MODIFIER_FIRE: "Enemy Elemental Enhancement: Heat",
  SORTIE_MODIFIER_FREEZE: "Enemy Elemental Enhancement: Cold",
  SORTIE_MODIFIER_ELECTRICITY: "Enemy Elemental Enhancement: Electricity",
  SORTIE_MODIFIER_POISON: "Enemy Elemental Enhancement: Toxin",
  SORTIE_MODIFIER_IMPACT: "Enemy Physical Enhancement: Impact",
  SORTIE_MODIFIER_PUNCTURE: "Enemy Physical Enhancement: Puncture",
  SORTIE_MODIFIER_SLASH: "Enemy Physical Enhancement: Slash",
  SORTIE_MODIFIER_SECONDARY_ONLY: "Secondary Only",
  SORTIE_MODIFIER_RIFLE_ONLY: "Assault Rifle Only",
  SORTIE_MODIFIER_SHOTGUN_ONLY: "Shotgun Only",
  SORTIE_MODIFIER_SNIPER_ONLY: "Sniper Only",
  SORTIE_MODIFIER_BOW_ONLY: "Bow Only",
  SORTIE_MODIFIER_MELEE_ONLY: "Melee Only",
  SORTIE_MODIFIER_HAZARD_RADIATION: "Radiation Hazard",
  SORTIE_MODIFIER_HAZARD_MAGNETIC: "Magnetic Anomaly",
  SORTIE_MODIFIER_HAZARD_FIRE: "Fire Hazard",
  SORTIE_MODIFIER_HAZARD_ICE: "Cryogenic Leakage",
  SORTIE_MODIFIER_HAZARD_COLD: "Cryogenic Leakage",
  SORTIE_MODIFIER_HAZARD_ELECTRICITY: "Electromagnetic Anomalies",
  SORTIE_MODIFIER_HAZARD_FOG: "Dense Fog",
};

const HUB_NODE: Record<string, string> = {
  SaturnHUB: "Kronia Relay (Saturn)",
  MarsHUB: "Strata Relay (Mars)",
  CerberusHUB: "Orcus Relay (Pluto)",
  PlutoHUB: "Orcus Relay (Pluto)",
  EarthHUB: "Larunda Relay (Earth)",
  VenusHUB: "Vesper Relay (Venus)",
  EuropaHUB: "Leonov Relay (Europa)",
  NeptuneHUB: "Maroo's Bazaar (Mars)",
  "Relay Node 0": "Larunda Relay (Earth)",
  "Relay Node 4": "Strata Relay (Mars)",
  "Relay Node 9": "Vesper Relay (Venus)",
  "Relay Node 12": "Kronia Relay (Saturn)",
  "Relay Node 17": "Orcus Relay (Pluto)",
  "Relay Node 20": "Leonov Relay (Europa)",
};

function resolveDictValue(value: unknown): string | null {
  return resolveDict(REGION_TRANSLATION.dict, value);
}

function formatNodeLabel(nodeId: string): string {
  if (typeof nodeId !== "string" || nodeId.length === 0) {
    return "Unknown";
  }
  const region = REGION_TRANSLATION.regions[nodeId];
  if (!region) {
    return nodeId;
  }
  const nodeName = resolveDictValue(region.name) || nodeId;
  const systemName = resolveDictValue(region.systemName) || "";
  return systemName ? nodeName + ", " + systemName : nodeName;
}

/** Fissure, sortie, alert and bounty labels all resolve in this order so their
 *  casing and wording never diverge: DE's own MT_ table, then the node's mission,
 *  then the fallback map, then the enum tail. Dict values are ALL CAPS. */
function resolveMissionTypeLabel(
  missionType: string,
  nodeId: string,
  dictValue: (value: unknown) => string | null,
): string {
  const fromExport = dictValue(getMissionTypeLookup()[missionType]?.name);
  if (fromExport) return titleCase(fromExport);
  const fromNode = dictValue(REGION_TRANSLATION.regions[nodeId]?.missionName);
  if (fromNode) return titleCase(fromNode);
  return MISSION_TYPE_LABELS[missionType] || enumTailLabel(missionType, "MT_");
}

/** English on purpose: saved fissure-alert rules are matched against these. */
function formatMissionTypeLabel(missionType: string, nodeId: string): string {
  return resolveMissionTypeLabel(missionType, nodeId, resolveDictValue);
}

// Void storms omit MissionType, so resolve the node mission and normalize its dict label.
function railjackMissionLabel(nodeId: string): string {
  const name = resolveDictValue(REGION_TRANSLATION.regions[nodeId]?.missionName);
  return name ? titleCase(name) : "Railjack";
}

/** Strip an enum prefix and title-case the tail: SORTIE_BOSS_VAY_HEK -> "Vay Hek". */
function enumTailLabel(value: string, prefix: string): string {
  const tail = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return tail ? titleCase(tail.replace(/_/g, " ")) : "Unknown";
}

function sortieModifierLabel(modifier: string): string {
  return SORTIE_MODIFIER[modifier] || enumTailLabel(modifier, "SORTIE_MODIFIER_");
}

/** Empty rather than "Unknown" so a boss-less payload hides the line. */
function bossLabel(boss: string | undefined): string {
  return boss ? enumTailLabel(boss, "SORTIE_BOSS_") : "";
}

/** Sorties, archon hunts and alerts are display-only, so they follow the player's
 *  game language instead of the English wording the fissure alerts match on. */
function missionTypeLabel(missionType: string, nodeId: string): string {
  return resolveMissionTypeLabel(missionType, nodeId, localizedDictValue);
}

/** Readable tail of a Lotus path: ".../SeasonDailyAimGlide" -> "Season Daily Aim Glide".
 *  The "StoreItem" tail is plumbing, and DE glues durations onto the noun
 *  ("Booster3Day"), so digits are split off the letters either way round. */
function prettifyPathSlug(value: string): string {
  const slug = (value.split("/").pop() || value).replace(/StoreItems?$/, "");
  return slug
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function computeVallisCycle(nowMs: number = Date.now()): {
  isWarm: boolean;
  timeLeft: string;
  expiry: string;
} {
  const elapsed = (nowMs - VALLIS_EPOCH_MS) % VALLIS_PERIOD_MS;
  const isWarm = elapsed < VALLIS_WARM_MS;
  const timeLeftMs = isWarm ? VALLIS_WARM_MS - elapsed : VALLIS_PERIOD_MS - elapsed;
  return {
    isWarm,
    timeLeft: "",
    expiry: new Date(nowMs + timeLeftMs).toISOString(),
  };
}

function computeCetusCambionCycles(
  bountyCycleExpiryMs: number,
  nowMs: number = Date.now(),
): {
  cetus: { isDay: boolean; timeLeft: string; expiry: string };
  cambion: { active: string; timeLeft: string; expiry: string };
} {
  const nightStart = bountyCycleExpiryMs - POE_NIGHT_MS;
  const isDay = nowMs < nightStart;
  const expiryIso = new Date(isDay ? nightStart : bountyCycleExpiryMs).toISOString();
  return {
    cetus: { isDay, timeLeft: "", expiry: expiryIso },
    cambion: { active: isDay ? "fass" : "vome", timeLeft: "", expiry: expiryIso },
  };
}

function computeDuviriMoodCycle(nowMs: number = Date.now()): {
  state: string;
  expiry: string;
  nextState: string;
} {
  const moodIndex = Math.trunc(nowMs / DUVIRI_MOOD_PERIOD_MS);
  const moodStart = moodIndex * DUVIRI_MOOD_PERIOD_MS;
  const moodEnd = moodStart + DUVIRI_MOOD_PERIOD_MS;
  const state = DUVIRI_MOODS[moodIndex % DUVIRI_MOODS.length] || "Unknown";
  const nextState = DUVIRI_MOODS[(moodIndex + 1) % DUVIRI_MOODS.length] || "Unknown";

  return {
    state,
    expiry: new Date(moodEnd).toISOString(),
    nextState,
  };
}

async function fetchEarthCycle(): Promise<{
  isDay: boolean;
  timeLeft: string;
  expiry: string;
} | null> {
  try {
    const data = (await fetchJsonWithTimeout(
      EARTH_CYCLE_URL,
      EARTH_CYCLE_FETCH_TIMEOUT_MS,
    )) as Record<string, unknown>;
    const earthData = (
      data && typeof data.earthCycle === "object" ? data.earthCycle : data
    ) as Record<string, unknown> | null;

    const expiryIsoRaw = typeof earthData?.expiry === "string" ? earthData.expiry : null;
    const expiryMs = expiryIsoRaw ? Date.parse(expiryIsoRaw) : Number.NaN;
    if (!Number.isFinite(expiryMs)) {
      throw new Error("earth cycle missing expiry");
    }

    let isDay: boolean | null = null;
    if (typeof earthData?.isDay === "boolean") {
      isDay = earthData.isDay;
    } else {
      const state = String(earthData?.state || earthData?.timeOfDay || "").toLowerCase();
      if (state === "day") isDay = true;
      if (state === "night") isDay = false;
    }

    if (typeof isDay !== "boolean") {
      throw new Error("earth cycle missing state");
    }

    return {
      isDay,
      timeLeft: typeof earthData?.timeLeft === "string" ? earthData.timeLeft : "",
      expiry: new Date(expiryMs).toISOString(),
    };
  } catch (err) {
    log.warn("[WorldState] earth cycle fetch failed:", normalizeErrorMessage(err));
    return null;
  }
}

const CIRCUIT_CATEGORIES: ReadonlyArray<[string, string]> = [
  ["EXC_NORMAL", "normal"],
  ["EXC_HARD", "hard"],
];

export function parseCircuitChoices(
  raw: WorldStateRaw | null,
  nowMs: number = Date.now(),
): Array<{ category: string; choices: string[] }> {
  const schedule = Array.isArray(raw?.EndlessXpSchedule) ? raw.EndlessXpSchedule : [];
  const active =
    schedule.find((entry) => {
      const from = Number(entry?.Activation?.["$date"]?.["$numberLong"] || 0);
      const to = Number(entry?.Expiry?.["$date"]?.["$numberLong"] || 0);
      return from <= nowMs && (!to || to > nowMs);
    }) || null;
  const categories = active?.CategoryChoices || raw?.EndlessXpChoices || [];

  return CIRCUIT_CATEGORIES.map(([tag, category]) => ({
    category,
    // Split internal camel-case names for display.
    choices: (categories.find((entry) => entry?.Category === tag)?.Choices || [])
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2")),
  })).filter((entry) => entry.choices.length > 0);
}

// Keep Circuit empty when the fallback is unavailable.
async function fetchDuviriChoices(): Promise<Array<{ category: string; choices: string[] }>> {
  try {
    const data = (await fetchJsonWithTimeout(
      `${WARFRAMESTAT_BASE_URL}/duviriCycle`,
      CYCLE_FETCH_TIMEOUT_MS,
    )) as Record<string, unknown>;
    const raw = Array.isArray(data?.choices) ? data.choices : [];
    return raw
      .map((entry) => {
        const e = (entry || {}) as Record<string, unknown>;
        const category = typeof e.category === "string" ? e.category : "";
        const choices = Array.isArray(e.choices)
          ? e.choices.filter((c): c is string => typeof c === "string")
          : [];
        return { category, choices };
      })
      .filter((e) => e.category && e.choices.length > 0);
  } catch (err) {
    log.warn("[WorldState] duviri choices fetch failed:", normalizeErrorMessage(err));
    return [];
  }
}

const BOUNTY_SYNDICATES = new Set([
  "Ostrons", // CetusSyndicate
  "Solaris United", // SolarisSyndicate
  "Entrati", // EntratiSyndicate
  "The Holdfasts", // ZarimanSyndicate
  "Cavia", // EntratiLabSyndicate
  "The Hex", // HexSyndicate
]);

const RAW_BOUNTY_SYNDICATES: Record<string, string> = {
  CetusSyndicate: "Ostrons",
  SolarisSyndicate: "Solaris United",
  EntratiSyndicate: "Entrati",
};

// The oracle resolves seed-generated syndicate jobs absent from raw world state.
interface BountyCycleJob {
  node: string;
  challenge?: string;
  ally?: string;
}

interface BountyCycleResponse {
  expiry?: number;
  rot?: string;
  vaultRot?: string;
  zarimanFaction?: string;
  bounties?: Record<string, BountyCycleJob[]>;
}

const BOUNTY_CYCLE_SYNDICATES: Record<
  string,
  { displayName: string; standingTiers: number[][]; levelTiers: [number, number][] }
> = {
  ZarimanSyndicate: {
    displayName: "The Holdfasts",
    standingTiers: [
      [1000, 1500],
      [2000, 3000],
      [3000, 4500],
      [4000, 6000],
      [5000, 7500],
    ],
    levelTiers: [
      [50, 55],
      [60, 65],
      [70, 75],
      [90, 95],
      [110, 115],
    ],
  },
  EntratiLabSyndicate: {
    displayName: "Cavia",
    standingTiers: [
      [1000, 1500],
      [2000, 3000],
      [3000, 4500],
      [4000, 6000],
      [5000, 7500],
    ],
    levelTiers: [
      [55, 60],
      [65, 70],
      [75, 80],
      [95, 100],
      [115, 120],
    ],
  },
  HexSyndicate: {
    displayName: "The Hex",
    standingTiers: [
      [1000, 1500],
      [2000, 3000],
      [3000, 4500],
      [4000, 6000],
      [5000, 7500],
      [6000, 9000],
      [7500, 11250],
    ],
    // In-game levels; DE's drop-table labels run 10 lower (pools are matched by tier index)
    levelTiers: [
      [65, 70],
      [75, 80],
      [85, 90],
      [95, 100],
      [105, 110],
      [115, 120],
      [125, 130],
    ],
  },
};

interface WarframestatInvasion {
  id: string;
  node?: string;
  desc?: string;
  attacker?: {
    reward?: {
      items?: string[];
      countedItems?: { count: number; type: string }[];
      credits?: number;
    };
    faction?: string;
  };
  defender?: {
    reward?: {
      items?: string[];
      countedItems?: { count: number; type: string }[];
      credits?: number;
    };
    faction?: string;
  };
  vsInfestation?: boolean;
  completion?: number;
  completed?: boolean;
}

interface WarframestatSyndicateMission {
  syndicate?: string;
  syndicateKey?: string;
  expiry?: string;
  jobs?: {
    type?: string;
    enemyLevels?: number[];
    standingStages?: number[];
    minMR?: number;
  }[];
}

async function fetchWarframestatExtras(): Promise<{
  invasions: unknown[];
  bounties: unknown[];
}> {
  const result = { invasions: [] as unknown[], bounties: [] as unknown[] };

  const [invasionsRes, syndicateRes] = await Promise.allSettled([
    fetchJsonWithTimeout(`${WARFRAMESTAT_BASE_URL}/invasions`, CYCLE_FETCH_TIMEOUT_MS),
    fetchJsonWithTimeout(`${WARFRAMESTAT_BASE_URL}/syndicateMissions`, CYCLE_FETCH_TIMEOUT_MS),
  ]);

  // Invasions
  if (invasionsRes.status === "fulfilled" && Array.isArray(invasionsRes.value)) {
    result.invasions = (invasionsRes.value as WarframestatInvasion[])
      .filter((inv) => inv && !inv.completed)
      .map((inv) => ({
        id: inv.id || "",
        node: inv.node || "Unknown",
        desc: inv.desc || "",
        attacker: {
          reward: {
            items: inv.attacker?.reward?.items || [],
            countedItems: inv.attacker?.reward?.countedItems || [],
            credits: inv.attacker?.reward?.credits || 0,
          },
          faction: inv.attacker?.faction || "Unknown",
        },
        defender: {
          reward: {
            items: inv.defender?.reward?.items || [],
            countedItems: inv.defender?.reward?.countedItems || [],
            credits: inv.defender?.reward?.credits || 0,
          },
          faction: inv.defender?.faction || "Unknown",
        },
        vsInfestation: inv.vsInfestation || false,
        completion: typeof inv.completion === "number" ? Math.round(inv.completion * 10) / 10 : 0,
        completed: false,
      }));
  } else if (invasionsRes.status === "rejected") {
    log.warn("[WorldState] invasions fetch failed:", normalizeErrorMessage(invasionsRes.reason));
  }

  // Bounties (syndicate missions with jobs)
  if (syndicateRes.status === "fulfilled" && Array.isArray(syndicateRes.value)) {
    result.bounties = (syndicateRes.value as WarframestatSyndicateMission[])
      .filter(
        (sm) =>
          BOUNTY_SYNDICATES.has(sm.syndicate || "") && Array.isArray(sm.jobs) && sm.jobs.length > 0,
      )
      .map((sm) => ({
        syndicate: sm.syndicate || "",
        syndicateKey: sm.syndicateKey || "",
        expiry: sm.expiry || null,
        jobs: (sm.jobs || []).map((j) => ({
          type: j.type || "Unknown",
          enemyLevels: Array.isArray(j.enemyLevels)
            ? [j.enemyLevels[0] || 0, j.enemyLevels[1] || 0]
            : [0, 0],
          standingStages: j.standingStages || [],
          minMR: j.minMR || 0,
        })),
      }));
  } else if (syndicateRes.status === "rejected") {
    log.warn(
      "[WorldState] syndicateMissions fetch failed:",
      normalizeErrorMessage(syndicateRes.reason),
    );
  }

  return result;
}

// Dict key prefixes for challenge description lookup (tried in order)
const CHALLENGE_DESC_PREFIXES = [
  "/Lotus/Language/Challenges/Challenge_",
  "/Lotus/Language/EntratiLab/EntratiGeneral/Challenge_",
  "/Lotus/Language/1999Bounties/Challenge_",
];

// Difficulty suffixes appended by the oracle that don't exist in the dict
const DIFFICULTY_SUFFIXES = ["VeryHard", "Hard", "Normal", "Easy"];

/** Resolve oracle challenge paths through their language dictionary keys. */
function resolveChallengeInfo(challengePath: string, allyName?: string): { desc?: string } | null {
  if (!challengePath) return null;

  const slug = challengePath.split("/").pop() || "";
  if (!slug) return null;

  // Look up requiredCount from ExportChallenges using the original path
  const challengeData = getChallengeLookup()[challengePath];
  const count = challengeData?.requiredCount;

  // Build candidate slugs: original, with "Challenge" added, and with difficulty stripped
  const candidates: string[] = [];
  const addCandidates = (s: string) => {
    candidates.push(s);
    if (!s.endsWith("Challenge")) candidates.push(s + "Challenge");
  };
  addCandidates(slug);
  for (const suffix of DIFFICULTY_SUFFIXES) {
    if (slug.endsWith(suffix)) {
      addCandidates(slug.slice(0, -suffix.length));
      break;
    }
    // Also try stripping difficulty before the "Challenge" suffix
    // e.g. EntratiLabKillMurmurEasyChallenge -> EntratiLabKillMurmurChallenge
    const mid = suffix + "Challenge";
    if (slug.endsWith(mid)) {
      addCandidates(slug.slice(0, -mid.length) + "Challenge");
      break;
    }
  }

  for (const candidate of candidates) {
    for (const prefix of CHALLENGE_DESC_PREFIXES) {
      const descKey = prefix + candidate + "_Desc";
      const desc = REGION_TRANSLATION.dict[descKey];
      if (desc) {
        return {
          desc: cleanChallengeText(desc, allyName, count),
        };
      }
    }
  }
  return null;
}

/** Strip markup tags from challenge description text. */
function cleanChallengeText(text: string, allyName?: string, count?: number): string {
  let cleaned = text
    .replace(/\|COUNT\|/g, count != null ? String(count) : "X")
    .replace(/\|ALLY\|/g, allyName || "Ally")
    .replace(/\|OPEN_COLOR\|[^|]*\|CLOSE_COLOR\|\s*/g, "")
    .replace(/\n/g, " ")
    .trim();
  return cleaned;
}

/** Extract ally display name from oracle path (e.g. `.../QuincyAllyAgent` -> `Quincy`). */
function resolveAllyName(allyPath: string | undefined): string | undefined {
  if (!allyPath) return undefined;
  const slug = allyPath.split("/").pop() || "";
  return slug.replace(/AllyAgent$/, "") || undefined;
}

export function parseBountyCycleBounties(data: BountyCycleResponse): unknown[] {
  const bounties = data.bounties;
  if (!bounties || typeof bounties !== "object") return [];

  const expiryIso = data.expiry ? new Date(data.expiry).toISOString() : undefined;
  const result: unknown[] = [];

  for (const [syndicateKey, jobs] of Object.entries(bounties)) {
    const config = BOUNTY_CYCLE_SYNDICATES[syndicateKey];
    if (!config || !Array.isArray(jobs) || jobs.length === 0) continue;

    const parsedJobs = jobs.map((job, index) => {
      const region = REGION_TRANSLATION.regions[job.node];
      const missionType = region?.missionType
        ? formatMissionTypeLabel(String(region.missionType), job.node)
        : "Unknown";
      const levels: [number, number] = config.levelTiers[index] ?? [
        Number(region?.minEnemyLevel) || 0,
        Number(region?.maxEnemyLevel) || 0,
      ];
      // Oracle bounties are single-stage; standingTiers[index] is [base, bonus], not per-stage
      const standingPair = config.standingTiers[index] || [];
      const stages = standingPair.length > 0 ? [standingPair[0]] : [];

      // Resolve challenge name and description
      const allyName = resolveAllyName(job.ally);
      const challengeInfo = job.challenge ? resolveChallengeInfo(job.challenge, allyName) : null;

      return {
        type: missionType,
        enemyLevels: levels,
        tierIndex: index,
        standingStages: stages,
        minMR: 0,
        ...(challengeInfo?.desc ? { challengeDesc: challengeInfo.desc } : {}),
      };
    });

    result.push({
      syndicate: config.displayName,
      syndicateKey,
      expiry: expiryIso,
      jobs: parsedJobs,
    });
  }
  return result;
}

async function fetchAndComputeCycles(
  knownChoices: Array<{ category: string; choices: string[] }> = [],
): Promise<Record<string, unknown>> {
  const nowMs = Date.now();

  // Vallis and Duviri mood are pure math - always available
  const vallisCycle = computeVallisCycle(nowMs);
  const duviriMood = computeDuviriMoodCycle(nowMs);

  // Fetch oracle bounty-cycle, earth cycle and Circuit choices in parallel
  const [oracleResult, earthResult, duviriChoicesResult] = await Promise.allSettled([
    fetchJsonWithTimeout(
      ORACLE_BOUNTY_CYCLE_URL,
      CYCLE_FETCH_TIMEOUT_MS,
    ) as Promise<BountyCycleResponse>,
    fetchEarthCycle(),
    knownChoices.length > 0 ? Promise.resolve(knownChoices) : fetchDuviriChoices(),
  ]);

  const duviriCycle = {
    ...duviriMood,
    choices: duviriChoicesResult.status === "fulfilled" ? duviriChoicesResult.value : [],
  };

  let cetusCycle: { isDay: boolean; timeLeft: string; expiry: string } | null = null;
  let cambionCycle: { active: string; timeLeft: string; expiry: string } | null = null;
  let bountyCycleBounties: unknown[] = [];
  let bountyRotation: string | undefined;
  if (oracleResult.status === "fulfilled") {
    const expiryMs = Number(oracleResult.value.expiry);
    if (expiryMs) {
      const { cetus, cambion } = computeCetusCambionCycles(expiryMs, nowMs);
      cetusCycle = cetus;
      cambionCycle = cambion;
    }
    bountyCycleBounties = parseBountyCycleBounties(oracleResult.value);
    bountyRotation = oracleResult.value.rot || undefined;
  } else {
    log.warn(
      "[WorldState] oracle bounty-cycle fetch failed:",
      normalizeErrorMessage(oracleResult.reason),
    );
  }

  let earthCycle = earthResult.status === "fulfilled" ? earthResult.value : null;
  if (!earthCycle && cetusCycle) {
    earthCycle = { isDay: cetusCycle.isDay, timeLeft: "", expiry: cetusCycle.expiry };
  }

  return {
    earthCycle,
    cetusCycle,
    vallisCycle,
    cambionCycle,
    duviriCycle,
    bountyCycleBounties,
    bountyRotation,
  };
}

async function fetchOracleWorldState(): Promise<WorldStateRaw> {
  const raw = (await fetchJsonWithTimeout(
    ORACLE_WORLDSTATE_URL,
    FETCH_TIMEOUT_MS,
  )) as WorldStateRaw;
  if (!isWorldStatePayload(raw)) throw new Error("oracle returned an invalid payload");
  log.info("[WorldState] fetched oracle world-state OK");
  return raw;
}

const WORLD_STATE_MARKERS: ReadonlyArray<keyof WorldStateRaw> = [
  "ActiveMissions",
  "VoidStorms",
  "Invasions",
  "VoidTraders",
  "SyndicateMissions",
  "EndlessXpSchedule",
];

function isWorldStatePayload(value: unknown): value is WorldStateRaw {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return WORLD_STATE_MARKERS.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

async function fetchDeWorldState(): Promise<WorldStateRaw | null> {
  for (const url of FETCH_URLS) {
    try {
      const resp = await fetchWithTimeout(
        url,
        FETCH_TIMEOUT_MS,
        { headers: { Accept: "application/json" } },
        new Error("timeout"),
      );
      if (!resp.ok) {
        log.warn(`[WorldState] ${url} returned HTTP ${resp.status}`);
        continue;
      }
      const raw = await resp.json();
      if (!isWorldStatePayload(raw)) {
        log.warn(`[WorldState] ${url} returned an invalid payload`);
        continue;
      }
      log.info("[WorldState] fetched DE world-state OK:", url);
      return raw;
    } catch (deErr) {
      log.warn(`[WorldState] ${url} failed:`, normalizeErrorMessage(deErr));
    }
  }
  return null;
}

export async function fetchAndParse(): Promise<Record<string, unknown>> {
  // Prefer DE so normal polling does not overload the community oracle.
  let raw = await fetchDeWorldState();
  if (!raw) {
    try {
      raw = await fetchOracleWorldState();
    } catch (oracleErr) {
      throw new Error(`every world-state source failed: ${normalizeErrorMessage(oracleErr)}`, {
        cause: oracleErr,
      });
    }
  }

  const parsed = parseRaw(raw);
  if (!parsed) throw new Error("world-state payload could not be parsed");

  // Fetch cycles and warframestat extras in parallel
  const parsedChoices =
    (parsed.duviriCycle as { choices?: Array<{ category: string; choices: string[] }> } | null)
      ?.choices || [];
  const [cyclesResult, extrasResult] = await Promise.allSettled([
    fetchAndComputeCycles(parsedChoices),
    fetchWarframestatExtras(),
  ]);

  const cycles = cyclesResult.status === "fulfilled" ? cyclesResult.value : null;
  const extras = extrasResult.status === "fulfilled" ? extrasResult.value : null;

  if (cyclesResult.status === "rejected") {
    log.warn(
      "[WorldState] planet cycle computation failed:",
      normalizeErrorMessage(cyclesResult.reason),
    );
  }
  if (extrasResult.status === "rejected") {
    log.warn(
      "[WorldState] warframestat extras failed:",
      normalizeErrorMessage(extrasResult.reason),
    );
  }

  const nowMs = Date.now();
  const fallbackCycles = cycles || {
    vallisCycle: computeVallisCycle(nowMs),
    duviriCycle: computeDuviriMoodCycle(nowMs),
  };

  // Steel Path is computed locally (epoch-based rotation) - no external API needed
  const steelPath = computeSteelPathHonors();

  // Prefer raw bounties, then fill gaps from warframestat and the seed oracle.
  const rawBounties = (parsed.bounties || []) as { syndicateKey?: string }[];
  const warframestatBounties = (extras?.bounties || []) as { syndicateKey?: string }[];
  const seedBounties = (cycles?.bountyCycleBounties || []) as { syndicateKey?: string }[];

  // Collect all display names already covered by raw bounties
  const rawDisplayNames = new Set(
    rawBounties.map((b) => RAW_BOUNTY_SYNDICATES[b.syndicateKey || ""]),
  );
  // Build final list: raw first, warframestat fills gaps (by display name), seed fills remaining
  const bountyMap = new Map<string, unknown>();
  for (const b of rawBounties) {
    if (b.syndicateKey) bountyMap.set(b.syndicateKey, b);
  }
  // warframestat uses display names as syndicateKey - skip if raw already has this syndicate
  for (const b of warframestatBounties) {
    if (b.syndicateKey && !rawDisplayNames.has(b.syndicateKey) && !bountyMap.has(b.syndicateKey)) {
      bountyMap.set(b.syndicateKey, b);
    }
  }
  for (const b of seedBounties) {
    if (b.syndicateKey && !bountyMap.has(b.syndicateKey)) bountyMap.set(b.syndicateKey, b);
  }
  const allBounties = [...bountyMap.values()];

  return {
    ...parsed,
    ...fallbackCycles,
    duviriCycle: {
      ...(parsed?.duviriCycle || {}),
      ...(fallbackCycles?.duviriCycle || {}),
    },
    steelPath,
    invasions:
      (parsed.invasions as unknown[])?.length > 0 ? parsed.invasions : extras?.invasions || [],
    bounties: allBounties,
    bountyRotation: (cycles as Record<string, unknown>)?.bountyRotation || undefined,
  };
}

/** StoreItems paths mirror the real item path, one segment up. */
function storeItemPath(itemPath: string | undefined): string {
  return (itemPath || "").replace(/^\/Lotus\/StoreItems/, "/Lotus");
}

/** DE occasionally ships a scalar where an array belongs; one bad field must
 * not cost the whole world state. */
function asList<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/** DE ships these singly or as an array: take the live entry, else the first. */
function activeEntry<T extends { Expiry?: WorldStateDate }>(
  value: T | T[] | undefined,
  nowMs: number,
): T | null {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return (
    list.find((entry) => Number(entry.Expiry?.["$date"]?.["$numberLong"] || 0) > nowMs) ||
    list[0] ||
    null
  );
}

/** Mirrors CalendarDayEvent in src/types/world.ts; services stay out of renderer types. */
interface CalendarEvent {
  kind: "challenge" | "reward" | "upgrade";
  label: string;
  description?: string;
  uniqueName?: string;
}

/** A few calendar dict values are shouted; only this row rewrites them, since
 *  item names elsewhere are matched against the game and must stay verbatim. */
function calendarLabel(value: string): string {
  return /[A-Za-z]/.test(value) && value === value.toUpperCase() ? titleCase(value) : value;
}

/** One resolved calendar event, or null for a kind we cannot render. */
function parseCalendarEvent(event: CalendarEventRaw): CalendarEvent | null {
  if (event.challenge) {
    const entry = getChallengeLookup()[event.challenge];
    const count = Number(entry?.requiredCount) || undefined;
    const name = localizedDictValue(entry?.name);
    if (!name) return { kind: "challenge", label: prettifyPathSlug(event.challenge) };
    // The description key is the name key with its _Name tail swapped, as with
    // nightwave acts; without a value the objective line simply stays away.
    const description = localizedDictValue(entry?.name?.replace(/_Name$/, "_Description"));
    return {
      kind: "challenge",
      label: calendarLabel(cleanChallengeText(name, undefined, count)),
      ...(description ? { description: cleanChallengeText(description, undefined, count) } : {}),
    };
  }
  if (event.reward) {
    const uniqueName = storeItemPath(event.reward);
    return { kind: "reward", label: calendarLabel(resolveItemName(uniqueName)), uniqueName };
  }
  if (event.upgrade) return { kind: "upgrade", label: prettifyPathSlug(event.upgrade) };
  return null;
}

/** Days with no resolvable event carry nothing worth showing, so they are dropped. */
function parseCalendarDays(days: CalendarDayRaw[] | undefined): Array<{
  day: number;
  events: CalendarEvent[];
}> {
  return asList(days)
    .map((entry) => ({
      day: Number(entry.day) || 0,
      events: asList(entry.events)
        .map(parseCalendarEvent)
        .filter((resolved): resolved is CalendarEvent => Boolean(resolved?.label)),
    }))
    .filter((entry) => entry.events.length > 0);
}

/** Resolve one Nightwave act through ExportChallenges and the language dict. */
function parseNightwaveChallenge(raw: SeasonChallengeRaw) {
  const challengePath = raw.Challenge || "";
  const entry = getChallengeLookup()[challengePath];
  const requiredCount = Number(entry?.requiredCount) || 0;
  const title = localizedDictValue(entry?.name) || prettifyPathSlug(challengePath) || "Unknown";
  // The description key is the name key with its _Name tail swapped. Roughly one
  // act in ten has no description value, and then the title stands alone.
  const description = localizedDictValue(entry?.name?.replace(/_Name$/, "_Description"));
  return {
    id: raw._id?.$oid || "",
    // Path tail, e.g. "SeasonDailyAimGlide"; joins the inventory's ChallengeProgress.
    name: challengePath.split("/").pop() || "",
    title,
    description: description ? cleanChallengeText(description, undefined, requiredCount) : title,
    standing: Number(entry?.standing) || 0,
    requiredCount,
    isDaily: raw.Daily === true,
    isElite: challengePath.includes("/WeeklyHard/"),
    activation: deDate(raw.Activation),
    expiry: deDate(raw.Expiry),
  };
}

function parseAlert(raw: AlertRaw) {
  const info = raw.MissionInfo || {};
  const nodeId = info.location || "";
  const reward = info.missionReward || {};
  const items = [
    ...asList(reward.countedItems).map((counted) => ({
      name: resolveItemName(storeItemPath(counted.ItemType)),
      count: Number(counted.ItemCount) || 1,
    })),
    ...asList(reward.items).map((itemPath) => ({
      name: resolveItemName(storeItemPath(itemPath)),
      count: 1,
    })),
  ];
  return {
    id: raw._id?.$oid || "",
    activation: deDate(raw.Activation),
    expiry: deDate(raw.Expiry),
    node: nodeLabel(REGION_TRANSLATION, nodeId),
    mission: missionTypeLabel(info.missionType || "", nodeId),
    faction: factionLabel(info.faction),
    minLevel: Number(info.minEnemyLevel) || 0,
    maxLevel: Number(info.maxEnemyLevel) || 0,
    credits: Number(reward.credits) || 0,
    items,
  };
}

export function parseRaw(raw: WorldStateRaw | null): Record<string, unknown> | null {
  if (!raw) return null;
  const nowMs = Date.now();

  const fissures = (raw.ActiveMissions || [])
    .filter((m) => {
      const mod = m.Modifier || "";
      return mod.startsWith("VoidT") && VOID_TIER[mod];
    })
    .map((m) => {
      const mod = m.Modifier || "";
      const missionTypeRaw = m.MissionType || "";
      const nodeId = m.Node || "Unknown";
      const isHard = m.Hard === true || mod.endsWith("Hard");
      const expMs = Number(m.Expiry?.["$date"]?.["$numberLong"] || 0);
      return {
        expiry: expMs ? new Date(expMs).toISOString() : null,
        tier: VOID_TIER[mod] || "Unknown",
        missionType: formatMissionTypeLabel(missionTypeRaw, nodeId),
        node: formatNodeLabel(nodeId),
        nodeId,
        isHard,
        expired: expMs < nowMs,
      };
    })
    .filter((f) => !f.expired);

  // Void Storms (Railjack) use a separate array with `ActiveMissionTier`
  // ("VoidT3", or "...Hard" for Steel Path) instead of a Modifier.
  const voidStorms = (raw.VoidStorms || [])
    .map((vs) => {
      const tierRaw = vs.ActiveMissionTier || "";
      const isHard = tierRaw.endsWith("Hard");
      const baseTier = isHard ? tierRaw.slice(0, -4) : tierRaw;
      const nodeId = vs.Node || "Unknown";
      const expMs = Number(vs.Expiry?.["$date"]?.["$numberLong"] || 0);
      return {
        expiry: expMs ? new Date(expMs).toISOString() : null,
        tier: VOID_TIER[baseTier] || "Unknown",
        missionType: railjackMissionLabel(nodeId),
        node: formatNodeLabel(nodeId),
        nodeId,
        isHard,
        isStorm: true,
        expired: expMs < nowMs,
      };
    })
    .filter((f) => f.tier !== "Unknown" && !f.expired);

  const allFissures = [...fissures, ...voidStorms];

  const baroRaw = Array.isArray(raw.VoidTraders) ? raw.VoidTraders[0] : raw.VoidTraders;
  const voidTrader = baroRaw
    ? {
        activation: deDate(baroRaw.Activation),
        expiry: deDate(baroRaw.Expiry),
        location: HUB_NODE[baroRaw.Node] || baroRaw.Node || "Unknown",
        inventory: (baroRaw.Manifest || [])
          .filter((i) => !(i.ItemType || "").includes("BaroTreasureBox"))
          .map((i) => {
            const un = storeItemPath(i.ItemType);
            return {
              uniqueName: un,
              item: resolveItemName(un),
              ducats: i.PrimePrice ?? 0,
              credits: i.RegularPrice ?? 0,
              imageOverride: resolveBaroIcon(un),
            };
          }),
      }
    : null;

  const varziaRaw = Array.isArray(raw.PrimeVaultTraders)
    ? raw.PrimeVaultTraders[0]
    : raw.PrimeVaultTraders;
  const vaultTrader = varziaRaw
    ? {
        activation: deDate(varziaRaw.Activation),
        expiry: deDate(varziaRaw.Expiry),
        location: HUB_NODE[varziaRaw.Node] || varziaRaw.Node || "Varzia",
        inventory: (varziaRaw.Manifest || []).map((i) => ({
          uniqueName: storeItemPath(i.ItemType),
          item: (i.ItemType || "").split("/").pop() || "",
        })),
      }
    : null;

  const sortieRaw = activeEntry(raw.Sorties, nowMs);
  const sortie = sortieRaw
    ? {
        id: sortieRaw._id?.$oid || "",
        activation: deDate(sortieRaw.Activation),
        expiry: deDate(sortieRaw.Expiry),
        boss: bossLabel(sortieRaw.Boss),
        missions: asList(sortieRaw.Variants).map((variant) => ({
          node: nodeLabel(REGION_TRANSLATION, variant.node || ""),
          mission: missionTypeLabel(variant.missionType || "", variant.node || ""),
          modifier: sortieModifierLabel(variant.modifierType || ""),
        })),
      }
    : null;

  const archonRaw = activeEntry(raw.LiteSorties, nowMs);
  const archonHunt = archonRaw
    ? {
        id: archonRaw._id?.$oid || "",
        activation: deDate(archonRaw.Activation),
        expiry: deDate(archonRaw.Expiry),
        boss: bossLabel(archonRaw.Boss),
        missions: asList(archonRaw.Missions).map((mission) => ({
          node: nodeLabel(REGION_TRANSLATION, mission.node || ""),
          mission: missionTypeLabel(mission.missionType || "", mission.node || ""),
        })),
      }
    : null;

  const seasonRaw = raw.SeasonInfo;
  const nightwave = seasonRaw
    ? {
        activation: deDate(seasonRaw.Activation),
        expiry: deDate(seasonRaw.Expiry),
        season: Number(seasonRaw.Season) || 0,
        phase: Number(seasonRaw.Phase) || 0,
        affiliationTag: seasonRaw.AffiliationTag || "",
        // DE leaves finished acts in ActiveChallenges, which would render a
        // negative countdown. A missing expiry keeps the act rather than risking
        // an empty board on a malformed field.
        challenges: asList(seasonRaw.ActiveChallenges)
          .filter((challenge) => {
            const exp = Number(challenge.Expiry?.["$date"]?.["$numberLong"] || 0);
            return exp === 0 || exp > nowMs;
          })
          .map(parseNightwaveChallenge),
      }
    : null;

  const alerts = asList(raw.Alerts)
    .filter((alert) => Number(alert.Expiry?.["$date"]?.["$numberLong"] || 0) > nowMs)
    .map(parseAlert);

  const descentArr = Array.isArray(raw.Descents) ? raw.Descents : [];
  const descentRaw =
    descentArr.find((d) => {
      const act = Number(d.Activation?.["$date"]?.["$numberLong"] || 0);
      const exp = Number(d.Expiry?.["$date"]?.["$numberLong"] || 0);
      return act <= nowMs && exp > nowMs;
    }) || descentArr[0];

  const duviriCycle = {
    state: null as string | null,
    expiry: descentRaw ? deDate(descentRaw.Expiry) : null,
    choices: parseCircuitChoices(raw, nowMs),
  };

  const rawBounties = (raw.SyndicateMissions || [])
    .filter((sm) => {
      const displayName = RAW_BOUNTY_SYNDICATES[sm.Tag];
      if (!displayName) return false;
      const expMs = Number(sm.Expiry?.["$date"]?.["$numberLong"] || 0);
      return expMs > nowMs && Array.isArray(sm.Jobs) && sm.Jobs.length > 0;
    })
    .map((sm) => ({
      syndicate: RAW_BOUNTY_SYNDICATES[sm.Tag],
      syndicateKey: sm.Tag,
      expiry: deDate(sm.Expiry),
      jobs: sm
        .Jobs!.filter((j) => j.jobType)
        .map((j) => {
          // Extract a short label from the Lotus path (e.g. "/Lotus/.../AttritionBountyExt" -> "Attrition Bounty")
          const slug = (j.jobType || "").split("/").pop() || "Unknown";
          const type =
            slug
              .replace(/Bounty.*/, " Bounty")
              .replace(/([a-z])([A-Z])/g, "$1 $2")
              .trim() || "Unknown";
          return {
            type,
            enemyLevels: [j.minEnemyLevel || 0, j.maxEnemyLevel || 0],
            standingStages: j.xpAmounts || [],
            minMR: j.masteryReq || 0,
          };
        }),
    }));

  const rawInvasions = (raw.Invasions || [])
    .filter((inv) => !inv.Completed)
    .map((inv) => {
      const atkFaction = FACTION_LABEL[inv.Faction] || inv.Faction;
      const defFaction = FACTION_LABEL[inv.DefenderFaction] || inv.DefenderFaction;
      const vsInfestation = inv.Faction === "FC_INFESTATION";
      const completion = inv.Goal > 0 ? Math.round((inv.Count / inv.Goal) * 1000) / 10 : 0;

      function mapReward(reward?: {
        countedItems?: { ItemType: string; ItemCount: number }[];
        credits?: number;
      }) {
        if (!reward) return { items: [], countedItems: [], credits: 0 };
        return {
          items: [] as string[],
          countedItems: (reward.countedItems || []).map((ci) => ({
            count: ci.ItemCount || 1,
            type: resolveItemName(ci.ItemType),
          })),
          credits: reward.credits || 0,
        };
      }

      return {
        id: inv._id?.$oid || "",
        node: formatNodeLabel(inv.Node),
        attacker: { reward: mapReward(inv.AttackerReward), faction: atkFaction },
        defender: { reward: mapReward(inv.DefenderReward), faction: defFaction },
        vsInfestation,
        completion: Math.max(0, Math.min(100, Math.abs(completion))),
        completed: false,
      };
    });

  // descentRaw is the active window already picked for the duviri expiry above.
  const descents = descentRaw
    ? { activation: deDate(descentRaw.Activation), expiry: deDate(descentRaw.Expiry) }
    : null;

  const calendarRaw = activeEntry(raw.KnownCalendarSeasons, nowMs);
  const calendarSeason = calendarRaw
    ? {
        activation: deDate(calendarRaw.Activation),
        expiry: deDate(calendarRaw.Expiry),
        days: parseCalendarDays(calendarRaw.Days),
        // "CST_SUMMER" -> "Summer"; an unknown tag shows raw rather than empty.
        season: (calendarRaw.Season || "")
          .replace(/^CST_/, "")
          .toLowerCase()
          .replace(/^./, (c) => c.toUpperCase()),
      }
    : null;

  const dailyDeals = (raw.DailyDeals || [])
    .filter((d) => Number(d.Expiry?.["$date"]?.["$numberLong"] || 0) > nowMs)
    .map((d) => {
      const un = storeItemPath(d.StoreItem);
      return {
        uniqueName: un,
        item: resolveItemName(un),
        imageOverride: resolveBaroIcon(un),
        discount: d.Discount ?? 0,
        originalPrice: d.OriginalPrice ?? 0,
        salePrice: d.SalePrice ?? 0,
        total: d.AmountTotal ?? 0,
        sold: d.AmountSold ?? 0,
        expiry: deDate(d.Expiry),
      };
    });

  return {
    fissures: allFissures,
    voidTrader,
    vaultTrader,
    sortie,
    archonHunt,
    nightwave,
    descents,
    calendarSeason,
    alerts,
    steelPath: computeSteelPathHonors(),
    duviriCycle,
    earthCycle: null,
    cetusCycle: null,
    vallisCycle: null,
    cambionCycle: null,
    invasions: rawInvasions,
    bounties: rawBounties,
    dailyDeals,
  };
}
