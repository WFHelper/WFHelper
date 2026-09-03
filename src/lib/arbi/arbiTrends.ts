import type { ArbiRunRecord } from "../../types/ipc.js";
import { arbiMetricValue, arbiUsableRuns } from "./arbiCompare.js";

/** Both trend metrics are per-minute rates, so runs of different length compare. */
export type ArbiTrendMetric = "dronesPerMin" | "expectedVitusPerMin";
export type ArbiTrendGroup = "none" | "node" | "missionType";
/** Runs the consistency figure looks back over. */
export const ARBI_CONSISTENCY_WINDOW = 5;

interface ArbiTrendPoint {
  id: string;
  startedAt: number;
  value: number;
}

interface ArbiTrendSeries {
  /** Group value: "" when ungrouped, otherwise the node name or mission type. */
  key: string;
  points: ArbiTrendPoint[];
}

function groupKey(run: ArbiRunRecord, group: ArbiTrendGroup): string {
  if (group === "node") return run.node;
  if (group === "missionType") return run.missionType;
  return "";
}

/** Oldest first, incomplete and duplicate runs dropped, metric-less runs dropped. */
export function arbiTrendSeries(
  runs: readonly ArbiRunRecord[],
  metric: ArbiTrendMetric,
  group: ArbiTrendGroup,
): ArbiTrendSeries[] {
  const byKey = new Map<string, ArbiTrendPoint[]>();
  const ordered = [...arbiUsableRuns(runs)].sort((a, b) => a.startedAt - b.startedAt);
  for (const run of ordered) {
    const value = arbiMetricValue(run, metric);
    if (value === null || !Number.isFinite(value)) continue;
    const key = groupKey(run, group);
    const points = byKey.get(key) ?? [];
    points.push({ id: run.id, startedAt: run.startedAt, value });
    byKey.set(key, points);
  }
  return [...byKey.entries()]
    .map(([key, points]) => ({ key, points }))
    .sort((a, b) => b.points.length - a.points.length || a.key.localeCompare(b.key));
}

/** Coefficient of variation over the last `window` points; null when meaningless. */
export function rollingConsistency(
  points: readonly ArbiTrendPoint[],
  window = ARBI_CONSISTENCY_WINDOW,
): number | null {
  const tail = points.slice(-window).map((p) => p.value);
  if (tail.length < 2) return null;
  const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
  if (!(mean > 0)) return null;
  const variance = tail.reduce((sum, v) => sum + (v - mean) ** 2, 0) / tail.length;
  return Math.sqrt(variance) / mean;
}

interface ArbiPbContext {
  metric: ArbiTrendMetric;
  value: number;
  /** 1-based position within the node + mission-type pool. */
  rank: number;
  poolSize: number;
  isPb: boolean;
  /** Best and runner-up among the OTHER runs in the pool. */
  bestOther: number | null;
  secondOther: number | null;
  vsBestPct: number | null;
  vsSecondPct: number | null;
}

function percentDelta(value: number, reference: number | null): number | null {
  if (reference === null || !(reference > 0)) return null;
  return ((value - reference) / reference) * 100;
}

/** Where this run sits among the user's other runs on the same node and mission type. */
export function arbiPersonalBest(
  run: ArbiRunRecord,
  all: readonly ArbiRunRecord[],
  metrics: readonly ArbiTrendMetric[] = ["dronesPerMin", "expectedVitusPerMin"],
): ArbiPbContext[] {
  const pool = arbiUsableRuns(all).filter(
    (candidate) => candidate.node === run.node && candidate.missionType === run.missionType,
  );
  const out: ArbiPbContext[] = [];
  for (const metric of metrics) {
    const value = arbiMetricValue(run, metric);
    if (value === null || !Number.isFinite(value)) continue;
    const others = pool
      .filter((candidate) => candidate.id !== run.id)
      .map((candidate) => arbiMetricValue(candidate, metric))
      .filter((v): v is number => v !== null && Number.isFinite(v))
      .sort((a, b) => b - a);
    const bestOther = others[0] ?? null;
    const secondOther = others[1] ?? null;
    out.push({
      metric,
      value,
      rank: others.filter((v) => v > value).length + 1,
      poolSize: others.length + 1,
      isPb: bestOther === null || value >= bestOther,
      bestOther,
      secondOther,
      vsBestPct: percentDelta(value, bestOther),
      vsSecondPct: percentDelta(value, secondOther),
    });
  }
  return out;
}
