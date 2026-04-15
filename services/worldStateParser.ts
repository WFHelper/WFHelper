import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import type { WorldStateRaw, WorldStateDate, ActiveMissionRaw, SortieRaw, DescentRaw, EndlessXpChoice } from "./types/gameData";

import fs from "fs";
import path from "path";

import { WORLD_STATE_CONFIG } from "../config/runtime/worldState";

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

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  options: Parameters<typeof fetch>[1] = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function emptyWorldState(): any {
  return {
    fissures: [],
    voidTrader: null,
    vaultTrader: null,
    sortie: null,
    steelPath: null,
    duviriCycle: null,
    earthCycle: null,
    cetusCycle: null,
    vallisCycle: null,
    cambionCycle: null,
    invasions: [],
    bounties: [],
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
  MT_CAPTURE: "Capture",
  MT_DEFENSE: "Defense",
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
  MT_VOID_CASCADE: "Void Cascade",
  MT_VOID_FLOOD: "Void Flood",
};

const HUB_NODE: Record<string, string> = {
  SaturnHUB: "Saturn Relay",
  MarsHUB: "Mars Relay",
  CerberusHUB: "Pluto Relay",
  EarthHUB: "Earth Relay",
  VenusHUB: "Venus Relay",
};

async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number = CYCLE_FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const resp = await fetchWithTimeout(url, timeoutMs, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

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
    return missionType.replace(/^MT_/, "");
  }
  return missionType || "Unknown";
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

function computeDuviriMoodCycle(nowMs: number = Date.now()): { state: string; expiry: string } {
  const moodIndex = Math.trunc(nowMs / DUVIRI_MOOD_PERIOD_MS);
  const moodStart = moodIndex * DUVIRI_MOOD_PERIOD_MS;
  const moodEnd = moodStart + DUVIRI_MOOD_PERIOD_MS;
  const state = DUVIRI_MOODS[moodIndex % DUVIRI_MOODS.length] || "Unknown";

  return {
    state,
    expiry: new Date(moodEnd).toISOString(),
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

// ─── Bounty syndicates worth showing (have open-world jobs) ────────────────
const BOUNTY_SYNDICATES = new Set([
  "Ostrons",         // CetusSyndicate
  "Solaris United",  // SolarisSyndicate
  "Entrati",         // EntratiSyndicate
  "The Holdfasts",   // ZarimanSyndicate
  "Cavia",           // EntratiLabSyndicate
  "The Hex",         // HexSyndicate
]);

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

interface WarframestatSteelPath {
  currentReward?: { name?: string; cost?: number };
  activation?: string;
  expiry?: string;
  rotation?: { name?: string; cost?: number }[];
  evergreens?: { name?: string; cost?: number }[];
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
  steelPath: unknown;
  bounties: unknown[];
}> {
  const result = { invasions: [] as unknown[], steelPath: null as unknown, bounties: [] as unknown[] };

  const [invasionsRes, steelPathRes, syndicateRes] = await Promise.allSettled([
    fetchJsonWithTimeout(`${WARFRAMESTAT_BASE_URL}/invasions`, CYCLE_FETCH_TIMEOUT_MS),
    fetchJsonWithTimeout(`${WARFRAMESTAT_BASE_URL}/steelPath`, CYCLE_FETCH_TIMEOUT_MS),
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

  // Steel Path
  if (steelPathRes.status === "fulfilled" && steelPathRes.value && typeof steelPathRes.value === "object") {
    const sp = steelPathRes.value as WarframestatSteelPath;
    result.steelPath = {
      currentReward: {
        name: sp.currentReward?.name || "Unknown",
        cost: sp.currentReward?.cost || 0,
      },
      activation: sp.activation || null,
      expiry: sp.expiry || null,
      rotation: (sp.rotation || []).map((r) => ({ name: r.name || "", cost: r.cost || 0 })),
      evergreens: (sp.evergreens || []).map((e) => ({ name: e.name || "", cost: e.cost || 0 })),
    };
  } else if (steelPathRes.status === "rejected") {
    log.warn("[WorldState] steelPath fetch failed:", normalizeErrorMessage(steelPathRes.reason));
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

async function fetchAndComputeCycles(): Promise<Record<string, unknown>> {
  const nowMs = Date.now();

  // Vallis and Duviri are pure math — always available
  const vallisCycle = computeVallisCycle(nowMs);
  const duviriCycle = computeDuviriMoodCycle(nowMs);

  // Fetch oracle bounty-cycle and earth cycle in parallel (avoids 4s+4s sequential wait)
  const [oracleResult, earthResult] = await Promise.allSettled([
    fetchJsonWithTimeout(ORACLE_BOUNTY_CYCLE_URL, CYCLE_FETCH_TIMEOUT_MS) as Promise<{ expiry?: number }>,
    fetchEarthCycle(),
  ]);

  let cetusCycle: { isDay: boolean; timeLeft: string; expiry: string } | null = null;
  let cambionCycle: { active: string; timeLeft: string; expiry: string } | null = null;
  if (oracleResult.status === "fulfilled") {
    const expiryMs = Number(oracleResult.value.expiry);
    if (expiryMs) {
      const { cetus, cambion } = computeCetusCambionCycles(expiryMs, nowMs);
      cetusCycle = cetus;
      cambionCycle = cambion;
    }
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
  };
}

async function fetchPrimaryWorldState(): Promise<WorldStateRaw> {
  const raw = await fetchJsonWithTimeout(ORACLE_WORLDSTATE_URL, FETCH_TIMEOUT_MS) as WorldStateRaw;
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) {
    throw new Error("oracle returned empty object");
  }
  log.log("[WorldState] fetched oracle world-state OK");
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
    log.log("[WorldState] fetched DE world-state OK");
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

  // Use steelPath from warframestat (has currentReward + rotation) if available
  const steelPath = extras?.steelPath || parsed.steelPath || null;

  return {
    ...parsed,
    ...fallbackCycles,
    duviriCycle: {
      ...(parsed?.duviriCycle || {}),
      ...(fallbackCycles?.duviriCycle || {}),
    },
    steelPath,
    invasions: extras?.invasions || [],
    bounties: extras?.bounties || [],
  };
}

export function parseRaw(raw: WorldStateRaw | null): Record<string, unknown> {
  if (!raw) return null as unknown as Record<string, unknown>;
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

  const baroRaw = Array.isArray(raw.VoidTraders) ? raw.VoidTraders[0] : raw.VoidTraders;
  const voidTrader = baroRaw
    ? {
        activation: deDate(baroRaw.Activation),
        expiry: deDate(baroRaw.Expiry),
        location: HUB_NODE[baroRaw.Node] || baroRaw.Node || "Unknown",
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

  return {
    fissures,
    voidTrader,
    vaultTrader,
    sortie,
    steelPath: null,
    duviriCycle,
    earthCycle: null,
    cetusCycle: null,
    vallisCycle: null,
    cambionCycle: null,
    invasions: [],
    bounties: [],
  };
}