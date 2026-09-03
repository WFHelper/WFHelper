import type { ArbiInterval, ArbiRunStats } from "../../../config/shared/arbiTypes.js";

/** Floor for the dry-spell threshold; a fast run must not flag every lull. */
const MIN_DRY_SEC = 45;
/** Multiple of the run's own median drone interval above the floor. */
const DRY_MEDIAN_FACTOR = 3;
const BUSIEST_WINDOW_SEC = 60;

export type ArbiSegmentKind = "active" | "dry" | "reward" | "gap";

export interface ArbiSegment {
  kind: ArbiSegmentKind;
  start: number;
  end: number;
  /** Drones that landed inside this segment. */
  drones: number;
}

interface ArbiCadence {
  startSec: number;
  endSec: number;
  segments: ArbiSegment[];
  dryThresholdSec: number;
  drySpellCount: number;
  longestDry: ArbiSegment | null;
  busiestMinute: { start: number; drones: number } | null;
  /** Share of the run window spent in active segments, 0-1. */
  activeShare: number;
}

/** Records written before the parser emitted pause windows cannot be segmented. */
export function hasCadenceData(stats: ArbiRunStats | null | undefined): boolean {
  return !!stats && stats.pauseIntervals !== undefined && stats.droneTimestamps.length > 1;
}

function clampMerge(list: readonly ArbiInterval[], start: number, end: number): ArbiInterval[] {
  const clamped = list
    .map((iv) => ({ start: Math.max(iv.start, start), end: Math.min(iv.end, end) }))
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

/** `base` minus every window in `cut`; both must already be merged and sorted. */
function subtract(base: readonly ArbiInterval[], cut: readonly ArbiInterval[]): ArbiInterval[] {
  const out: ArbiInterval[] = [];
  for (const iv of base) {
    let cursor = iv.start;
    for (const hole of cut) {
      if (hole.end <= cursor) continue;
      if (hole.start >= iv.end) break;
      if (hole.start > cursor) out.push({ start: cursor, end: hole.start });
      cursor = Math.max(cursor, hole.end);
      if (cursor >= iv.end) break;
    }
    if (cursor < iv.end) out.push({ start: cursor, end: iv.end });
  }
  return out;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function totalLength(list: readonly ArbiInterval[]): number {
  return list.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
}

function busiestMinute(drones: readonly number[]): { start: number; drones: number } | null {
  if (drones.length === 0) return null;
  let best = { start: drones[0], drones: 0 };
  let right = 0;
  for (let left = 0; left < drones.length; left++) {
    while (right < drones.length && drones[right] - drones[left] < BUSIEST_WINDOW_SEC) right++;
    const count = right - left;
    if (count > best.drones) best = { start: drones[left], drones: count };
  }
  return best;
}

/** Segment a run into active play, dry spells, reward pauses and unexplained gaps. */
export function computeCadence(stats: ArbiRunStats): ArbiCadence | null {
  const startSec = stats.preciseStartSec ?? stats.droneTimestamps[0] ?? null;
  const endSec = stats.lastActivitySec;
  if (startSec === null || !(endSec > startSec)) return null;

  const drones = stats.droneTimestamps
    .filter((t) => t >= startSec && t <= endSec)
    .sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < drones.length; i++) intervals.push(drones[i] - drones[i - 1]);
  const dryThresholdSec = Math.max(MIN_DRY_SEC, median(intervals) * DRY_MEDIAN_FACTOR);

  const reward = clampMerge(stats.pauseIntervals ?? [], startSec, endSec);
  const gap = subtract(clampMerge(stats.idleIntervals ?? [], startSec, endSec), reward);
  const explained = clampMerge([...reward, ...gap], startSec, endSec);

  const pieces: ArbiSegment[] = [
    ...reward.map((iv) => ({ kind: "reward" as const, ...iv, drones: 0 })),
    ...gap.map((iv) => ({ kind: "gap" as const, ...iv, drones: 0 })),
  ];

  const marks = [startSec, ...drones, endSec].filter((t) => t >= startSec && t <= endSec);
  for (let i = 1; i < marks.length; i++) {
    if (marks[i] <= marks[i - 1]) continue;
    const free = subtract([{ start: marks[i - 1], end: marks[i] }], explained);
    const kind = totalLength(free) > dryThresholdSec ? "dry" : "active";
    for (const iv of free) pieces.push({ kind, ...iv, drones: 0 });
  }

  pieces.sort((a, b) => a.start - b.start);
  const segments: ArbiSegment[] = [];
  for (const piece of pieces) {
    const last = segments[segments.length - 1];
    if (last && last.kind === piece.kind && piece.start - last.end < 0.001) {
      last.end = Math.max(last.end, piece.end);
      continue;
    }
    segments.push({ ...piece });
  }

  for (const drone of drones) {
    const hit = segments.find((s) => drone >= s.start && drone <= s.end);
    if (hit) hit.drones++;
  }

  const dry = segments.filter((s) => s.kind === "dry");
  const activeSec = segments
    .filter((s) => s.kind === "active")
    .reduce((sum, s) => sum + (s.end - s.start), 0);
  return {
    startSec,
    endSec,
    segments,
    dryThresholdSec,
    drySpellCount: dry.length,
    longestDry:
      dry.length > 0
        ? dry.reduce((best, s) => (s.end - s.start > best.end - best.start ? s : best))
        : null,
    busiestMinute: busiestMinute(drones),
    activeShare: activeSec / (endSec - startSec),
  };
}
