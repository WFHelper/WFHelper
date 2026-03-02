const log = require('./logger').withScope('worldStateParser');
"use strict";

/**
 * worldStateParser.js
 *
 * World-state data from two sources:
 *   1. oracle.browse.wf/worldState.json  — raw DE state, refreshed minutely
 *      (primary; falls back to content.warframe.com if unavailable)
 *   2. oracle.browse.wf/bounty-cycle     — bounty expiry timestamp
 *
 * Planet cycles are computed locally — the official DE world-state no longer
 * includes valid cycle timestamps in SyndicateMissions.
 *
 * Plains / Earth / Cambion Drift
 *   Source: browse.wf live.ts updateDayNightCycle()
 *   Night (Vome) = last 50 minutes of each bounty cycle (expiry − 3 000 000 ms)
 *   Day  (Fass)  = everything before that
 *
 * Orb Vallis
 *   Source: browse.wf live.ts updateVallis()
 *   EPOCH  = "November 10, 2018 08:13:48 UTC"
 *   Period = 1 600 s   (Warm: first 400 s, Cold: remaining 1 200 s)
 */

const FETCH_URL               = "https://content.warframe.com/dynamic/worldState.php";
const ORACLE_WORLDSTATE_URL   = "https://oracle.browse.wf/worldState.json";
const ORACLE_BOUNTY_CYCLE_URL = "https://oracle.browse.wf/bounty-cycle";
const FETCH_TIMEOUT_MS        = 20_000;
const CYCLE_FETCH_TIMEOUT_MS  =  4_000;

// Orb Vallis constants — from browse.wf live.ts updateVallis()
const VALLIS_EPOCH_MS  = new Date("November 10, 2018 08:13:48 UTC").getTime();
const VALLIS_PERIOD_MS = 1_600_000;   // 26 m 40 s total
const VALLIS_WARM_MS   =   400_000;   // warm phase = first 6 m 40 s

// Plains / Earth / Cambion night duration — browse.wf live.ts updateDayNightCycle()
const POE_NIGHT_MS = 3_000_000;       // night = last 50 min of each bounty cycle

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function emptyWorldState() {
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse DE's EJSON timestamp object → ISO-8601 string, or null. */
function deDate(obj) {
  if (!obj) return null;
  const ms = obj?.["$date"]?.["$numberLong"];
  return ms ? new Date(Number(ms)).toISOString() : null;
}

// ─── Lookup tables ────────────────────────────────────────────────────────────

/** ActiveMissions.Modifier → relic tier label */
const VOID_TIER = {
  VoidT1: "Lith",    VoidT2: "Meso",    VoidT3: "Neo",
  VoidT4: "Axi",     VoidT5: "Requiem", VoidT6: "Omnia",
  // Steel Path variants (modifier ends with "Hard")
  VoidT1Hard: "Lith",    VoidT2Hard: "Meso",    VoidT3Hard: "Neo",
  VoidT4Hard: "Axi",     VoidT5Hard: "Requiem", VoidT6Hard: "Omnia",
};

/** DE mission type key → human-readable name */
const MISSION_TYPE = {
  MT_CAPTURE:        "Capture",
  MT_EXTERMINATION:  "Exterminate",
  MT_MOBILE_DEFENSE: "Mobile Defense",
  MT_INTEL:          "Spy",
  MT_SABOTAGE:       "Sabotage",
  MT_SURVIVAL:       "Survival",
  MT_DEFENSE:        "Defense",
  MT_ASSAULT:        "Assault",
  MT_EXCAVATION:     "Excavation",
  MT_TERRITORY:      "Interception",
  MT_EVACUATION:     "Defection",
  MT_ARENA:          "Arena",
  MT_ARTIFACT:       "Void",
  MT_PURIFY:         "Disruption",
  MT_HIVE:           "Hive",
  MT_RETRIEVAL:      "Rescue",
  MT_EXTERMINATION:  "Exterminate",
};

/** Known relay hub node IDs → display names */
const HUB_NODE = {
  SaturnHUB:   "Saturn Relay",
  MarsHUB:     "Mars Relay",
  CerberusHUB: "Pluto Relay",
  EarthHUB:    "Earth Relay",
  VenusHUB:    "Venus Relay",
};

// ─── Fetch + parse ────────────────────────────────────────────────────────────

async function fetchJsonWithTimeout(url, timeoutMs = CYCLE_FETCH_TIMEOUT_MS) {
  const resp = await fetchWithTimeout(url, timeoutMs, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

/**
 * Compute Orb Vallis cycle from epoch math.
 * Source: browse.wf live.ts → updateVallis()
 */
function computeVallisCycle() {
  const nowMs      = Date.now();
  const elapsed    = (nowMs - VALLIS_EPOCH_MS) % VALLIS_PERIOD_MS;
  const isWarm     = elapsed < VALLIS_WARM_MS;
  const timeLeftMs = isWarm ? (VALLIS_WARM_MS - elapsed) : (VALLIS_PERIOD_MS - elapsed);
  return {
    isWarm,
    timeLeft: "",                                           // renderer computes from expiry
    expiry:   new Date(nowMs + timeLeftMs).toISOString(),
  };
}

/**
 * Compute Plains / Earth / Cambion Drift cycles from oracle bounty expiry.
 * Source: browse.wf live.ts → updateDayNightCycle()
 * Night starts POE_NIGHT_MS (50 min) before the bounty expiry.
 */
function computePoeCambionCycles(bountyCycleExpiryMs) {
  const nowMs      = Date.now();
  const nightStart = bountyCycleExpiryMs - POE_NIGHT_MS;
  const isDay      = nowMs < nightStart;
  const expiryIso  = new Date(isDay ? nightStart : bountyCycleExpiryMs).toISOString();
  return {
    earth:   { isDay, timeLeft: "", expiry: expiryIso },
    cetus:   { isDay, timeLeft: "", expiry: expiryIso },
    cambion: { active: isDay ? "fass" : "vome", timeLeft: "", expiry: expiryIso },
  };
}

/**
 * Fetch oracle bounty-cycle then compute all four planet cycles.
 */
async function fetchAndComputeCycles() {
  const data     = await fetchJsonWithTimeout(ORACLE_BOUNTY_CYCLE_URL, CYCLE_FETCH_TIMEOUT_MS);
  const expiryMs = Number(data.expiry);
  if (!expiryMs) throw new Error("oracle bounty-cycle: missing expiry");
  const { earth, cetus, cambion } = computePoeCambionCycles(expiryMs);
  return {
    earthCycle:   earth,
    cetusCycle:   cetus,
    vallisCycle:  computeVallisCycle(),
    cambionCycle: cambion,
  };
}

async function fetchAndParse() {
  // 1. Fetch raw world-state — oracle mirror first, then DE direct
  let raw = null;
  try {
    raw = await fetchJsonWithTimeout(ORACLE_WORLDSTATE_URL, FETCH_TIMEOUT_MS);
    if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0)
      throw new Error("oracle returned empty object");
    log.log("[WorldState] fetched oracle world-state OK");
  } catch (oracleErr) {
    log.warn("[WorldState] oracle failed:", oracleErr.message, "— trying DE direct");
    try {
      const resp = await fetchWithTimeout(FETCH_URL, FETCH_TIMEOUT_MS, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      raw = await resp.json();
      log.log("[WorldState] fetched DE world-state OK");
    } catch (deErr) {
      log.warn("[WorldState] DE world-state also failed:", deErr.message);
      return emptyWorldState();
    }
  }

  // 2. Parse the raw DE-format world-state (fissures, traders, sortie, duviri)
  const parsed = parseRaw(raw);

  // 3. Compute planet cycles from oracle bounty-cycle endpoint
  try {
    const cycles = await fetchAndComputeCycles();
    return { ...parsed, ...cycles };
  } catch (cycleErr) {
    log.warn("[WorldState] planet cycle computation failed:", cycleErr.message);
    return parsed;
  }
}

function parseRaw(raw) {
  if (!raw) return null;
  const nowMs = Date.now();

  // ─ Void Fissures ─────────────────────────────────────────────────────────
  const fissures = (raw.ActiveMissions || [])
    .filter(m => {
      const mod = m.Modifier || "";
      return mod.startsWith("VoidT") && VOID_TIER[mod];
    })
    .map(m => {
      const mod   = m.Modifier || "";
      const expMs = Number(m.Expiry?.["$date"]?.["$numberLong"] || 0);
      return {
        expiry:      expMs ? new Date(expMs).toISOString() : null,
        tier:        VOID_TIER[mod] || "Unknown",
        missionType: MISSION_TYPE[m.MissionType] || (m.MissionType || "").replace(/^MT_/, ""),
        node:        m.Node || "Unknown",
        isHard:      mod.endsWith("Hard"),
        expired:     expMs < nowMs,
      };
    })
    .filter(f => !f.expired);

  // ─ Baro Ki'Teer ──────────────────────────────────────────────────────────
  const baroRaw    = Array.isArray(raw.VoidTraders) ? raw.VoidTraders[0] : raw.VoidTraders;
  const voidTrader = baroRaw ? {
    activation: deDate(baroRaw.Activation),
    expiry:     deDate(baroRaw.Expiry),
    location:   HUB_NODE[baroRaw.Node] || baroRaw.Node || "Unknown",
  } : null;

  // ─ Varzia / Prime Resurgence ─────────────────────────────────────────────
  const varziaRaw  = Array.isArray(raw.PrimeVaultTraders) ? raw.PrimeVaultTraders[0] : raw.PrimeVaultTraders;
  const vaultTrader = varziaRaw ? {
    activation: deDate(varziaRaw.Activation),
    expiry:     deDate(varziaRaw.Expiry),
    location:   HUB_NODE[varziaRaw.Node] || varziaRaw.Node || "Varzia",
    // Map Manifest → inventory array the same shape as warframestat used
    inventory: (varziaRaw.Manifest || []).map(i => ({
      // Strip /StoreItems prefix so itemDb lookup (which uses /Lotus/...) can find it
      uniqueName: (i.ItemType || "").replace(/^\/Lotus\/StoreItems/, "/Lotus"),
      item:       (i.ItemType || "").split("/").pop() || "",
    })),
  } : null;

  // ─ Sortie ─────────────────────────────────────────────────────────────────
  const sortieArr = Array.isArray(raw.Sorties) ? raw.Sorties
    : raw.Sorties ? [raw.Sorties] : [];
  const sortieRaw = sortieArr.find(s =>
    Number(s.Expiry?.["$date"]?.["$numberLong"] || 0) > nowMs
  ) || sortieArr[0];
  const sortie = sortieRaw ? { expiry: deDate(sortieRaw.Expiry) } : null;

  // ─ Circuit (Duviri / Descents) ──────────────────────────────────────────
  const descentArr = Array.isArray(raw.Descents) ? raw.Descents : [];
  // Find the currently active descent window
  const descentRaw = descentArr.find(d => {
    const act = Number(d.Activation?.["$date"]?.["$numberLong"] || 0);
    const exp = Number(d.Expiry?.["$date"]?.["$numberLong"] || 0);
    return act <= nowMs && exp > nowMs;
  }) || descentArr[0];

  const xpChoices  = raw.EndlessXpChoices || [];
  const duviriCycle = descentRaw ? {
    state:   "active",
    expiry:  deDate(descentRaw.Expiry),
    choices: [
      { category: "normal", choices: xpChoices.find(c => c.Category === "EXC_NORMAL")?.Choices || [] },
      { category: "hard",   choices: xpChoices.find(c => c.Category === "EXC_HARD")?.Choices   || [] },
    ],
  } : null;

  // ─ Planet cycles ─────────────────────────────────────────────────────────
  // The raw DE world state endpoint does not expose open-world cycle timers.
  // They require a separate epoch-based computation or a different data source.
  // renderWorld() gracefully shows "Cycle data unavailable" when these are null.

  return {
    fissures,
    voidTrader,
    vaultTrader,
    sortie,
    steelPath:    null,   // no direct equivalent in raw DE data
    duviriCycle,
    earthCycle:   null,
    cetusCycle:   null,
    vallisCycle:  null,
    cambionCycle: null,
  };
}

module.exports = { fetchAndParse, parseRaw, emptyWorldState };
