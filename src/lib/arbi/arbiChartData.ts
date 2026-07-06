/**
 * Pure data/format helpers for the Arbi Analyze views.
 * No Svelte, i18n, or IPC dependencies (unit-tested directly).
 */
import type { ArbiRunStats } from "../../types/ipc.js";

export function formatDuration(totalSeconds: number): string {
  const duration = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const seconds = duration % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
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

/**
 * Drones-per-minute for each rotation. Rotation 1 starts at the run's precise
 * start (or first drone); each following rotation starts at the previous
 * reward. Mirrors the reference analyzer.
 */
export function dpmSeries(stats: ArbiRunStats): number[] {
  if (stats.rewardTimestamps.length === 0) return [];
  let start =
    stats.preciseStartSec ??
    stats.droneTimestamps[0] ??
    stats.lastActivitySec - stats.rewardTimestamps.length * 300;
  const counts = dronesPerRotation(stats);
  return counts.map((count, i) => {
    const end = stats.rewardTimestamps[i];
    const durationSec = Math.max(end - start, 10);
    start = end;
    return count / (durationSec / 60);
  });
}

/** Saturation bar color: green (low counts) through yellow to red, like the reference. */
export function saturationHue(bucketIndex: number): number {
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
