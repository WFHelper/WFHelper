import type {
  ArbiInterval,
  ArbiMissionType,
  ArbiRunStats,
  ArbiSaturationBucket,
  ArbiSpawnPoint,
  ArbiWaveEntry,
} from "../config/shared/arbiTypes";
import { ARBI_EARLY_WAVE_CAP, ARBI_SPAWN_DATA_VERSION } from "../config/shared/arbiTypes";
import { ARBI_SATURATION_THRESHOLD, computeVitusModel } from "../config/shared/arbiMath";

export const EE_LOG_LINE_TS = /^[^\d]*(\d+\.\d+)/;
const MISSION_NAME = /Script \[Info\]: ThemedSquadOverlay\.lua: Mission name: (.*)/;
const SPAM_SKIP = /Game \[Warning\]:|DamagePct/;
const AGENT_CREATED = /OnAgentCreated/;
const AGENT_FULL = /OnAgentCreated.*?\/Npc\/(.+?)(\d+)\s+.*?MonitoredTicking\s+(\d+)/;
const AGENT_NPC_NAME = /\/Npc\/([A-Za-z0-9_]+)/;
const AGENT_EXCLUDE =
  /(Replicant|RJCrew|petavatar|VoidClone|Turret|Dropship|CatbrowPetAgent|AllyAgent)/i;
const DRONE = /OnAgentCreated.*?CorpusEliteShieldDroneAgent/;
const DEFENSE_REWARD = /Sys \[Info\]: Created \/Lotus\/Interface\/DefenseReward\.swf/;
// Survival rotations pop their own reward UI every 5 minutes.
const SURVIVAL_REWARD = /Sys \[Info\]: Created \/Lotus\/Interface\/SurvivalReward\.swf/;
const MONITORED_TICKING = /AI \[Info\]: .*?MonitoredTicking (\d+)/;
const WAVE_START_UNPAUSE = /WaveDefend\.lua: Starting wave (\d+)/;
const DEFENSE_WAVE = /WaveDefend\.lua: Defense wave: (\d+)/;
const SLEEP_BETWEEN = /WaveDefend\.lua: _SleepBetweenWaves/;
const SLEEP_BETWEEN_3 = /WaveDefend\.lua: _SleepBetweenWaves\(3\)/;
// Host-only defense line; the vector after "spawn point:" is the point, not the NPC.
const SPAWN_POINT =
  /WaveDefend\.lua: Spawned a .+? spawn point: (\S+) @ Vector\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/;
const SPAWN_POINT_HINT = "spawn point:";
/** Distinct points kept per run; a defense tileset never approaches this. */
const MAX_SPAWN_POINTS = 300;
const WAVE_COUNTDOWN = /\/Lotus\/Interface\/ProjectionsCountdown\.swf/;
const TERRITORY = /Script \[Info\]: TerritoryMission\.lua/;
const TERRITORY_START = /TerritoryMission\.lua: .*(control|captured)/i;

// _EliteAlert on a squad mission sector is locale-independent and precedes the mission name.
const PENDING_SECTOR_PLAIN =
  /(?:ThemedSquadOverlay\.lua: Pending mission:|MapRedux\.lua: Confirm sector) (\S+)/;
const PENDING_SECTOR_JSON = /Set squad mission.*?"name":"([^"]+)"/;
const ELITE_SECTOR = /^(SolNode\d+)_EliteAlert$/;
// Mid-mission joins omit "Mission name", so either client-load marker can start the run.
// The engine mission type arrives afterward.
const CLIENT_MISSION_JOIN =
  /Client (?:joining mission in-progress|loaded)[^{]*\{"name":"([^"]+)"\}/;
const CACHED_MISSION_NAME = /ThemedSquadOverlay\.lua: Cached mission name=(.+) \((SolNode\d+)\)/;

// Timestamped in-mission lines carrying the engine mission type (and node id).
const SYNC_CONSUMABLES =
  /SyncAutoPopulatedConsumables for mission (MT_[A-Z_]+) with location (\S+)/;
const STATE_STARTED = /Game \[Info\]: OnStateStarted, mission type=(MT_[A-Z_]+)/;

// Every squad member logs one of these while loading into the mission.
const LOADOUT_LOADED = /Game \[Info\]: (.+?) loadout loader finished/;

// Confirmed abort and EOM inventory commit are reliable run ends.
// EndOfMatch initialization repeats mid-mission and is unsafe here.
const ABORT_CONFIRMED = /TopMenu\.lua: Abort:/;
const EOM_COMMIT = /Sys \[Info\]: EOM missionLocationUnlocked=/;

/** Decorative agents that never tick are excluded, except these. */
const FORCED_VALID_AGENTS = new Set(["CorpusEliteShieldDroneAgent"]);

const REWARD_DEBOUNCE_SEC = 30;
/** Mirror Defense nodes run 2 waves per rotation instead of 3. */
const MIRROR_DEFENSE_NODES = ["munio", "tyana"];

// Disruption (MT_ARTIFACT) states. A round ends on ARTIFACT_ROUND_DONE, which is
// the only reliable rotation marker here - SurvivalReward.swf fires constantly.
const DISRUPTION_ROUND_START =
  /SentientArtifactMission\.lua: Disruption: State change: ARTIFACT_ROUND$/;
const DISRUPTION_ROUND_DONE =
  /SentientArtifactMission\.lua: Disruption: State change: ARTIFACT_ROUND_DONE/;
const DISRUPTION_CONDUITS_PER_ROUND = 4;

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
  /** False for client-side runs, whose logs carry no AI data to analyze. */
  hostTelemetry: boolean;
  /** Squad member names in load order, the local player included. */
  players: string[];
  stats: ArbiRunStats | null;
}

interface ArbiParser {
  feedLine(line: string): ArbiParserEvent | null;
  isRunActive(): boolean;
  lastActivitySec(): number;
  /** Monotonic combat activity count; orbiter lines cannot keep a run alive. */
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

interface SpawnPointTally {
  x: number;
  y: number;
  z: number;
  count: number;
  /** Per-wave counts for the first ARBI_EARLY_WAVE_CAP waves, index 0 = wave 1. */
  early: number[];
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
  /** Saw an AI spawn line. Only the host logs those, so false means client-side. */
  hostTelemetry: boolean;
  players: string[];
  rotations: number;
  lastRewardSec: number;
  rewardTimestamps: number[];
  droneTimestamps: number[];
  spawnEvents: SpawnEvent[];
  tickSamples: TickSample[];
  pauseIntervals: PauseInterval[];
  currentPauseStart: number | null;
  spawnPoints: Map<string, SpawnPointTally>;
  /** Wave the spawn lines belong to; spawns logged before wave 1 count as wave 1. */
  currentWave: number;
  waveStarts: Map<number, number>;
  waveEnds: number[];
  waveCountdowns: number[];
  /** Disruption only: ARTIFACT_ROUND / ARTIFACT_ROUND_DONE timestamps. */
  roundStarts: number[];
  roundEnds: number[];
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
  if (mt === "MT_ARTIFACT") return "disruption";
  return "other";
}

function applyMissionTypeRaw(run: RunState, mt: string): void {
  if (run.missionTypeRaw !== null) return;
  run.missionTypeRaw = mt;
  run.missionType = missionTypeFromRaw(mt);
  // A disruption round is four conduits; node names never say "Disruption", so
  // the engine type is the only place this can be set.
  if (run.missionType === "disruption") run.wavesPerRotation = DISRUPTION_CONDUITS_PER_ROUND;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function tallyWave(tally: SpawnPointTally, wave: number): void {
  if (wave >= 1 && wave <= ARBI_EARLY_WAVE_CAP) tally.early[wave - 1]++;
}

function recordSpawnPoint(r: RunState, m: RegExpMatchArray): void {
  const tally = r.spawnPoints.get(m[1]);
  if (tally) {
    tally.count++;
    tallyWave(tally, r.currentWave);
    return;
  }
  if (r.spawnPoints.size >= MAX_SPAWN_POINTS) return;
  const fresh: SpawnPointTally = {
    x: round1(parseFloat(m[2])),
    y: round1(parseFloat(m[3])),
    z: round1(parseFloat(m[4])),
    count: 1,
    early: new Array<number>(ARBI_EARLY_WAVE_CAP).fill(0),
  };
  tallyWave(fresh, r.currentWave);
  r.spawnPoints.set(m[1], fresh);
}

function buildSpawnPoints(r: RunState): ArbiSpawnPoint[] {
  return [...r.spawnPoints.entries()]
    .map(([id, p]) => ({
      id,
      x: p.x,
      y: p.y,
      z: p.z,
      count: p.count,
      ...(p.early.some((n) => n > 0) ? { early: p.early } : {}),
    }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

function hasFullStats(run: RunState): boolean {
  return (
    run.missionType === "defense" ||
    run.missionType === "interception" ||
    run.missionType === "disruption"
  );
}

export function createArbiParser(): ArbiParser {
  let run: RunState | null = null;
  /** Internal sector of the most recent mission select (e.g. "SolNode167_EliteAlert"). */
  let pendingSector: string | null = null;
  /** Squad-overlay mission name, the only name source when joining in progress. */
  let cachedMission: { name: string; solNode: string } | null = null;

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
      hostTelemetry: false,
      players: [],
      rotations: 0,
      lastRewardSec: 0,
      rewardTimestamps: [],
      droneTimestamps: [],
      spawnEvents: [],
      tickSamples: [],
      pauseIntervals: [],
      currentPauseStart: null,
      spawnPoints: new Map(),
      currentWave: 1,
      waveStarts: new Map(),
      waveEnds: [],
      waveCountdowns: [],
      roundStarts: [],
      roundEnds: [],
      preciseStartSec: null,
    };
    return { type: "run-start", missionName, node, missionType, gameTimeSec };
  }

  function feedLine(line: string): ArbiParserEvent | null {
    if (!line || SPAM_SKIP.test(line)) return null;

    const tsMatch = line.match(EE_LOG_LINE_TS);
    const ts = tsMatch ? parseFloat(tsMatch[1]) : 0;

    const sector = line.match(PENDING_SECTOR_PLAIN) ?? line.match(PENDING_SECTOR_JSON);
    if (sector) pendingSector = sector[1];

    const cached = line.match(CACHED_MISSION_NAME);
    if (cached) cachedMission = { name: cached[1].trim(), solNode: cached[2] };

    // Joining a squad mid-mission never logs a "Mission name:" line; the client
    // load is the only start signal. Its sector still carries _EliteAlert.
    const clientLoad = !run ? line.match(CLIENT_MISSION_JOIN) : null;
    if (clientLoad) {
      const joined = ELITE_SECTOR.exec(clientLoad[1]);
      if (joined) {
        pendingSector = clientLoad[1];
        const name = cachedMission?.solNode === joined[1] ? cachedMission.name : joined[1];
        return startRun(name, ts);
      }
    }

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

    const loadout = line.match(LOADOUT_LOADED);
    if (loadout) {
      const player = loadout[1].trim();
      if (player && !run.players.includes(player)) run.players.push(player);
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

    // Thousands of these per run, so keep the regex behind a substring test.
    if (line.includes(SPAWN_POINT_HINT)) {
      const spawn = line.match(SPAWN_POINT);
      if (spawn) recordSpawnPoint(run, spawn);
    }

    const defWave = line.match(DEFENSE_WAVE);
    if (defWave) {
      // Wave lines outrank the mission-name heuristic (but not the engine MT_).
      run.eventCount++;
      if (run.missionTypeRaw === null) run.missionType = "defense";
      const wave = parseInt(defWave[1], 10);
      if (wave > 0) run.currentWave = wave;
      if (ts > 0) {
        run.waveStarts.set(wave, ts);
        run.lastActivitySec = Math.max(run.lastActivitySec, ts);
        if (run.preciseStartSec === null && wave === 1) run.preciseStartSec = ts;
      }
    } else if (run.preciseStartSec === null && ts > 0 && TERRITORY_START.test(line)) {
      run.preciseStartSec = ts;
    }

    if (run.missionType === "disruption" && ts > 0) {
      if (DISRUPTION_ROUND_DONE.test(line)) {
        run.eventCount++;
        run.rotations++;
        run.roundEnds.push(ts);
        run.rewardTimestamps.push(ts);
        run.lastActivitySec = Math.max(run.lastActivitySec, ts);
        // The interval before the next round is downtime, like a reward screen.
        if (run.currentPauseStart === null) run.currentPauseStart = ts;
      } else if (DISRUPTION_ROUND_START.test(line)) {
        run.eventCount++;
        run.roundStarts.push(ts);
        run.lastActivitySec = Math.max(run.lastActivitySec, ts);
        if (run.preciseStartSec === null) run.preciseStartSec = ts;
        if (run.currentPauseStart !== null) {
          run.pauseIntervals.push({ start: run.currentPauseStart, end: ts });
          run.currentPauseStart = null;
        }
      }
    }

    // The survival reward UI also gets created in other modes (seen 25s before
    // an interception's DefenseReward) - only trust it in actual survivals.
    const isSurvivalReward = run.missionTypeRaw === "MT_SURVIVAL" && SURVIVAL_REWARD.test(line);
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
      run.hostTelemetry = true;
      if (ts > 0) {
        run.droneTimestamps.push(ts);
        run.lastActivitySec = Math.max(run.lastActivitySec, ts);
      }
    } else if (AGENT_CREATED.test(line)) {
      run.eventCount++;
      run.hostTelemetry = true;
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

  /** Tick segments inside the window that count as gameplay. The whole-run buckets
   * and every per-wave/per-rotation share walk the same segments. */
  function eachSaturationSegment(
    r: RunState,
    startSec: number,
    endSec: number,
    visit: (enemies: number, durationSec: number) => void,
  ): void {
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
      visit(cur.val, dur);
    }
  }

  function saturationPctIn(r: RunState, startSec: number, endSec: number): number {
    let total = 0;
    let above = 0;
    eachSaturationSegment(r, startSec, endSec, (enemies, dur) => {
      total += dur;
      if (enemies >= ARBI_SATURATION_THRESHOLD) above += dur;
    });
    return total > 0 ? (above / total) * 100 : 0;
  }

  /** One share per reward, each window running from the previous reward. */
  function buildRotationSaturation(r: RunState, startSec: number): number[] {
    let windowStart = startSec;
    return r.rewardTimestamps.map((end) => {
      const pct = saturationPctIn(r, windowStart, end);
      windowStart = end;
      return pct;
    });
  }

  function buildSaturation(r: RunState, startSec: number, endSec: number): ArbiSaturationBucket[] {
    const numBuckets = Math.ceil(SATURATION_MAX_COUNT / SATURATION_BUCKET_WIDTH);
    const seconds = new Array<number>(numBuckets).fill(0);
    let total = 0;
    eachSaturationSegment(r, startSec, endSec, (enemies, dur) => {
      let idx = Math.floor(enemies / SATURATION_BUCKET_WIDTH);
      if (idx >= numBuckets - 1) idx = numBuckets - 1;
      seconds[idx] += dur;
      total += dur;
    });
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

  /** Clamp to the run window, drop empties, merge overlaps. */
  function normalizeIntervals(
    list: readonly PauseInterval[],
    startSec: number,
    endSec: number,
  ): ArbiInterval[] {
    const clamped = list
      .map((iv) => ({ start: Math.max(iv.start, startSec), end: Math.min(iv.end, endSec) }))
      .filter((iv) => iv.end > iv.start)
      .sort((a, b) => a.start - b.start);
    const out: ArbiInterval[] = [];
    for (const iv of clamped) {
      const last = out[out.length - 1];
      if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
      else out.push({ start: iv.start, end: iv.end });
    }
    return out;
  }

  /** Tick-stream stalls: the same gap width the saturation pass treats as non-gameplay. */
  function buildIdleIntervals(r: RunState, startSec: number, endSec: number): ArbiInterval[] {
    const raw: PauseInterval[] = [];
    for (let i = 1; i < r.tickSamples.length; i++) {
      const prev = r.tickSamples[i - 1].t;
      const next = r.tickSamples[i].t;
      if (next - prev > SATURATION_MAX_SEGMENT_SEC) raw.push({ start: prev, end: next });
    }
    return normalizeIntervals(raw, startSec, endSec);
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
      out.push({
        index: wave,
        durationSec: dur,
        saturationPct: saturationPctIn(r, start, start + dur),
      });
    }
    return out;
  }

  /** Disruption rounds: each ARTIFACT_ROUND paired with the next ROUND_DONE. */
  function buildRounds(r: RunState): ArbiWaveEntry[] {
    const out: ArbiWaveEntry[] = [];
    let endIdx = 0;
    for (const [i, start] of r.roundStarts.entries()) {
      while (endIdx < r.roundEnds.length && r.roundEnds[endIdx] <= start) endIdx++;
      if (endIdx >= r.roundEnds.length) break;
      const end = r.roundEnds[endIdx];
      out.push({
        index: i + 1,
        durationSec: end - start,
        saturationPct: saturationPctIn(r, start, end),
      });
      endIdx++;
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
    // No real combat window (early abort; a few load-time drone spawns can
    // still span a few ms) - the end marker pins the actual mission window.
    if (durationSec < 1 && r.runEndSec !== null) {
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
      // A run that ends on a reward screen never logs the unpause that closes it.
      const pauses =
        r.currentPauseStart !== null
          ? [...r.pauseIntervals, { start: r.currentPauseStart, end: r.lastActivitySec }]
          : r.pauseIntervals;
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
        waves:
          r.missionType === "defense"
            ? buildWaves(r)
            : r.missionType === "disruption"
              ? buildRounds(r)
              : null,
        pauseIntervals: normalizeIntervals(pauses, startSec, r.lastActivitySec),
        idleIntervals: buildIdleIntervals(r, startSec, r.lastActivitySec),
        rotationSaturationPct: buildRotationSaturation(r, startSec),
        spawnPoints: buildSpawnPoints(r),
        spawnDataVersion: ARBI_SPAWN_DATA_VERSION,
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
      hostTelemetry: r.hostTelemetry,
      players: r.players,
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
      cachedMission = null;
    },
  };
}
