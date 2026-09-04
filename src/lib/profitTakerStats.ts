import type { PtRunRecord } from "../types/ipc.js";

/** The timings a Profit-Taker run is ranked by; lower is always better. */
export type PtMetric = "total" | "flight" | "shield" | "leg" | "body" | "pylon";

export const PT_METRICS: readonly PtMetric[] = [
  "total",
  "flight",
  "shield",
  "leg",
  "body",
  "pylon",
];

export function ptMetricValue(run: PtRunRecord, metric: PtMetric): number {
  switch (metric) {
    case "total":
      return run.durationSec;
    case "flight":
      return run.flightSec;
    case "shield":
      return run.shieldSec;
    case "leg":
      return run.legSec;
    case "body":
      return run.bodySec;
    case "pylon":
      return run.pylonSec;
  }
}

/** Runs that can be compared: killed the orb, no phase-marker loss, not a copy. */
function ptCleanRuns(runs: readonly PtRunRecord[]): PtRunRecord[] {
  return runs.filter(
    (run) => run.complete && !run.bugged && !run.aborted && run.duplicateOf === undefined,
  );
}

interface PtPbRow {
  metric: PtMetric;
  value: number;
  /** 1-based position among the clean runs. */
  rank: number;
  poolSize: number;
  isPb: boolean;
  /** Signed percent against the best and runner-up of the OTHER runs. */
  vsBestPct: number | null;
  vsSecondPct: number | null;
}

function percentDelta(value: number, reference: number | null): number | null {
  if (reference === null || !(reference > 0)) return null;
  return ((value - reference) / reference) * 100;
}

/** Where this run sits among the user's other clean runs, per metric. */
export function ptPersonalBest(run: PtRunRecord, all: readonly PtRunRecord[]): PtPbRow[] {
  const pool = ptCleanRuns(all);
  const inPool = pool.some((candidate) => candidate.id === run.id);
  if (!inPool) return [];
  const others = pool.filter((candidate) => candidate.id !== run.id);
  return PT_METRICS.map((metric) => {
    const value = ptMetricValue(run, metric);
    const sorted = others
      .map((candidate) => ptMetricValue(candidate, metric))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    const bestOther = sorted[0] ?? null;
    const secondOther = sorted[1] ?? null;
    return {
      metric,
      value,
      rank: sorted.filter((v) => v < value).length + 1,
      poolSize: sorted.length + 1,
      isPb: bestOther === null || value <= bestOther,
      vsBestPct: percentDelta(value, bestOther),
      vsSecondPct: percentDelta(value, secondOther),
    };
  });
}

/** Id of the fastest clean run, for the list's PB badge. */
export function ptBestRunId(runs: readonly PtRunRecord[]): string | null {
  let best: PtRunRecord | null = null;
  for (const run of ptCleanRuns(runs)) {
    if (!best || run.durationSec < best.durationSec) best = run;
  }
  return best?.id ?? null;
}

/** Speedrun clock: "1:52.971" past a minute, plain "12.387" below it. */
export function formatPtTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  if (safe < 60) return safe.toFixed(3);
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${(safe - minutes * 60).toFixed(3).padStart(6, "0")}`;
}
