/**
 * Shared arbitration-run types used by both main-process and renderer.
 *
 * Single source of truth - do not duplicate these types elsewhere.
 */

export type ArbiMissionType = "defense" | "interception" | "other";

type ArbiRunSource = "live" | "imported";

export type ArbiRunEndReason =
  | "mission-end"
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
}

export interface ArbiRunRecord {
  /** "YYYY-MM-DD_HH-mm-ss" wall clock at run start; also the .log.gz basename. */
  id: string;
  startedAt: number;
  endedAt: number;
  missionName: string;
  node: string;
  missionType: ArbiMissionType;
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
}

export interface ArbiRunsPayload {
  runs: ArbiRunRecord[];
  diskUsageBytes: number;
}

export interface ArbiImportResult {
  imported: ArbiRunRecord[];
  skipped: number;
}
