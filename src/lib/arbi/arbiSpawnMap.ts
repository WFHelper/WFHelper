import type { ArbiSpawnPoint } from "../../../config/shared/arbiTypes.js";
import { relativePerformanceHue } from "./arbiChartData.js";

/** Square viewBox; the plan is scaled uniformly into it so the tile keeps its shape. */
const VIEW_SIZE = 100;
/** Margin for the largest bubble plus its stroke. */
const VIEW_PAD = 8;
const MAX_RADIUS = 4.5;
const MIN_RADIUS = 1.4;
const TOP_COUNT = 10;
/** At or below this a point barely fired and reads as a dead corner of the tile. */
const COLD_MAX_COUNT = 2;

interface ArbiSpawnBubble {
  id: string;
  /** Trailing number of the engine path, e.g. "37" for NpcSpawnPoint37. */
  label: string;
  count: number;
  /** Share of all traced spawns, 0-100. */
  sharePct: number;
  cx: number;
  cy: number;
  r: number;
  /** 0 (fewest spawns) to 120 (most), for an hsl fill. */
  hue: number;
}

interface ArbiSpawnMap {
  viewSize: number;
  bubbles: ArbiSpawnBubble[];
  /** Busiest points first, for the side list. */
  top: ArbiSpawnBubble[];
  totalSpawns: number;
  maxCount: number;
  /** Distinct points that fired at least once. */
  pointCount: number;
  avgPerPoint: number;
  medianCount: number;
  /** Share of all spawns coming from the `top` points, 0-100. */
  topSharePct: number;
  coldPoints: number;
  coldMaxCount: number;
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function shortLabel(id: string): string {
  const tail = id.slice(id.lastIndexOf("/") + 1);
  const digits = /(\d+)$/.exec(tail);
  return digits ? digits[1] : tail;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Project the x/z plane (y is up in the engine) into the viewBox and size each
 * bubble by sqrt(count), so area rather than radius tracks the spawn share. */
export function computeSpawnMap(
  points: readonly ArbiSpawnPoint[] | undefined,
): ArbiSpawnMap | null {
  if (!points || points.length === 0) return null;

  const xs = points.map((p) => p.x);
  const zs = points.map((p) => p.z);
  const minX = Math.min(...xs);
  const minZ = Math.min(...zs);
  const spanX = Math.max(...xs) - minX;
  const spanZ = Math.max(...zs) - minZ;
  const span = Math.max(spanX, spanZ) || 1;
  const usable = VIEW_SIZE - VIEW_PAD * 2;
  const scale = usable / span;
  const offsetX = VIEW_PAD + (usable - spanX * scale) / 2;
  const offsetZ = VIEW_PAD + (usable - spanZ * scale) / 2;

  const counts = points.map((p) => p.count);
  const maxCount = Math.max(...counts);
  const minCount = Math.min(...counts);
  const totalSpawns = counts.reduce((sum, c) => sum + c, 0);

  const bubbles = points
    .map((p) => ({
      id: p.id,
      label: shortLabel(p.id),
      count: p.count,
      sharePct: totalSpawns > 0 ? (p.count / totalSpawns) * 100 : 0,
      cx: round2(offsetX + (p.x - minX) * scale),
      cy: round2(offsetZ + (p.z - minZ) * scale),
      r: round2(Math.max(MIN_RADIUS, MAX_RADIUS * Math.sqrt(p.count / maxCount))),
      // All-equal counts would otherwise paint the whole map red.
      hue: minCount === maxCount ? 120 : relativePerformanceHue(p.count, minCount, maxCount),
    }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  const top = bubbles.slice(0, TOP_COUNT);
  const topSpawns = top.reduce((sum, b) => sum + b.count, 0);

  return {
    viewSize: VIEW_SIZE,
    bubbles,
    top,
    totalSpawns,
    maxCount,
    pointCount: points.length,
    avgPerPoint: totalSpawns / points.length,
    medianCount: median([...counts].sort((a, b) => a - b)),
    topSharePct: totalSpawns > 0 ? (topSpawns / totalSpawns) * 100 : 0,
    coldPoints: counts.filter((c) => c <= COLD_MAX_COUNT).length,
    coldMaxCount: COLD_MAX_COUNT,
  };
}
