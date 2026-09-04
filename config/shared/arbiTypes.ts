export type ArbiMissionType = "defense" | "interception" | "disruption" | "other";

type ArbiRunSource = "live" | "imported";

export type ArbiRunEndReason =
  | "mission-end"
  | "aborted"
  | "new-mission"
  | "log-truncated"
  | "app-quit"
  | "inactivity"
  | "imported";

export interface ArbiSaturationBucket {
  /** Lower bound of the enemy-count bucket (buckets are 3 wide, last is open-ended). */
  minCount: number;
  label: string;
  seconds: number;
  pct: number;
}

export interface ArbiWaveEntry {
  index: number;
  durationSec: number;
  /** Share of this wave/round at or above the saturation threshold, 0-100.
   * Absent on records written before per-wave saturation existed. */
  saturationPct?: number;
}

/** Waves the parser keeps a separate count for. A floor filter cuts inside this
 * window, so it only has to cover the first few waves of a run. */
export const ARBI_EARLY_WAVE_CAP = 15;

/** Bumped when the spawn-point shape changes; 2 is the first with `early`. */
export const ARBI_SPAWN_DATA_VERSION = 2;

/** One WaveDefend spawn point, aggregated over the run. Engine coordinates: y is up. */
export interface ArbiSpawnPoint {
  /** Full engine path, e.g. "/Layer1/Layer1/NpcSpawnPoint37". */
  id: string;
  x: number;
  y: number;
  z: number;
  count: number;
  /** Spawns in waves 1..ARBI_EARLY_WAVE_CAP, index 0 = wave 1. Absent when the
   * point never fired that early, and on records written before version 2. */
  early?: number[];
}

/** Spawns this point produced from `minWave` on. A point without per-wave counts
 * never fired inside the tracked window, and a record written before version 2
 * has none at all, so both keep the full count. */
export function countFromWave(point: ArbiSpawnPoint, minWave: number): number {
  if (!point.early || minWave <= 1 || minWave > ARBI_EARLY_WAVE_CAP + 1) return point.count;
  let cut = 0;
  for (let wave = 1; wave < minWave; wave++) cut += point.early[wave - 1] ?? 0;
  return Math.max(0, point.count - cut);
}

/** Half-open window in game-relative seconds (EE.log float timestamps). */
export interface ArbiInterval {
  start: number;
  end: number;
}

/** Full computed stats for defense/interception runs; null for other mission types. */
export interface ArbiRunStats {
  killsPerDrone: number;
  avgDroneIntervalSec: number | null;
  expectedVitusMean: number;
  expectedVitusStd: number;
  vitusPerMin: number;
  wavesPerRotation: number;
  /** Game-relative seconds (EE.log float timestamps). */
  droneTimestamps: number[];
  /** Rotation reward boundaries, game-relative seconds. */
  rewardTimestamps: number[];
  preciseStartSec: number | null;
  lastActivitySec: number;
  saturationBuckets: ArbiSaturationBucket[];
  /** Defense only (wave clear map); null for interception. */
  waves: ArbiWaveEntry[] | null;
  /** Reward-screen and between-wave downtime. Absent on records written before
   * cadence tracking, which is what hides the timeline for them. */
  pauseIntervals?: ArbiInterval[];
  /** Windows with no AI tick line at all (load screen, host stall, migration). */
  idleIntervals?: ArbiInterval[];
  /** One saturation share (0-100) per rewardTimestamps entry. Absent on records
   * written before rotation saturation existed. */
  rotationSaturationPct?: number[];
  /** Defense only - no other mode logs spawn points. Empty when none were seen. */
  spawnPoints?: ArbiSpawnPoint[];
  /** Shape version of `spawnPoints`; absent on records written before versioning. */
  spawnDataVersion?: number;
}

export interface ArbiRunRecord {
  /** "YYYY-MM-DD_HH-mm-ss" wall clock at run start; also the .log.gz basename. */
  id: string;
  startedAt: number;
  endedAt: number;
  missionName: string;
  node: string;
  missionType: ArbiMissionType;
  /** Raw engine mission type from the log (e.g. "MT_PURIFY"); optional for pre-existing records. */
  missionTypeRaw?: string | null;
  /** Star chart node id (e.g. "SolNode167"); optional for pre-existing records. */
  solNode?: string | null;
  durationSec: number;
  rotations: number;
  drones: number;
  totalEnemies: number;
  vitusActual: number | null;
  /** Filename within arbi-logs/, null once the raw log is deleted. */
  logFile: string | null;
  logSizeBytes: number;
  endReason: ArbiRunEndReason;
  source: ArbiRunSource;
  stats: ArbiRunStats | null;
  /** User labels for grouping/filtering (e.g. "boar run"); absent on old records. */
  tags?: string[];
  /** Squad member names in load order; absent on old records. */
  players?: string[];
  /** Free-text user note; absent when empty. */
  notes?: string;
  /** Id of the richer record this one duplicates; absent when the run is unique. */
  duplicateOf?: string;
}

/** Max tags per run, and max characters per tag - enforced on every write. */
const ARBI_MAX_TAGS = 12;
const ARBI_MAX_TAG_LEN = 32;
const ARBI_MAX_NOTES_LEN = 2000;

/** Total over unknown input; shared by the IPC guard and the tracker. */
export function normalizeArbiTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim().replace(/\s+/g, " ").slice(0, ARBI_MAX_TAG_LEN).trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= ARBI_MAX_TAGS) break;
  }
  return out;
}

/** Total over unknown input; shared by the IPC guard and the tracker. */
export function normalizeArbiNotes(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let out = "";
  for (const ch of raw.replace(/\r\n?/g, "\n")) {
    // Control characters corrupt the index and the list rendering; tab and
    // newline stay so a multi-line note keeps its shape.
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) continue;
    if (out.length + ch.length > ARBI_MAX_NOTES_LEN) break;
    out += ch;
  }
  return out.trim();
}

export interface ArbiRunsPayload {
  runs: ArbiRunRecord[];
  diskUsageBytes: number;
}

export interface ArbiImportResult {
  imported: ArbiRunRecord[];
  skipped: number;
}
