import type { ArbiInterval, ArbiRunStats } from "../../../config/shared/arbiTypes.js";
import { overlapSeconds } from "./arbiChartData.js";

/** Upper bound of each wait bucket, in seconds; the last one is open-ended. */
const BUCKET_EDGES = [1, 2, 3, 5, 8, 12] as const;
/** Waits at or above this count as a dry stretch in the headline tile. */
export const ARBI_DRY_WAIT_SEC = 12;
/** Width of the peak-density window. */
export const ARBI_PEAK_WINDOW_SEC = 10;

interface ArbiWaitBucket {
  /** "0-1s" ... "12s+"; units only, so no translation is needed. */
  label: string;
  minSec: number;
  /** Null on the open-ended last bucket. */
  maxSec: number | null;
  seconds: number;
  /** Share of total wait time, 0-100. */
  pct: number;
}

export interface ArbiDroneCadence {
  buckets: ArbiWaitBucket[];
  totalWaitSec: number;
  /** Share of wait time spent in waits of ARBI_DRY_WAIT_SEC or more, 0-100. */
  dryPct: number;
  /** Densest window, with its offset from the run start. */
  peak: { drones: number; atSec: number } | null;
}

function bucketLabel(minSec: number, maxSec: number | null): string {
  return maxSec === null ? `${minSec}s+` : `${minSec}-${maxSec}s`;
}

/** Pause and idle windows as one sorted, non-overlapping list. */
function downtime(stats: ArbiRunStats): ArbiInterval[] {
  const merged: ArbiInterval[] = [];
  const sorted = [...(stats.pauseIntervals ?? []), ...(stats.idleIntervals ?? [])]
    .filter((iv) => iv.end > iv.start)
    .sort((a, b) => a.start - b.start);
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ start: iv.start, end: iv.end });
  }
  return merged;
}

function peakWindow(drones: readonly number[], startSec: number): ArbiDroneCadence["peak"] {
  if (drones.length === 0) return null;
  let best = { drones: 0, atSec: 0 };
  let right = 0;
  for (let left = 0; left < drones.length; left++) {
    while (right < drones.length && drones[right] - drones[left] < ARBI_PEAK_WINDOW_SEC) right++;
    const count = right - left;
    if (count > best.drones) best = { drones: count, atSec: drones[left] - startSec };
  }
  return best;
}

/** How long the squad waited between drones, weighted by time rather than count:
 * one 30s drought outweighs thirty 1s gaps, which is what a run actually feels like. */
export function computeDroneCadence(stats: ArbiRunStats): ArbiDroneCadence | null {
  const startSec = stats.preciseStartSec ?? stats.droneTimestamps[0] ?? null;
  const endSec = stats.lastActivitySec;
  if (startSec === null || !(endSec > startSec)) return null;

  const drones = stats.droneTimestamps
    .filter((t) => t >= startSec && t <= endSec)
    .sort((a, b) => a - b);
  if (drones.length < 2) return null;

  const buckets: ArbiWaitBucket[] = [];
  let lower = 0;
  for (const edge of BUCKET_EDGES) {
    buckets.push({
      label: bucketLabel(lower, edge),
      minSec: lower,
      maxSec: edge,
      seconds: 0,
      pct: 0,
    });
    lower = edge;
  }
  buckets.push({
    label: bucketLabel(lower, null),
    minSec: lower,
    maxSec: null,
    seconds: 0,
    pct: 0,
  });

  const idle = downtime(stats);
  let total = 0;
  let dry = 0;
  for (let i = 1; i < drones.length; i++) {
    // Reward screens and load stalls are not waiting, so they leave the gap.
    const wait = Math.max(
      0,
      drones[i] - drones[i - 1] - overlapSeconds(idle, drones[i - 1], drones[i]),
    );
    if (wait <= 0) continue;
    const bucket = buckets.find((b) => b.maxSec === null || wait < b.maxSec) ?? buckets[0];
    bucket.seconds += wait;
    total += wait;
    if (wait >= ARBI_DRY_WAIT_SEC) dry += wait;
  }
  for (const bucket of buckets) bucket.pct = total > 0 ? (bucket.seconds / total) * 100 : 0;

  return {
    buckets,
    totalWaitSec: total,
    dryPct: total > 0 ? (dry / total) * 100 : 0,
    peak: peakWindow(drones, startSec),
  };
}
