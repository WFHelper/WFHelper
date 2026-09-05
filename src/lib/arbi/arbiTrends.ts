import type { ArbiRunRecord } from "../../types/ipc.js";
import { arbiMetricValue, arbiUsableRuns } from "./arbiCompare.js";

/** Both metrics are per-minute rates, so runs of different length compare. */
export type ArbiTrendMetric = "dronesPerMin" | "expectedVitusPerMin";

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
