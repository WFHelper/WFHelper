"use strict";

import { withScope } from "./logger";
const { normalizeErrorMessage } = require("../config/shared/errors.cjs") as {
  normalizeErrorMessage: (err: any) => string;
};

import fs from "fs";
import path from "path";

const { WORLD_STATE_CONFIG } = require("../config/runtime/worldState") as {
  WORLD_STATE_CONFIG: {
    fetchUrl: string;
    oracleWorldStateUrl: string;
    oracleBountyCycleUrl: string;
    earthCycleUrl: string;
    fetchTimeoutMs: number;
    cycleFetchTimeoutMs: number;
    earthCycleFetchTimeoutMs: number;
    vallisEpochIso: string;
    vallisPeriodMs: number;
    vallisWarmMs: number;
    poeNightMs: number;
    duviriMoodPeriodMs: number;
    duviriMoods: string[];
  };
};

const log = withScope("worldStateParser");

const FETCH_URL = WORLD_STATE_CONFIG.fetchUrl;
const ORACLE_WORLDSTATE_URL = WORLD_STATE_CONFIG.oracleWorldStateUrl;
const ORACLE_BOUNTY_CYCLE_URL = WORLD_STATE_CONFIG.oracleBountyCycleUrl;
const EARTH_CYCLE_URL = WORLD_STATE_CONFIG.earthCycleUrl;
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

const EMPTY_LOOKUP: Record<string, any> = Object.freeze({});

function loadRegionTranslationData(): { regions: Record<string, any>; dict: Record<string, any> } {
  try {
    const pep = require("warframe-public-export-plus");
    if (pep?.ExportRegions && pep?.dict_en) {
      return {
        regions: pep.ExportRegions,
        dict: pep.dict_en,
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
    const regions = JSON.parse(fs.readFileSync(path.join(pkgDir, "ExportRegions.json"), "utf8"));
    const dict = JSON.parse(fs.readFileSync(path.join(pkgDir, "dict.en.json"), "utf8"));
    return { regions, dict };
  } catch (err) {
    log.warn(
      "[WorldState] failed to load region data from disk fallback:",
      normalizeErrorMessage(err),
    );
  }

  return {
    regions: EMPTY_LOOKUP,
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
  };
}

function deDate(obj: any): string | null {
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
): Promise<any> {
  const resp = await fetchWithTimeout(url, timeoutMs, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

function resolveDictValue(value: any): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  if (!value.startsWith("/")) {
    return value;
  }
  return REGION_TRANSLATION.dict[value] || null;
}

function formatNodeLabel(nodeId: any): string {
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

function computeVallisCycle(nowMs: number = Date.now()): any {
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
): { cetus: any; cambion: any } {
  const nightStart = bountyCycleExpiryMs - POE_NIGHT_MS;
  const isDay = nowMs < nightStart;
  const expiryIso = new Date(isDay ? nightStart : bountyCycleExpiryMs).toISOString();
  return {
    cetus: { isDay, timeLeft: "", expiry: expiryIso },
    cambion: { active: isDay ? "fass" : "vome", timeLeft: "", expiry: expiryIso },
  };
}

function computeDuviriMoodCycle(nowMs: number = Date.now()): any {
  const moodIndex = Math.trunc(nowMs / DUVIRI_MOOD_PERIOD_MS);
  const moodStart = moodIndex * DUVIRI_MOOD_PERIOD_MS;
  const moodEnd = moodStart + DUVIRI_MOOD_PERIOD_MS;
  const state = DUVIRI_MOODS[moodIndex % DUVIRI_MOODS.length] || "Unknown";

  return {
    state,
    expiry: new Date(moodEnd).toISOString(),
  };
}

async function fetchEarthCycle(): Promise<any | null> {
  try {
    const data = await fetchJsonWithTimeout(EARTH_CYCLE_URL, EARTH_CYCLE_FETCH_TIMEOUT_MS);
    const earthData = data && typeof data.earthCycle === "object" ? data.earthCycle : data;

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

async function fetchAndComputeCycles(): Promise<any> {
  const nowMs = Date.now();
  const data = await fetchJsonWithTimeout(ORACLE_BOUNTY_CYCLE_URL, CYCLE_FETCH_TIMEOUT_MS);
  const expiryMs = Number(data.expiry);
  if (!expiryMs) throw new Error("oracle bounty-cycle: missing expiry");

  const { cetus, cambion } = computeCetusCambionCycles(expiryMs, nowMs);
  const earthCycle = await fetchEarthCycle();

  return {
    earthCycle: earthCycle || { isDay: cetus.isDay, timeLeft: "", expiry: cetus.expiry },
    cetusCycle: cetus,
    vallisCycle: computeVallisCycle(nowMs),
    cambionCycle: cambion,
    duviriCycle: computeDuviriMoodCycle(nowMs),
  };
}

async function fetchPrimaryWorldState(): Promise<any> {
  const raw = await fetchJsonWithTimeout(ORACLE_WORLDSTATE_URL, FETCH_TIMEOUT_MS);
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) {
    throw new Error("oracle returned empty object");
  }
  log.log("[WorldState] fetched oracle world-state OK");
  return raw;
}

async function fetchFallbackWorldState(): Promise<any | null> {
  try {
    const resp = await fetchWithTimeout(FETCH_URL, FETCH_TIMEOUT_MS, {
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      log.warn("[WorldState] DE world-state returned HTTP", resp.status);
      return null;
    }
    const raw = await resp.json();
    log.log("[WorldState] fetched DE world-state OK");
    return raw;
  } catch (deErr) {
    log.warn("[WorldState] DE world-state also failed:", normalizeErrorMessage(deErr));
    return null;
  }
}

export async function fetchAndParse(): Promise<any> {
  let raw: any;
  try {
    raw = await fetchPrimaryWorldState();
  } catch (oracleErr) {
    log.warn("[WorldState] oracle failed:", normalizeErrorMessage(oracleErr), "- trying DE direct");
    raw = await fetchFallbackWorldState();
    if (!raw) return emptyWorldState();
  }

  const parsed = parseRaw(raw);

  try {
    const cycles = await fetchAndComputeCycles();
    return {
      ...parsed,
      ...cycles,
      duviriCycle: {
        ...(parsed?.duviriCycle || {}),
        ...(cycles?.duviriCycle || {}),
      },
    };
  } catch (cycleErr) {
    log.warn("[WorldState] planet cycle computation failed:", normalizeErrorMessage(cycleErr));
    return parsed;
  }
}

export function parseRaw(raw: any): any {
  if (!raw) return null;
  const nowMs = Date.now();

  const fissures = (raw.ActiveMissions || [])
    .filter((m: any) => {
      const mod = m.Modifier || "";
      return mod.startsWith("VoidT") && VOID_TIER[mod];
    })
    .map((m: any) => {
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
    .filter((f: any) => !f.expired);

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
        inventory: (varziaRaw.Manifest || []).map((i: any) => ({
          uniqueName: (i.ItemType || "").replace(/^\/Lotus\/StoreItems/, "/Lotus"),
          item: (i.ItemType || "").split("/").pop() || "",
        })),
      }
    : null;

  const sortieArr = Array.isArray(raw.Sorties) ? raw.Sorties : raw.Sorties ? [raw.Sorties] : [];
  const sortieRaw =
    sortieArr.find((s: any) => Number(s.Expiry?.["$date"]?.["$numberLong"] || 0) > nowMs) ||
    sortieArr[0];
  const sortie = sortieRaw ? { expiry: deDate(sortieRaw.Expiry) } : null;

  const descentArr = Array.isArray(raw.Descents) ? raw.Descents : [];
  const descentRaw =
    descentArr.find((d: any) => {
      const act = Number(d.Activation?.["$date"]?.["$numberLong"] || 0);
      const exp = Number(d.Expiry?.["$date"]?.["$numberLong"] || 0);
      return act <= nowMs && exp > nowMs;
    }) || descentArr[0];

  const xpChoices = raw.EndlessXpChoices || [];
  const duviriCycle = {
    state: null,
    expiry: descentRaw ? deDate(descentRaw.Expiry) : null,
    choices: [
      {
        category: "normal",
        choices: xpChoices.find((c: any) => c.Category === "EXC_NORMAL")?.Choices || [],
      },
      {
        category: "hard",
        choices: xpChoices.find((c: any) => c.Category === "EXC_HARD")?.Choices || [],
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
  };
}
