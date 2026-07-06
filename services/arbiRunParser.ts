/**
 * Pure incremental EE.log parser for arbitration runs.
 * No fs/electron/Date.now - feed lines, get lifecycle events, finalize for stats.
 * Patterns and math ported from svesk.github.io/arbi (verified against its script.js).
 */

import type {
  ArbiMissionType,
  ArbiRunStats,
  ArbiSaturationBucket,
  ArbiWaveEntry,
} from "../config/shared/arbiTypes";
import { computeVitusModel } from "../config/shared/arbiMath";

const TS = /^[^\d]*(\d+\.\d+)/;
const MISSION_NAME = /Script \[Info\]: ThemedSquadOverlay\.lua: Mission name: (.*)/;
const SPAM_SKIP = /Game \[Warning\]:|DamagePct/;
const AGENT_CREATED = /OnAgentCreated/;
const AGENT_FULL = /OnAgentCreated.*?\/Npc\/(.+?)(\d+)\s+.*?MonitoredTicking\s+(\d+)/;
const AGENT_NPC_NAME = /\/Npc\/([A-Za-z0-9_]+)/;
const AGENT_EXCLUDE = /(Replicant|RJCrew|petavatar|VoidClone|Turret|Dropship|CatbrowPetAgent|AllyAgent)/i;
const DRONE = /OnAgentCreated.*?CorpusEliteShieldDroneAgent/;
const DEFENSE_REWARD = /Sys \[Info\]: Created \/Lotus\/Interface\/DefenseReward\.swf/;
// Survival rotations pop their own reward UI every 5 minutes.
const SURVIVAL_REWARD = /Sys \[Info\]: Created \/Lotus\/Interface\/SurvivalReward\.swf/;
const MONITORED_TICKING = /AI \[Info\]: .*?MonitoredTicking (\d+)/;
const WAVE_START_UNPAUSE = /WaveDefend\.lua: Starting wave (\d+)/;
const DEFENSE_WAVE = /WaveDefend\.lua: Defense wave: (\d+)/;
const SLEEP_BETWEEN = /WaveDefend\.lua: _SleepBetweenWaves/;
const SLEEP_BETWEEN_3 = /WaveDefend\.lua: _SleepBetweenWaves\(3\)/;
const WAVE_COUNTDOWN = /\/Lotus\/Interface\/ProjectionsCountdown\.swf/;
const TERRITORY = /Script \[Info\]: TerritoryMission\.lua/;
const TERRITORY_START = /TerritoryMission\.lua: .*(control|captured)/i;

// Mission select flows through squad-system lines carrying the internal sector
// name; a _EliteAlert suffix marks an arbitration regardless of UI language.
// All three fire before the Mission name line (Host loading fires after - skip it).
const PENDING_SECTOR_PLAIN = /(?:ThemedSquadOverlay\.lua: Pending mission:|MapRedux\.lua: Confirm sector) (\S+)/;
const PENDING_SECTOR_JSON = /Set squad mission.*?"name":"([^"]+)"/;
const ELITE_SECTOR = /^(SolNode\d+)_EliteAlert$/;

// Timestamped in-mission lines carrying the engine mission type (and node id).
const SYNC_CONSUMABLES = /SyncAutoPopulatedConsumables for mission (MT_[A-Z_]+) with location (\S+)/;
const STATE_STARTED = /Game \[Info\]: OnStateStarted, mission type=(MT_[A-Z_]+)/;

// Run-end markers, verified against real abort / quit-to-desktop / survival logs:
// - TopMenu Abort only fires on a CONFIRMED abort (the AbortMissionConfirm
//   dialog alone must not end the run - the player can pick No)
// - the EOM inventory commit fires whenever the local player's mission ends
//   (extraction, abort, quit-to-desktop alike)
// NOT used: EndOfMatch.lua Initialize (fires repeatedly IN-mission, seen 11s
// into a survival with "Mission Succeeded"); SS_STARTED->SS_ENDING (unclear
// whether it fires on the staying client during a host migration).
const ABORT_CONFIRMED = /TopMenu\.lua: Abort:/;
const EOM_COMMIT = /Sys \[Info\]: EOM missionLocationUnlocked=/;

/** Decorative agents that never tick are excluded, except these. */
const FORCED_VALID_AGENTS = new Set(["CorpusEliteShieldDroneAgent"]);

const REWARD_DEBOUNCE_SEC = 30;
/** Mirror Defense nodes run 2 waves per rotation instead of 3. */
const MIRROR_DEFENSE_NODES = ["munio", "tyana"];

const SATURATION_BUCKET_WIDTH = 3;
const SATURATION_MAX_COUNT = 30;
/** Tick-sample gaps longer than this are load screens/host stalls, not gameplay. */
const SATURATION_MAX_SEGMENT_SEC = 29;

type ArbiParserEvent =
  | {
      type: "run-start";
      missionName: string;
      node: string;
      missionType: ArbiMissionType;
      gameTimeSec: number;
    }
  | { type: "run-end"; reason: "mission-end" | "aborted" | "new-mission" };

export interface ArbiParsedRun {
  missionName: string;
  node: string;
  missionType: ArbiMissionType;
  missionTypeRaw: string | null;
  solNode: string | null;
  runStartSec: number;
  /** Timestamp of the end marker that closed the run; null when it ended implicitly. */
  runEndSec: number | null;
  lastActivitySec: number;
  durationSec: number;
  rotations: number;
  drones: number;
  totalEnemies: number;
  stats: ArbiRunStats | null;
}

export interface ArbiParser {
  feedLine(line: string): ArbiParserEvent | null;
  isRunActive(): boolean;
  lastActivitySec(): number;
  /** Monotonic count of combat events (spawns, drones, rewards, waves, tick samples)
   * in the active run. Freezes once the mission is over (orbiter lines don't count),
   * so the tracker can distinguish "mission still running" from "idling after it". */
  activityCount(): number;
  finalize(): ArbiParsedRun | null;
  reset(): void;
}

interface SpawnEvent {
  name: string | null;
  tick: number | null;
}

interface TickSample {
  t: number;
  val: number;
}

interface PauseInterval {
  start: number;
  end: number;
}

interface RunState {
  missionName: string;
  node: string;
  missionType: ArbiMissionType;
  /** Engine mission type (MT_*); once seen it outranks all name heuristics. */
  missionTypeRaw: string | null;
  solNode: string | null;
  wavesPerRotation: number;
  runStartSec: number;
  /** Timestamp of the StartRound game-state line (gameplay actually begins). */
  missionStartSec: number | null;
  runEndSec: number | null;
  lastActivitySec: number;
  eventCount: number;
  rotations: number;
  lastRewardSec: number;
  rewardTimestamps: number[];
  droneTimestamps: number[];
  spawnEvents: SpawnEvent[];
  tickSamples: TickSample[];
  pauseIntervals: PauseInterval[];
  currentPauseStart: number | null;
  waveStarts: Map<number, number>;
  waveEnds: number[];
  waveCountdowns: number[];
  preciseStartSec: number | null;
}

function classifyMission(missionName: string): {
  node: string;
  missionType: ArbiMissionType;
  wavesPerRotation: number;
} {
  // Both name shapes exist: legacy "Arbitration: Casta (Ceres)" and the current
  // "Oestrus (Eris) - Arbitration" suffix form.
  const node = missionName
    .replace("Arbitration:", "")
    .replace(/\s+-\s+Arbitration$/, "")
    .trim();
  const lower = node.toLowerCase();
  const isMirror = MIRROR_DEFENSE_NODES.some((m) => lower.includes(m));
  let missionType: ArbiMissionType = "other";
  if (lower.includes("defense") || isMirror) missionType = "defense";
  else if (lower.includes("interception")) missionType = "interception";
  return { node, missionType, wavesPerRotation: isMirror ? 2 : 3 };
}

function missionTypeFromRaw(mt: string): ArbiMissionType {
  if (mt === "MT_DEFENSE") return "defense";
  if (mt === "MT_TERRITORY") return "interception";
  return "other";
}

function applyMissionTypeRaw(run: RunState, mt: string): void {
  if (run.missionTypeRaw !== null) return;
  run.missionTypeRaw = mt;
  run.missionType = missionTypeFromRaw(mt);
}

function hasFullStats(run: RunState): boolean {
  return run.missionType === "defense" || run.missionType === "interception";
}

export function createArbiParser(): ArbiParser {
  let run: RunState | null = null;
  /** Internal sector of the most recent mission select (e.g. "SolNode167_EliteAlert"). */
  let pendingSector: string | null = null;

  function startRun(missionName: string, gameTimeSec: number): ArbiParserEvent {
    const { node, missionType, wavesPerRotation } = classifyMission(missionName);
    const sector = pendingSector !== null ? ELITE_SECTOR.exec(pendingSector) : null;
    // Consume the sector so a stale _EliteAlert can't mark a later mission as arbi.
    pendingSector = null;
    run = {
      missionName,
      node,
      missionType,
      missionTypeRaw: null,
      solNode: sector ? sector[1] : null,
      wavesPerRotation,
      runStartSec: gameTimeSec,
      missionStartSec: null,
      runEndSec: null,
      lastActivitySec: gameTimeSec,
      eventCount: 0,
      rotations: 0,
      lastRewardSec: 0,
      rewardTimestamps: [],
      droneTimestamps: [],
      spawnEvents: [],
      tickSamples: [],
      pauseIntervals: [],
      currentPauseStart: null,
      waveStarts: new Map(),
      waveEnds: [],
      waveCountdowns: [],
      preciseStartSec: null,
    };
    return { type: "run-start", missionName, node, missionType, gameTimeSec };
  }

  function feedLine(line: string): ArbiParserEvent | null {
    if (!line || SPAM_SKIP.test(line)) return null;

    const tsMatch = line.match(TS);
    const ts = tsMatch ? parseFloat(tsMatch[1]) : 0;

    const sector = line.match(PENDING_SECTOR_PLAIN) ?? line.match(PENDING_SECTOR_JSON);
    if (sector) pendingSector = sector[1];

    const mission = line.match(MISSION_NAME);
    if (mission) {
      const name = mission[1].trim();
      const isArbi =
        name.includes("Arbitration") ||
        (pendingSector !== null && ELITE_SECTOR.test(pendingSector));
      if (!run) {
        return isArbi ? startRun(name, ts) : null;
      }
      // Host-migration replay guard: the log can repeat the arbi mission-name
      // line with an older timestamp after a migration - not a new run.
      if (isArbi && ts > 0 && run.lastActivitySec > 0 && ts < run.lastActivitySec) return null;
      if (ts > 0) run.runEndSec = ts;
      return { type: "run-end", reason: "new-mission" };
    }

    if (!run) return null;

    if (ABORT_CONFIRMED.test(line)) {
      if (ts > 0) run.runEndSec = ts;
      return { type: "run-end", reason: "aborted" };
    }
    if (EOM_COMMIT.test(line)) {
      if (ts > 0) run.runEndSec = ts;
      return { type: "run-end", reason: "mission-end" };
    }

    const sync = line.match(SYNC_CONSUMABLES);
    if (sync) {
      applyMissionTypeRaw(run, sync[1]);
      if (run.solNode === null) run.solNode = sync[2];
    }
    const stateStarted = line.match(STATE_STARTED);
    if (stateStarted) {
      applyMissionTypeRaw(run, stateStarted[1]);
      if (run.missionStartSec === null && ts > 0) run.missionStartSec = ts;
    }

    // Pause bookkeeping (used to exclude between-wave downtime from saturation).
    if (SLEEP_BETWEEN.test(line) || DEFENSE_REWARD.test(line)) {
      run.eventCount++;
      if (run.currentPauseStart === null && ts > 0) run.currentPauseStart = ts;
    }
    let isUnpause = false;
    if (WAVE_START_UNPAUSE.test(line)) {
      run.eventCount++;
      if (run.missionType === "defense") isUnpause = true;
    }
    if (TERRITORY.test(line)) {
      run.eventCount++;
      if (run.missionTypeRaw === null && run.missionType === "other") {
        run.missionType = "interception";
        run.wavesPerRotation = 3;
      }
      isUnpause = true;
    }
    if (isUnpause && run.currentPauseStart !== null && ts > 0) {
      run.pauseIntervals.push({ start: run.currentPauseStart, end: ts });
      run.currentPauseStart = null;
    }

    const defWave = line.match(DEFENSE_WAVE);
    if (defWave) {
      // Wave lines outrank the mission-name heuristic (but not the engine MT_).
      run.eventCount++;
      if (run.missionTypeRaw === null) run.missionType = "defense";
      if (ts > 0) {
        run.waveStarts.set(parseInt(defWave[1], 10), ts);
        run.lastActivitySec = Math.max(run.lastActivitySec, ts);
        if (run.preciseStartSec === null && parseInt(defWave[1], 10) === 1) {
          run.preciseStartSec = ts;
        }
      }
    } else if (run.preciseStartSec === null && ts > 0 && TERRITORY_START.test(line)) {
      run.preciseStartSec = ts;
    }

    const isSurvivalReward = SURVIVAL_REWARD.test(line);
    if (isSurvivalReward) run.eventCount++;
    if (isSurvivalReward || DEFENSE_REWARD.test(line)) {
      if (ts - run.lastRewardSec > REWARD_DEBOUNCE_SEC) {
        run.rotations++;
        run.lastRewardSec = ts;
        run.rewardTimestamps.push(ts);
        run.lastActivitySec = Math.max(run.lastActivitySec, ts);
        if (run.currentPauseStart === null) run.currentPauseStart = ts;
      }
    }

    if (hasFullStats(run) && ts > 0) {
      const monitored = line.match(MONITORED_TICKING);
      if (monitored) {
        run.eventCount++;
        run.tickSamples.push({ t: ts, val: parseInt(monitored[1], 10) });
      }
    }

    if (DRONE.test(line)) {
      run.eventCount++;
      if (ts > 0) {
        run.droneTimestamps.push(ts);
        run.lastActivitySec = Math.max(run.lastActivitySec, ts);
      }
    } else if (AGENT_CREATED.test(line)) {
      run.eventCount++;
      if (!AGENT_EXCLUDE.test(line)) {
        const fullAgent = line.match(AGENT_FULL);
        if (fullAgent) {
          const tick = parseInt(fullAgent[3], 10);
          run.spawnEvents.push({ name: fullAgent[1], tick: Number.isNaN(tick) ? null : tick });
        } else {
          const npc = line.match(AGENT_NPC_NAME);
          run.spawnEvents.push({ name: npc ? npc[1] : null, tick: null });
        }
      }
    }

    if (SLEEP_BETWEEN_3.test(line) && ts > 0) run.waveEnds.push(ts);
    if (WAVE_COUNTDOWN.test(line) && ts > 0) {
      run.eventCount++;
      run.waveCountdowns.push(ts);
    }

    return null;
  }

  function countValidEnemies(spawns: SpawnEvent[]): number {
    // An agent name is confirmed ticking if any consecutive named pair shows its
    // tick counter advancing; names only ever seen non-advancing are decorative.
    const named = spawns.filter((s) => s.name !== null);
    const confirmed = new Set<string>();
    const suspected = new Set<string>();
    for (let i = 1; i < named.length; i++) {
      const prev = named[i - 1];
      const curr = named[i];
      if (prev.tick !== null && curr.tick !== null && prev.name) {
        if (curr.tick > prev.tick) confirmed.add(prev.name);
        else suspected.add(prev.name);
      }
    }
    const nonTicking = new Set(
      [...suspected].filter((n) => !confirmed.has(n) && !FORCED_VALID_AGENTS.has(n)),
    );
    let valid = 0;
    for (const s of spawns) {
      if (!s.name || !nonTicking.has(s.name)) valid++;
    }
    return valid;
  }

  function buildSaturation(r: RunState, startSec: number, endSec: number): ArbiSaturationBucket[] {
    const numBuckets = Math.ceil(SATURATION_MAX_COUNT / SATURATION_BUCKET_WIDTH);
    const seconds = new Array<number>(numBuckets).fill(0);
    let total = 0;
    for (let i = 0; i < r.tickSamples.length - 1; i++) {
      const cur = r.tickSamples[i];
      const next = r.tickSamples[i + 1];
      const segStart = Math.max(cur.t, startSec);
      const segEnd = Math.min(next.t, endSec);
      const dur = segEnd - segStart;
      if (dur <= 0 || dur > SATURATION_MAX_SEGMENT_SEC) continue;
      let paused = false;
      for (const p of r.pauseIntervals) {
        if ((segStart < p.start && segEnd > p.end) || (segStart >= p.start && segStart < p.end)) {
          paused = true;
          break;
        }
      }
      if (paused) continue;
      let idx = Math.floor(cur.val / SATURATION_BUCKET_WIDTH);
      if (idx >= numBuckets - 1) idx = numBuckets - 1;
      seconds[idx] += dur;
      total += dur;
    }
    return seconds.map((sec, i) => {
      const lo = i * SATURATION_BUCKET_WIDTH;
      const isLast = i === numBuckets - 1;
      return {
        minCount: lo,
        label: isLast ? `${lo}+` : `${lo}-${lo + SATURATION_BUCKET_WIDTH - 1}`,
        seconds: sec,
        pct: total > 0 ? (sec / total) * 100 : 0,
      };
    });
  }

  function buildWaves(r: RunState): ArbiWaveEntry[] {
    const waves = [...r.waveStarts.keys()].sort((a, b) => a - b);
    const out: ArbiWaveEntry[] = [];
    let endIdx = 0;
    let countdownIdx = 0;
    for (const wave of waves) {
      const start = r.waveStarts.get(wave);
      if (start === undefined) continue;
      while (endIdx < r.waveEnds.length && r.waveEnds[endIdx] <= start) endIdx++;
      let dur: number;
      if (wave % 3 === 0) {
        // Every 3rd wave has no sleep line; the reward countdown fires ~5s after clear.
        while (countdownIdx < r.waveCountdowns.length && r.waveCountdowns[countdownIdx] <= start) {
          countdownIdx++;
        }
        if (countdownIdx >= r.waveCountdowns.length) continue;
        dur = r.waveCountdowns[countdownIdx] - 5 - start;
        countdownIdx++;
      } else {
        if (endIdx >= r.waveEnds.length) continue;
        dur = r.waveEnds[endIdx] - start;
        endIdx++;
      }
      out.push({ index: wave, durationSec: dur });
    }
    return out;
  }

  function finalize(): ArbiParsedRun | null {
    if (!run) return null;
    const r = run;
    run = null;

    const drones = r.droneTimestamps.length;
    const validSpawns = countValidEnemies(r.spawnEvents);
    const totalEnemies = validSpawns + drones;

    const startSec =
      r.preciseStartSec ?? r.droneTimestamps[0] ?? r.missionStartSec ?? r.runStartSec;
    let durationSec = Math.max(0, r.lastActivitySec - startSec);
    // No combat activity was recorded (e.g. early abort) but the end marker
    // pins the real mission window.
    if (durationSec === 0 && r.runEndSec !== null) {
      durationSec = Math.max(0, r.runEndSec - startSec);
    }

    let stats: ArbiRunStats | null = null;
    if (hasFullStats(r)) {
      let avgDroneIntervalSec: number | null = null;
      if (drones > 1) {
        let sum = 0;
        for (let i = 1; i < r.droneTimestamps.length; i++) {
          sum += r.droneTimestamps[i] - r.droneTimestamps[i - 1];
        }
        avgDroneIntervalSec = sum / (drones - 1);
      }
      const model = computeVitusModel(r.rotations, r.wavesPerRotation, drones);
      stats = {
        killsPerDrone: drones > 0 ? totalEnemies / drones : 0,
        avgDroneIntervalSec,
        expectedVitusMean: model.mean,
        expectedVitusStd: model.std,
        vitusPerMin: durationSec > 0 ? model.mean / (durationSec / 60) : 0,
        wavesPerRotation: r.wavesPerRotation,
        droneTimestamps: r.droneTimestamps,
        rewardTimestamps: r.rewardTimestamps,
        preciseStartSec: r.preciseStartSec,
        lastActivitySec: r.lastActivitySec,
        saturationBuckets: buildSaturation(r, startSec, r.lastActivitySec),
        waves: r.missionType === "defense" ? buildWaves(r) : null,
      };
    }

    return {
      missionName: r.missionName,
      node: r.node,
      missionType: r.missionType,
      missionTypeRaw: r.missionTypeRaw,
      solNode: r.solNode,
      runStartSec: r.runStartSec,
      runEndSec: r.runEndSec,
      lastActivitySec: r.lastActivitySec,
      durationSec,
      rotations: r.rotations,
      drones,
      totalEnemies,
      stats,
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
      pendingSector = null;
    },
  };
}
