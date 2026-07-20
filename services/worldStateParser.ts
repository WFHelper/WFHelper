import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import type { WorldStateRaw, WorldStateDate } from "./types/gameData";

import fs from "fs";
import path from "path";

import { WORLD_STATE_CONFIG } from "../config/runtime/worldState";
import { toIconMirrorUrl } from "./itemDatabase";
import { fetchJsonWithTimeout, fetchWithTimeout } from "./worldStateFetch";
import { computeSteelPathHonors } from "./worldStateSteelPath";

const log = withScope("worldStateParser");

const FETCH_URL = WORLD_STATE_CONFIG.fetchUrl;
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

const EMPTY_LOOKUP: Record<string, string> = Object.freeze({});

function loadRegionTranslationData(): { regions: Record<string, Record<string, unknown>>; dict: Record<string, string> } {
  try {
    const pep = require("warframe-public-export-plus");
    if (pep?.ExportRegions && pep?.dict_en) {
      return {
        regions: pep.ExportRegions as Record<string, Record<string, unknown>>,
        dict: pep.dict_en as Record<string, string>,
      };
    }
  } catch (err) {
    log.warn(
      "[WorldState] failed to load region data from package export:",
      normalizeErrorMessage(err),
    );
  }

  try {
    const pkgPath = require.resolve("warframe-public-export-plus/package.json");
    const pkgDir = path.dirname(pkgPath);
    const regions = JSON.parse(fs.readFileSync(path.join(pkgDir, "ExportRegions.json"), "utf8")) as Record<string, Record<string, unknown>>;
    const dict = JSON.parse(fs.readFileSync(path.join(pkgDir, "dict.en.json"), "utf8")) as Record<string, string>;
    return { regions, dict };
  } catch (err) {
    log.warn(
      "[WorldState] failed to load region data from disk fallback:",
      normalizeErrorMessage(err),
    );
  }

  return {
    regions: EMPTY_LOOKUP as unknown as Record<string, Record<string, unknown>>,
    dict: EMPTY_LOOKUP,
  };
}

const REGION_TRANSLATION = loadRegionTranslationData();

/** Lazy-loaded challenge lookup: maps Lotus challenge paths -> { requiredCount } from ExportChallenges */
let _challengeLookup: Record<string, { requiredCount?: number }> | null = null;
function getChallengeLookup(): Record<string, { requiredCount?: number }> {
  if (_challengeLookup) return _challengeLookup;
  _challengeLookup = {};
  try {
    const pep = require("warframe-public-export-plus");
    if (pep?.ExportChallenges && typeof pep.ExportChallenges === "object") {
      Object.assign(_challengeLookup, pep.ExportChallenges);
    }
  } catch {
    try {
      const pkgDir = path.dirname(require.resolve("warframe-public-export-plus/package.json"));
      const data = JSON.parse(fs.readFileSync(path.join(pkgDir, "ExportChallenges.json"), "utf8"));
      if (data && typeof data === "object") Object.assign(_challengeLookup, data);
    } catch {
      log.warn("[WorldState] failed to load challenge data");
    }
  }
  return _challengeLookup;
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
let _itemLookup: Record<string, { name?: string; era?: string; category?: string; resultType?: string }> | null = null;
function getItemLookup(): Record<string, { name?: string; era?: string; category?: string; resultType?: string }> {
  if (_itemLookup) return _itemLookup;
  _itemLookup = {};
  try {
    const pep = require("warframe-public-export-plus");
    for (const key of ["ExportResources", "ExportRecipes", "ExportUpgrades", "ExportGear", "ExportRelics", "ExportKeys"]) {
      const data = pep?.[key];
      if (data && typeof data === "object") {
        Object.assign(_itemLookup, data);
      }
    }
  } catch {
    try {
      const pkgDir = path.dirname(require.resolve("warframe-public-export-plus/package.json"));
      for (const file of ["ExportResources.json", "ExportRecipes.json", "ExportUpgrades.json", "ExportGear.json", "ExportRelics.json", "ExportKeys.json"]) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(pkgDir, file), "utf8"));
          if (data && typeof data === "object") Object.assign(_itemLookup, data);
        } catch { /* skip missing file */ }
      }
    } catch {
      log.warn("[WorldState] failed to load item data for invasion rewards");
    }
  }
  return _itemLookup;
}

/** Resolve a Lotus item path (e.g. /Lotus/Types/Items/...) to a display name */
function resolveItemName(itemPath: string): string {
  const items = getItemLookup();
  const entry = items[itemPath];
  if (entry?.name) {
    const resolved = resolveDictValue(entry.name);
    if (resolved) return resolved;
  }
  // Recipe fallback: resolve name via resultType (e.g. MummyQuestKeyBlueprint -> "Sands of Inaros Blueprint")
  if (entry?.resultType) {
    const result = items[entry.resultType];
    if (result?.name) {
      const resolved = resolveDictValue(result.name);
      if (resolved) return `${resolved} Blueprint`;
    }
  }
  // Relic fallback: ExportRelics entries have era + category but no name
  if (entry?.era && entry?.category) return `${entry.era} ${entry.category} Relic`;
  // Fallback: extract readable name from path slug
  const slug = itemPath.split("/").pop() || itemPath;
  const readable = slug.replace(/([a-z])([A-Z])/g, "$1 $2").trim();
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

const MISSION_TYPE: Record<string, string> = {
  MT_ARTIFACT: "Disruption",
  MT_ASSASSINATION: "Assassination",
  MT_CAPTURE: "Capture",
  MT_DEFENSE: "Defense",
  MT_ENDLESS_CAPTURE: "Endless Capture",
  MT_EXCAVATE: "Excavation",
  MT_EXCAVATION: "Excavation",
  MT_EXTERMINATION: "Extermination",
  MT_HIVE: "Hive",
  MT_INTERCEPTION: "Interception",
  MT_INTEL: "Spy",
  MT_LANDSCAPE: "Open World",
  MT_MOBILE_DEFENSE: "Mobile Defense",
  MT_NEST: "Defection",
  MT_PURIFY: "Disruption",
  MT_PURSUIT: "Pursuit",
  MT_RESCUE: "Rescue",
  MT_RETRIEVAL: "Hijack",
  MT_SABOTAGE: "Sabotage",
  MT_SECTOR: "Dark Sector",
  MT_SURVIVAL: "Survival",
  MT_TERRITORY: "Infested Salvage",
  MT_VOID_ARMAGEDDON: "Void Armageddon",
  MT_VOID_CASCADE: "Void Cascade",
  MT_VOID_FLOOD: "Void Flood",
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
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  if (!value.startsWith("/")) {
    return value;
  }
  return REGION_TRANSLATION.dict[value] || null;
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

function formatMissionTypeLabel(missionType: string, nodeId: string): string {
  if (MISSION_TYPE[missionType]) {
    return MISSION_TYPE[missionType];
  }
  const region = REGION_TRANSLATION.regions[nodeId];
  const missionName = resolveDictValue(region?.missionName);
  if (missionName) {
    return missionName;
  }
  if (typeof missionType === "string" && missionType.startsWith("MT_")) {
    return missionType
      .replace(/^MT_/, "")
      .toLowerCase()
      .replace(/(^|\s|_)\w/g, (c) => c.toUpperCase())
      .replace(/_/g, " ");
  }
  return missionType || "Unknown";
}

// Railjack void storms carry no MissionType in world state; the real type lives on
// the node's railjack mission (Survival, Volatile, Skirmish, ...). Dict labels are
// uppercase, so normalise to Title Case to match normal fissures. Falls back to
// "Railjack" for nodes we can't resolve.
function railjackMissionLabel(nodeId: string): string {
  const name = resolveDictValue(REGION_TRANSLATION.regions[nodeId]?.missionName);
  if (!name) return "Railjack";
  return name.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

function computeVallisCycle(nowMs: number = Date.now()): { isWarm: boolean; timeLeft: string; expiry: string } {
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
): { cetus: { isDay: boolean; timeLeft: string; expiry: string }; cambion: { active: string; timeLeft: string; expiry: string } } {
  const nightStart = bountyCycleExpiryMs - POE_NIGHT_MS;
  const isDay = nowMs < nightStart;
  const expiryIso = new Date(isDay ? nightStart : bountyCycleExpiryMs).toISOString();
  return {
    cetus: { isDay, timeLeft: "", expiry: expiryIso },
    cambion: { active: isDay ? "fass" : "vome", timeLeft: "", expiry: expiryIso },
  };
}

function computeDuviriMoodCycle(nowMs: number = Date.now()): { state: string; expiry: string; nextState: string } {
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

async function fetchEarthCycle(): Promise<{ isDay: boolean; timeLeft: string; expiry: string } | null> {
  try {
    const data = await fetchJsonWithTimeout(EARTH_CYCLE_URL, EARTH_CYCLE_FETCH_TIMEOUT_MS) as Record<string, unknown>;
    const earthData = (data && typeof data.earthCycle === "object" ? data.earthCycle : data) as Record<string, unknown> | null;

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

// The weekly Circuit reward rotation (normal + Steel Path "hard" incarnons) is
// not in DE's world state, and computeDuviriMoodCycle only derives the mood.
// warframestat's /pc/duviriCycle carries it. Returns [] on any failure so the
// Circuit panel just stays empty instead of breaking the world fetch.
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
  "Ostrons",         // CetusSyndicate
  "Solaris United",  // SolarisSyndicate
  "Entrati",         // EntratiSyndicate
  "The Holdfasts",   // ZarimanSyndicate
  "Cavia",           // EntratiLabSyndicate
  "The Hex",         // HexSyndicate
]);

const RAW_BOUNTY_SYNDICATES: Record<string, string> = {
  CetusSyndicate: "Ostrons",
  SolarisSyndicate: "Solaris United",
  EntratiSyndicate: "Entrati",
};

// These syndicates don't have Jobs in the raw world state - they're procedurally
// generated from a seed. oracle.browse.wf/bounty-cycle pre-computes the node
// assignments. Standing and enemy levels are static per tier index.
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
    standingTiers: [[1000, 1500], [2000, 3000], [3000, 4500], [4000, 6000], [5000, 7500]],
    levelTiers: [[50, 55], [60, 65], [70, 75], [90, 95], [110, 115]],
  },
  EntratiLabSyndicate: {
    displayName: "Cavia",
    standingTiers: [[1000, 1500], [2000, 3000], [3000, 4500], [4000, 6000], [5000, 7500]],
    levelTiers: [[55, 60], [65, 70], [75, 80], [95, 100], [115, 120]],
  },
  HexSyndicate: {
    displayName: "The Hex",
    standingTiers: [
      [1000, 1500], [2000, 3000], [3000, 4500], [4000, 6000],
      [5000, 7500], [6000, 9000], [7500, 11250],
    ],
    // In-game levels; DE's drop-table labels run 10 lower (pools are matched by tier index)
    levelTiers: [[65, 70], [75, 80], [85, 90], [95, 100], [105, 110], [115, 120], [125, 130]],
  },
};

interface WarframestatInvasion {
  id: string;
  node?: string;
  desc?: string;
  attacker?: { reward?: { items?: string[]; countedItems?: { count: number; type: string }[]; credits?: number }; faction?: string };
  defender?: { reward?: { items?: string[]; countedItems?: { count: number; type: string }[]; credits?: number }; faction?: string };
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
      .filter((sm) => BOUNTY_SYNDICATES.has(sm.syndicate || "") && Array.isArray(sm.jobs) && sm.jobs.length > 0)
      .map((sm) => ({
        syndicate: sm.syndicate || "",
        syndicateKey: sm.syndicateKey || "",
        expiry: sm.expiry || null,
        jobs: (sm.jobs || []).map((j) => ({
          type: j.type || "Unknown",
          enemyLevels: Array.isArray(j.enemyLevels) ? [j.enemyLevels[0] || 0, j.enemyLevels[1] || 0] : [0, 0],
          standingStages: j.standingStages || [],
          minMR: j.minMR || 0,
        })),
      }));
  } else if (syndicateRes.status === "rejected") {
    log.warn("[WorldState] syndicateMissions fetch failed:", normalizeErrorMessage(syndicateRes.reason));
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

/**
 * Resolve an oracle challenge path to a human-readable name and description.
 * Oracle paths like `/Lotus/Types/Challenges/Zariman/ZarimanFindMelicaCacheChallenge`
 * map to dict keys like `/Lotus/Language/Challenges/Challenge_ZarimanFindMelicaCacheChallenge_Desc`.
 */
function resolveChallengeInfo(
  challengePath: string,
  allyName?: string,
): { desc?: string } | null {
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
      const levels: [number, number] = config.levelTiers[index] ??
        [Number(region?.minEnemyLevel) || 0, Number(region?.maxEnemyLevel) || 0];
      // Oracle bounties are single-stage; standingTiers[index] is [base, bonus], not per-stage
      const standingPair = config.standingTiers[index] || [];
      const stages = standingPair.length > 0 ? [standingPair[0]] : [];

      // Resolve challenge name and description
      const allyName = resolveAllyName(job.ally);
      const challengeInfo = job.challenge
        ? resolveChallengeInfo(job.challenge, allyName)
        : null;

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

async function fetchAndComputeCycles(): Promise<Record<string, unknown>> {
  const nowMs = Date.now();

  // Vallis and Duviri mood are pure math - always available
  const vallisCycle = computeVallisCycle(nowMs);
  const duviriMood = computeDuviriMoodCycle(nowMs);

  // Fetch oracle bounty-cycle, earth cycle and Circuit choices in parallel
  const [oracleResult, earthResult, duviriChoicesResult] = await Promise.allSettled([
    fetchJsonWithTimeout(ORACLE_BOUNTY_CYCLE_URL, CYCLE_FETCH_TIMEOUT_MS) as Promise<BountyCycleResponse>,
    fetchEarthCycle(),
    fetchDuviriChoices(),
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
    log.warn("[WorldState] oracle bounty-cycle fetch failed:", normalizeErrorMessage(oracleResult.reason));
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

async function fetchPrimaryWorldState(): Promise<WorldStateRaw> {
  const raw = await fetchJsonWithTimeout(ORACLE_WORLDSTATE_URL, FETCH_TIMEOUT_MS) as WorldStateRaw;
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) {
    throw new Error("oracle returned empty object");
  }
  log.info("[WorldState] fetched oracle world-state OK");
  return raw;
}

async function fetchFallbackWorldState(): Promise<WorldStateRaw | null> {
  try {
    const resp = await fetchWithTimeout(FETCH_URL, FETCH_TIMEOUT_MS, {
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      log.warn("[WorldState] DE world-state returned HTTP", resp.status);
      return null;
    }
    const raw = await resp.json() as WorldStateRaw;
    log.info("[WorldState] fetched DE world-state OK");
    return raw;
  } catch (deErr) {
    log.warn("[WorldState] DE world-state also failed:", normalizeErrorMessage(deErr));
    return null;
  }
}

export async function fetchAndParse(): Promise<Record<string, unknown>> {
  let raw: WorldStateRaw | null;
  try {
    raw = await fetchPrimaryWorldState();
  } catch (oracleErr) {
    log.warn("[WorldState] oracle failed:", normalizeErrorMessage(oracleErr), "- trying DE direct");
    raw = await fetchFallbackWorldState();
    if (!raw) return emptyWorldState();
  }

  const parsed = parseRaw(raw);
  if (!parsed) return emptyWorldState();

  // Fetch cycles and warframestat extras in parallel
  const [cyclesResult, extrasResult] = await Promise.allSettled([
    fetchAndComputeCycles(),
    fetchWarframestatExtras(),
  ]);

  const cycles = cyclesResult.status === "fulfilled" ? cyclesResult.value : null;
  const extras = extrasResult.status === "fulfilled" ? extrasResult.value : null;

  if (cyclesResult.status === "rejected") {
    log.warn("[WorldState] planet cycle computation failed:", normalizeErrorMessage(cyclesResult.reason));
  }
  if (extrasResult.status === "rejected") {
    log.warn("[WorldState] warframestat extras failed:", normalizeErrorMessage(extrasResult.reason));
  }

  const nowMs = Date.now();
  const fallbackCycles = cycles || {
    vallisCycle: computeVallisCycle(nowMs),
    duviriCycle: computeDuviriMoodCycle(nowMs),
  };

  // Steel Path is computed locally (epoch-based rotation) - no external API needed
  const steelPath = computeSteelPathHonors();

  // Merge bounties from three sources:
  // 1. Raw world state (Ostrons/Solaris/Entrati - most reliable)
  // 2. Warframestat (same syndicates, fallback with nicer names)
  // 3. Bounty-cycle (seed-generated: Holdfasts/Cavia/Hex)
  const rawBounties = (parsed.bounties || []) as { syndicateKey?: string }[];
  const warframestatBounties = (extras?.bounties || []) as { syndicateKey?: string }[];
  const seedBounties = ((cycles?.bountyCycleBounties || []) as { syndicateKey?: string }[]);

  // Collect all display names already covered by raw bounties
  const rawDisplayNames = new Set(rawBounties.map((b) => RAW_BOUNTY_SYNDICATES[b.syndicateKey || ""]));
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
    invasions: (parsed.invasions as unknown[])?.length > 0 ? parsed.invasions : (extras?.invasions || []),
    bounties: allBounties,
    bountyRotation: (cycles as Record<string, unknown>)?.bountyRotation || undefined,
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
          const un = (i.ItemType || "").replace(/^\/Lotus\/StoreItems/, "/Lotus");
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
          uniqueName: (i.ItemType || "").replace(/^\/Lotus\/StoreItems/, "/Lotus"),
          item: (i.ItemType || "").split("/").pop() || "",
        })),
      }
    : null;

  const sortieArr = Array.isArray(raw.Sorties) ? raw.Sorties : raw.Sorties ? [raw.Sorties] : [];
  const sortieRaw =
    sortieArr.find((s) => Number(s.Expiry?.["$date"]?.["$numberLong"] || 0) > nowMs) ||
    sortieArr[0];
  const sortie = sortieRaw ? { expiry: deDate(sortieRaw.Expiry) } : null;

  const descentArr = Array.isArray(raw.Descents) ? raw.Descents : [];
  const descentRaw =
    descentArr.find((d) => {
      const act = Number(d.Activation?.["$date"]?.["$numberLong"] || 0);
      const exp = Number(d.Expiry?.["$date"]?.["$numberLong"] || 0);
      return act <= nowMs && exp > nowMs;
    }) || descentArr[0];

  const xpChoices = raw.EndlessXpChoices || [];
  const duviriCycle = {
    state: null as string | null,
    expiry: descentRaw ? deDate(descentRaw.Expiry) : null,
    choices: [
      {
        category: "normal",
        choices: xpChoices.find((c) => c.Category === "EXC_NORMAL")?.Choices || [],
      },
      {
        category: "hard",
        choices: xpChoices.find((c) => c.Category === "EXC_HARD")?.Choices || [],
      },
    ],
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
      jobs: sm.Jobs!.filter((j) => j.jobType).map((j) => {
        // Extract a short label from the Lotus path (e.g. "/Lotus/.../AttritionBountyExt" -> "Attrition Bounty")
        const slug = (j.jobType || "").split("/").pop() || "Unknown";
        const type = slug
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
      const completion = inv.Goal > 0
        ? Math.round((inv.Count / inv.Goal) * 1000) / 10
        : 0;

      function mapReward(reward?: { countedItems?: { ItemType: string; ItemCount: number }[]; credits?: number }) {
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

  const dailyDeals = (raw.DailyDeals || [])
    .filter((d) => Number(d.Expiry?.["$date"]?.["$numberLong"] || 0) > nowMs)
    .map((d) => {
      const un = (d.StoreItem || "").replace(/^\/Lotus\/StoreItems/, "/Lotus");
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
