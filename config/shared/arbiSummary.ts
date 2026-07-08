import type { ArbiMissionType, ArbiRunRecord } from "./arbiTypes";

/** Compact payload for the post-run summary overlay. */
interface ArbiSummaryPayload {
  id: string;
  node: string;
  missionType: ArbiMissionType;
  missionTypeRaw: string | null;
  durationSec: number;
  rotations: number;
  drones: number;
  totalEnemies: number;
  expectedVitusMean: number;
  expectedVitusStd: number;
  /** Percent of sampled combat time with 15+ enemies alive (0-100). */
  pctTimeAt15Plus: number;
}

const HIGH_SATURATION_MIN_COUNT = 15;

/**
 * Post-run overlay payload, or null when the run shouldn't pop one (live,
 * 2+ rotations, ended at the mission itself, stats present).
 */
export function buildArbiSummaryPayload(run: ArbiRunRecord): ArbiSummaryPayload | null {
  if (run.source !== "live") return null;
  if (run.rotations < 2) return null;
  if (run.endReason !== "mission-end" && run.endReason !== "aborted") return null;
  const stats = run.stats;
  if (!stats) return null;

  const pct = stats.saturationBuckets
    .filter((bucket) => bucket.minCount >= HIGH_SATURATION_MIN_COUNT)
    .reduce((sum, bucket) => sum + bucket.pct, 0);

  return {
    id: run.id,
    node: run.node,
    missionType: run.missionType,
    missionTypeRaw: run.missionTypeRaw ?? null,
    durationSec: run.durationSec,
    rotations: run.rotations,
    drones: run.drones,
    totalEnemies: run.totalEnemies,
    expectedVitusMean: stats.expectedVitusMean,
    expectedVitusStd: stats.expectedVitusStd,
    pctTimeAt15Plus: Math.round(pct * 10) / 10,
  };
}
