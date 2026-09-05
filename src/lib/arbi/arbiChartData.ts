import type { ArbiInterval } from "../../../config/shared/arbiTypes.js";
import type { ArbiRunRecord, ArbiRunStats } from "../../types/ipc.js";

export { ARBI_SATURATION_THRESHOLD } from "../../../config/shared/arbiMath.js";

/** Game-mode names for the engine MT_* types that show up as "other" arbis. */
const MT_LABELS: Record<string, string> = {
  MT_SURVIVAL: "Survival",
  MT_EXCAVATE: "Excavation",
  MT_EVACUATION: "Defection",
  MT_PURIFY: "Infested Salvage",
  MT_ALCHEMY: "Alchemy",
};

/** Resolve an engine label for "other" runs, or null to use the generic label. */
export function missionKindLabel(
  run: Pick<ArbiRunRecord, "missionType" | "missionTypeRaw">,
): string | null {
  if (run.missionType !== "other" || !run.missionTypeRaw) return null;
  return MT_LABELS[run.missionTypeRaw] ?? run.missionTypeRaw.replace(/^MT_/, "");
}

export function formatDuration(totalSeconds: number): string {
  const duration = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const seconds = duration % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/** m:ss, for the clear maps and the cadence tiles. */
export function formatClock(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function formatRunDate(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Drones killed within each rotation window (reward timestamp boundaries). */
export function dronesPerRotation(stats: ArbiRunStats): number[] {
  const out: number[] = [];
  let droneIdx = 0;
  for (const end of stats.rewardTimestamps) {
    let count = 0;
    while (droneIdx < stats.droneTimestamps.length && stats.droneTimestamps[droneIdx] <= end) {
      count++;
      droneIdx++;
    }
    out.push(count);
  }
  return out;
}

// The first rotation starts at the precise run start or first drone. Later
// rotations start at the previous reward.
function rotationWindows(stats: ArbiRunStats): ArbiInterval[] {
  if (stats.rewardTimestamps.length === 0) return [];
  let start =
    stats.preciseStartSec ??
    stats.droneTimestamps[0] ??
    stats.lastActivitySec - stats.rewardTimestamps.length * 300;
  // Imported logs can stamp the round start after the first reward (round 1's
  // start line missing) - a clamped 10s window then yields absurd DPM.
  if (start >= stats.rewardTimestamps[0]) {
    start = stats.droneTimestamps[0] ?? stats.rewardTimestamps[0] - 300;
  }
  return stats.rewardTimestamps.map((end) => {
    const window = { start, end };
    start = end;
    return window;
  });
}

export function dpmSeries(stats: ArbiRunStats): number[] {
  const windows = rotationWindows(stats);
  return dronesPerRotation(stats).map((count, i) => {
    const durationSec = Math.max(windows[i].end - windows[i].start, 10);
    return count / (durationSec / 60);
  });
}

/** Seconds of `intervals` that fall inside [start, end]. */
export function overlapSeconds(
  intervals: readonly ArbiInterval[],
  start: number,
  end: number,
): number {
  let total = 0;
  for (const iv of intervals) {
    const lo = Math.max(iv.start, start);
    const hi = Math.min(iv.end, end);
    if (hi > lo) total += hi - lo;
  }
  return total;
}

/** Middle value, or the mean of the two middles on an even count. 0 when empty.
 * The input is copied before sorting, so callers keep their order. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Most timestamps inside any half-open `windowSec` window, earliest window on a
 * tie. `values` must be sorted ascending; null when there is nothing to scan. */
export function densestWindow(
  values: readonly number[],
  windowSec: number,
): { start: number; count: number } | null {
  if (values.length === 0) return null;
  let best = { start: values[0], count: 0 };
  let right = 0;
  for (let left = 0; left < values.length; left++) {
    while (right < values.length && values[right] - values[left] < windowSec) right++;
    const count = right - left;
    if (count > best.count) best = { start: values[left], count };
  }
  return best;
}

/** One cell of a clear map: how long it took and how busy it was. */
interface ArbiClearCell {
  index: number;
  durationSec: number;
  /** Null on records parsed before per-window saturation existed. */
  saturationPct: number | null;
}

/** Reward-to-reward clear times, reward-screen pauses removed. */
export function rotationClearCells(stats: ArbiRunStats): ArbiClearCell[] {
  const pauses = stats.pauseIntervals ?? [];
  const saturation = stats.rotationSaturationPct;
  return rotationWindows(stats).map((window, i) => ({
    index: i + 1,
    durationSec: Math.max(
      0,
      window.end - window.start - overlapSeconds(pauses, window.start, window.end),
    ),
    saturationPct: saturation?.[i] ?? null,
  }));
}

/** Defense waves and disruption rounds, which the parser already timed. */
export function waveClearCells(stats: ArbiRunStats): ArbiClearCell[] {
  return (stats.waves ?? []).map((wave) => ({
    index: wave.index,
    durationSec: wave.durationSec,
    saturationPct: wave.saturationPct ?? null,
  }));
}

/** Share of --success in a bar's color-mix, 0-100: bucket 0 is nearly all green
 *  and every later bucket mixes in 15 more points of --danger. */
export function bucketSuccessMixPct(bucketIndex: number): number {
  return Math.max(0, 100 - bucketIndex * 15);
}

/** Percentage of tracked time spent at or above `threshold` enemies. */
export function saturationAboveThresholdPct(
  buckets: ArbiRunStats["saturationBuckets"],
  threshold: number,
): number {
  let total = 0;
  let above = 0;
  for (const b of buckets) {
    total += b.seconds;
    if (b.minCount >= threshold) above += b.seconds;
  }
  return total > 0 ? (above / total) * 100 : 0;
}

/** Red (0) -> green (120) hue for a value within [min, max]. */
export function relativePerformanceHue(value: number, min: number, max: number): number {
  const range = max - min || 1;
  return ((value - min) / range) * 120;
}

/** Gradient color for the threshold stat: green at 0%, red at >=18%. */
export function thresholdHue(pct: number): number {
  const clamped = Math.max(0, Math.min(100, pct));
  return Math.max(0, 120 - (clamped / 18) * 120);
}
