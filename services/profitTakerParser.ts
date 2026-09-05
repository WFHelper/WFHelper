import { EE_LOG_LINE_TS } from "./arbiRunParser";
import { stripPlatformGlyphs } from "./tradeLogSanitize";
import type {
  PtElement,
  PtLeg,
  PtLegBreak,
  PtPhase,
  PtRunEndReason,
  PtShieldChange,
} from "../config/shared/profitTakerTypes";

/** Only BountyFour is the orb fight; One/Two/Three are the earlier heist phases. */
const JOB_BOUNTY_FOUR = "/Lotus/Types/Gameplay/Venus/Jobs/Heists/HeistProfitTakerBountyFour";
const ACTIVE_JOB = "ThemedSquadOverlay.lua: Active jobId set to ";
const SESSION_MAP = "EidolonMP.lua: Session map string: ";
const ELEVATOR_EXIT = "EidolonMP.lua: EIDOLONMP: Avatar left the zone";
const BACK_TO_TOWN = "EidolonMP.lua: EIDOLONMP: TryTownTransition";
const JOB_START = "EidolonMissions.lua - Starting job PROFIT-TAKER";
const ABORT_MISSION = "GameRulesImpl - changing state from SS_STARTED to SS_ENDING";
const EOM_COMMIT = "Sys [Info]: EOM missionLocationUnlocked=";
const HOST_MIGRATION = `"jobId" : "${JOB_BOUNTY_FOUR}`;

const ORB_FIGHT = "CamperHeistOrbFight.lua: ";
const PHASE_STARTS: ReadonlyArray<readonly [string, 1 | 2 | 3 | 4]> = [
  ["Orb Fight - Starting first attack Orb phase", 1],
  ["Orb Fight - Starting second attack Orb phase", 2],
  ["Orb Fight - Starting third attack Orb phase", 3],
  ["Orb Fight - Starting final attack Orb phase", 4],
];
const STATE_CHANGE = "Landscape - New State: ";
const BODY_KILL_STATES = new Set([3, 5, 6]);

const CAMPER = "Camper->";
const SHIELD_SWITCH =
  "SwitchShieldVulnerability() - Switching shield damage vulnerability type to ";
const LEG_KILL = "Leg freshly destroyed at part: ";
const BODY_VULNERABLE = "StartVulnerable() - The Camper can now be damaged!";
const PYLONS_LAUNCHED = "ArachnoidCamperScript.lua: Pylon launch complete";

/** Shield phases close on a transmission load; phase 2 has no shield phase. */
const RESOURCE_LOADER = "Sys [Info]: ResourceLoader";
const SHIELD_END_IDS = [
  "DBntyFourInterPrTk0920TheBusiness",
  "DBntyFourInterPrTk0890TheBusiness",
  "DBntyFourSatelReal0930TheBusiness",
];

const LOADOUT_LOADED = /Game \[Info\]: (.+?) loadout loader finished/;

const ELEMENTS: Readonly<Record<string, PtElement>> = {
  DT_IMPACT: "impact",
  DT_PUNCTURE: "puncture",
  DT_SLASH: "slash",
  DT_FREEZE: "cold",
  DT_FIRE: "heat",
  DT_POISON: "toxin",
  DT_ELECTRICITY: "electric",
  DT_GAS: "gas",
  DT_VIRAL: "viral",
  DT_MAGNETIC: "magnetic",
  DT_RADIATION: "radiation",
  DT_CORROSIVE: "corrosive",
  DT_EXPLOSION: "blast",
};

/** The log names legs from the orb's view; players call them the other way round. */
const LEGS: Readonly<Record<string, PtLeg>> = {
  ARM_RIGHT: "frontLeft",
  ARM_LEFT: "frontRight",
  LEG_RIGHT: "backLeft",
  LEG_LEFT: "backRight",
};

type PtParserEvent =
  | { type: "run-start"; gameTimeSec: number }
  | { type: "run-end"; reason: PtRunEndReason };

export interface PtParsedRun {
  /** A `Session map string` line proved this is a real Profit-Taker mission. */
  confirmed: boolean;
  /** Flight start (last elevator exit, or the job-start line as fallback). */
  runStartSec: number;
  runEndSec: number | null;
  lastActivitySec: number;
  durationSec: number;
  flightSec: number;
  flightUnreliable: boolean;
  shieldSec: number;
  legSec: number;
  bodySec: number;
  pylonSec: number;
  phases: PtPhase[];
  players: string[];
  complete: boolean;
  bugged: boolean;
  aborted: boolean;
  hostMigration: boolean;
  /** False for client-side runs: only the host logs the `Camper->` AI lines. */
  hostTelemetry: boolean;
}

interface PtParser {
  feedLine(line: string): PtParserEvent | null;
  isRunActive(): boolean;
  lastActivitySec(): number;
  /** Monotonic fight-event count; hub chatter cannot keep a capture alive. */
  activityCount(): number;
  finalize(): PtParsedRun | null;
  reset(): void;
}

interface PhaseState {
  index: 1 | 2 | 3 | 4;
  startSec: number;
  shields: PtShieldChange[];
  legs: PtLegBreak[];
  bodyVulnerableSec: number | null;
  bodyKillSec: number | null;
  pylonLaunchSec: number | null;
}

interface RunState {
  confirmed: boolean;
  capturedAtSec: number;
  flightStartSec: number | null;
  flightUnreliable: boolean;
  jobStartSec: number | null;
  phase1StartSec: number | null;
  lastActivitySec: number;
  eventCount: number;
  players: string[];
  phases: PtPhase[];
  current: PhaseState;
  previousElement: string | null;
  previousTime: number;
  shieldPhaseEnded: boolean;
  killSequence: number;
  /** Set when pylons launch in phase 3; a second shield line then means phase 4. */
  pylonCheck: boolean;
  shieldCount: number;
  runEndSec: number | null;
  /** Latched so a caller that keeps feeding after the end event cannot double-submit. */
  ended: boolean;
  complete: boolean;
  bugged: boolean;
  aborted: boolean;
  hostMigration: boolean;
  hostTelemetry: boolean;
}

function newPhase(index: 1 | 2 | 3 | 4, startSec: number): PhaseState {
  return {
    index,
    startSec,
    shields: [],
    legs: [],
    bodyVulnerableSec: null,
    bodyKillSec: null,
    pylonLaunchSec: null,
  };
}

function sumSeconds(entries: ReadonlyArray<{ seconds: number }>): number {
  let total = 0;
  for (const entry of entries) total += entry.seconds;
  return total;
}

export function createProfitTakerParser(): PtParser {
  let run: RunState | null = null;

  function startRun(gameTimeSec: number, confirmed: boolean): PtParserEvent {
    run = {
      confirmed,
      capturedAtSec: gameTimeSec,
      flightStartSec: null,
      flightUnreliable: false,
      jobStartSec: null,
      phase1StartSec: null,
      lastActivitySec: gameTimeSec,
      eventCount: 0,
      players: [],
      phases: [],
      // Shield and leg events before the phase-1 line belong to phase 1, exactly
      // as the reference analyser accumulates them into its phase-0 placeholder.
      current: newPhase(1, gameTimeSec),
      previousElement: null,
      previousTime: 0,
      shieldPhaseEnded: false,
      killSequence: 0,
      pylonCheck: false,
      shieldCount: 0,
      runEndSec: null,
      ended: false,
      complete: false,
      bugged: false,
      aborted: false,
      hostMigration: false,
      hostTelemetry: false,
    };
    return { type: "run-start", gameTimeSec };
  }

  function endRun(r: RunState, ts: number, reason: PtRunEndReason): PtParserEvent {
    if (ts > 0) r.runEndSec = ts;
    r.ended = true;
    return { type: "run-end", reason };
  }

  /** Close the running phase and open the next one at `endSec`. */
  function submitPhase(r: RunState, endSec: number): void {
    const p = r.current;
    const bodySec =
      p.bodyVulnerableSec !== null && p.bodyKillSec !== null
        ? Math.max(0, p.bodyKillSec - p.bodyVulnerableSec)
        : 0;
    // A bugged phase 3 ends on a guessed marker, so its pylon window is garbage.
    const countsPylons = p.index === 1 || (p.index === 3 && !r.bugged);
    const pylonSec =
      countsPylons && p.pylonLaunchSec !== null ? Math.max(0, endSec - p.pylonLaunchSec) : 0;
    r.phases.push({
      index: p.index,
      totalSec: Math.max(0, endSec - p.startSec),
      shieldSec: sumSeconds(p.shields),
      legSec: sumSeconds(p.legs),
      bodySec,
      pylonSec,
      shields: p.shields,
      legs: p.legs,
    });
    r.previousTime = endSec;
    r.killSequence = 0;
    const next = p.index < 4 ? ((p.index + 1) as 1 | 2 | 3 | 4) : 4;
    r.current = newPhase(next, endSec);
  }

  function pushShieldChange(r: RunState, ts: number, element: string): void {
    r.current.shields.push({ element, seconds: Math.max(0, ts - r.previousTime) });
    r.previousTime = ts;
  }

  function handleShieldLine(r: RunState, line: string, ts: number, isSwitch: boolean): void {
    // Bugged log: phase 4 never announced itself, so the second shield line after
    // the phase-3 pylons stands in for it.
    if (r.current.index === 3 && r.pylonCheck && r.shieldCount > 0) {
      r.bugged = true;
      r.previousTime = ts;
      r.shieldPhaseEnded = false;
      submitPhase(r, ts);
    } else {
      r.shieldCount++;
    }

    if (isSwitch) {
      const token = line.slice(line.indexOf(SHIELD_SWITCH) + SHIELD_SWITCH.length).trim();
      const element = ELEMENTS[token] ?? token.toLowerCase();
      if (!r.shieldPhaseEnded) {
        if (r.previousElement === null) {
          r.previousElement = element;
          // Phase 3 measures its first shield from the phase start instead.
          if (r.current.index !== 3) r.previousTime = ts;
          return;
        }
        if (r.phases.length === 0 && r.current.shields.length === 0) {
          r.previousTime = r.phase1StartSec ?? r.flightStartSec ?? 0;
        }
        pushShieldChange(r, ts, r.previousElement);
        r.previousElement = element;
        return;
      }
      // Shields keep switching during the phase-3 pylons; only the element carries over.
      if (r.current.index === 3) r.previousElement = element;
      return;
    }

    if (r.current.shields.length === 0 || r.shieldPhaseEnded || r.previousElement === null) return;
    pushShieldChange(r, ts, r.previousElement);
    r.shieldPhaseEnded = true;
    r.previousElement = null;
  }

  function handleCamperLine(r: RunState, line: string, ts: number): void {
    r.hostTelemetry = true;
    if (line.includes(SHIELD_SWITCH)) {
      r.eventCount++;
      handleShieldLine(r, line, ts, true);
      return;
    }
    if (line.includes(LEG_KILL)) {
      r.eventCount++;
      const part = line.slice(line.indexOf(LEG_KILL) + LEG_KILL.length).trim();
      const leg = LEGS[part];
      if (leg) {
        r.current.legs.push({ leg, seconds: Math.max(0, ts - r.previousTime) });
        if (r.current.legs.length > 4) r.bugged = true;
      }
      r.previousTime = ts;
      r.shieldCount = 0;
      return;
    }
    if (line.includes(BODY_VULNERABLE)) {
      r.eventCount++;
      if (r.killSequence === 0) r.current.bodyVulnerableSec = ts;
      r.killSequence++;
    }
  }

  function handleOrbFightLine(r: RunState, line: string, ts: number): void {
    const stateIdx = line.indexOf(STATE_CHANGE);
    if (stateIdx >= 0) {
      const state = parseInt(line.slice(stateIdx + STATE_CHANGE.length), 10);
      if (BODY_KILL_STATES.has(state)) r.current.bodyKillSec = ts;
      return;
    }
    for (const [marker, index] of PHASE_STARTS) {
      if (!line.includes(marker)) continue;
      r.eventCount++;
      if (index === 1) {
        r.phase1StartSec = ts;
        r.current.startSec = ts;
        return;
      }
      if (index === 3) r.shieldPhaseEnded = false;
      if (index === 4) {
        r.pylonCheck = false;
        r.shieldPhaseEnded = false;
      }
      submitPhase(r, ts);
      return;
    }
  }

  function feedLine(line: string): PtParserEvent | null {
    if (!line) return null;

    const tsMatch = line.match(EE_LOG_LINE_TS);
    const ts = tsMatch ? parseFloat(tsMatch[1]) : 0;

    if (run?.ended) return null;

    if (line.includes(ACTIVE_JOB)) {
      const isFour = line.includes(JOB_BOUNTY_FOUR);
      if (!run) return isFour ? startRun(ts, false) : null;
      // Picking another bounty while only armed means the capture was a false start.
      if (!run.confirmed && !isFour) return endRun(run, ts, "aborted");
      return null;
    }

    if (line.includes(SESSION_MAP)) {
      const isFour = line.includes(JOB_BOUNTY_FOUR);
      if (!run) return isFour ? startRun(ts, true) : null;
      if (!run.confirmed) {
        if (isFour) {
          run.confirmed = true;
          run.lastActivitySec = ts;
          return null;
        }
        return endRun(run, ts, "aborted");
      }
      return endRun(run, ts, isFour ? "new-run" : "mission-end");
    }

    if (!run) return null;
    const r = run;

    if (ts > 0) r.lastActivitySec = Math.max(r.lastActivitySec, ts);

    if (line.includes(CAMPER)) {
      handleCamperLine(r, line, ts);
    } else if (line.includes(ORB_FIGHT)) {
      handleOrbFightLine(r, line, ts);
    } else if (line.includes(PYLONS_LAUNCHED)) {
      r.eventCount++;
      r.current.pylonLaunchSec = ts;
      if (r.current.index === 3) {
        r.pylonCheck = true;
        // Only shield lines after the launch feed the bugged-phase-4 guess.
        r.shieldCount = 0;
      }
    } else if (line.includes(RESOURCE_LOADER)) {
      if (SHIELD_END_IDS.some((id) => line.includes(id))) handleShieldLine(r, line, ts, false);
    } else if (line.includes(ELEVATOR_EXIT)) {
      if (r.phase1StartSec === null) r.flightStartSec = ts;
    } else if (line.includes(JOB_START)) {
      r.jobStartSec = ts;
    } else if (line.includes("loadout loader finished")) {
      const loadout = line.match(LOADOUT_LOADED);
      // Warframe appends a platform glyph to the name in this line.
      const player = loadout ? stripPlatformGlyphs(loadout[1]) : "";
      if (player && !r.players.includes(player)) r.players.push(player);
    } else if (line.includes(HOST_MIGRATION)) {
      r.hostMigration = true;
    }

    if (line.includes(ABORT_MISSION) || line.includes(BACK_TO_TOWN)) {
      r.aborted = true;
      return endRun(r, ts, "aborted");
    }
    // Three vulnerability windows in one phase means the orb died.
    if (r.killSequence === 3) {
      r.current.bodyKillSec = ts;
      r.complete = true;
      submitPhase(r, ts);
      return endRun(r, ts, "completed");
    }
    if (line.includes(EOM_COMMIT)) return endRun(r, ts, "mission-end");

    return null;
  }

  function finalize(): PtParsedRun | null {
    if (!run) return null;
    const r = run;
    run = null;

    const flightUnreliable = r.flightStartSec === null;
    const flightStartSec = r.flightStartSec ?? r.jobStartSec ?? r.capturedAtSec;
    const flightSec =
      r.phase1StartSec !== null ? Math.max(0, r.phase1StartSec - flightStartSec) : 0;
    const phaseTotal = r.phases.reduce((sum, p) => sum + p.totalSec, 0);

    return {
      confirmed: r.confirmed,
      runStartSec: flightStartSec,
      runEndSec: r.runEndSec,
      lastActivitySec: r.lastActivitySec,
      durationSec: flightSec + phaseTotal,
      flightSec,
      flightUnreliable: flightUnreliable && r.phase1StartSec !== null,
      shieldSec: r.phases.reduce((sum, p) => sum + p.shieldSec, 0),
      legSec: r.phases.reduce((sum, p) => sum + p.legSec, 0),
      bodySec: r.phases.reduce((sum, p) => sum + p.bodySec, 0),
      pylonSec: r.phases.reduce((sum, p) => sum + p.pylonSec, 0),
      phases: r.phases,
      players: r.players,
      complete: r.complete,
      bugged: r.bugged,
      aborted: r.aborted,
      hostMigration: r.hostMigration,
      hostTelemetry: r.hostTelemetry,
    };
  }

  return {
    feedLine,
    isRunActive: () => run !== null,
    lastActivitySec: () => run?.lastActivitySec ?? 0,
    activityCount: () => run?.eventCount ?? 0,
    finalize,
    reset: () => {
      run = null;
    },
  };
}
