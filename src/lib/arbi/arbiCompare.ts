import type { MessageKey } from "../i18n.js";
import type { ArbiRunRecord } from "../../types/ipc.js";
import {
  ARBI_SATURATION_THRESHOLD,
  formatDuration,
  saturationAboveThresholdPct,
} from "./arbiChartData.js";

/** Columns the comparison table can hold before the rows get unreadable. */
export const ARBI_COMPARE_MAX = 4;

type ArbiMetricKey =
  | "durationSec"
  | "rotations"
  | "drones"
  | "totalEnemies"
  | "killsPerDrone"
  | "avgDroneIntervalSec"
  | "dronesPerMin"
  | "enemiesPerMin"
  | "expectedVitus"
  | "vitusActual"
  | "vitusPerMin"
  | "expectedVitusPerMin"
  | "saturationPct"
  | "dronesPerRotation";

type ArbiMetricFormat = "int" | "duration" | "decimal1" | "decimal2" | "seconds" | "percent";

interface ArbiMetricDef {
  key: ArbiMetricKey;
  labelKey: MessageKey;
  /** Which end of the row wins the highlight. */
  better: "high" | "low";
  format: ArbiMetricFormat;
}

const ARBI_COMPARE_METRICS: readonly ArbiMetricDef[] = [
  { key: "durationSec", labelKey: "common.duration", better: "high", format: "duration" },
  { key: "rotations", labelKey: "arbi.col.rotations", better: "high", format: "int" },
  { key: "drones", labelKey: "arbi.kpi.drones", better: "high", format: "int" },
  { key: "totalEnemies", labelKey: "arbi.kpi.totalEnemies", better: "high", format: "int" },
  { key: "killsPerDrone", labelKey: "arbi.kpi.killsPerDrone", better: "low", format: "decimal2" },
  {
    key: "avgDroneIntervalSec",
    labelKey: "arbi.kpi.avgInterval",
    better: "low",
    format: "seconds",
  },
  { key: "dronesPerMin", labelKey: "arbi.metric.dronesPerMin", better: "high", format: "decimal2" },
  {
    key: "enemiesPerMin",
    labelKey: "arbi.metric.enemiesPerMin",
    better: "high",
    format: "decimal1",
  },
  {
    key: "dronesPerRotation",
    labelKey: "arbi.metric.dronesPerRotation",
    better: "high",
    format: "decimal1",
  },
  { key: "expectedVitus", labelKey: "arbi.metric.expectedVitus", better: "high", format: "int" },
  { key: "vitusActual", labelKey: "arbi.col.vitus", better: "high", format: "int" },
  { key: "vitusPerMin", labelKey: "arbi.kpi.vitusPerMin", better: "high", format: "decimal2" },
  { key: "saturationPct", labelKey: "arbi.metric.saturation", better: "high", format: "percent" },
];

/** A truncated log under-reports every count, so it stays out of averages and PB pools. */
export function isIncompleteRun(run: ArbiRunRecord): boolean {
  return run.endReason === "log-truncated";
}

export function arbiMetricValue(run: ArbiRunRecord, key: ArbiMetricKey): number | null {
  const minutes = run.durationSec > 0 ? run.durationSec / 60 : 0;
  switch (key) {
    case "durationSec":
      return run.durationSec;
    case "rotations":
      return run.rotations;
    case "drones":
      return run.drones;
    case "totalEnemies":
      return run.totalEnemies;
    case "killsPerDrone":
      return run.drones > 0 ? run.totalEnemies / run.drones : null;
    case "avgDroneIntervalSec":
      return run.stats?.avgDroneIntervalSec ?? null;
    case "dronesPerMin":
      return minutes > 0 ? run.drones / minutes : null;
    case "enemiesPerMin":
      return minutes > 0 ? run.totalEnemies / minutes : null;
    case "dronesPerRotation":
      return run.rotations > 0 ? run.drones / run.rotations : null;
    case "expectedVitus":
      return run.stats ? run.stats.expectedVitusMean : null;
    case "vitusActual":
      return run.vitusActual;
    case "expectedVitusPerMin":
      return run.stats ? run.stats.vitusPerMin : null;
    // Falls back to the model so a run with no typed-in vitus still has a row.
    case "vitusPerMin":
      if (run.vitusActual !== null && minutes > 0) return run.vitusActual / minutes;
      return run.stats ? run.stats.vitusPerMin : null;
    case "saturationPct":
      return run.stats
        ? saturationAboveThresholdPct(run.stats.saturationBuckets, ARBI_SATURATION_THRESHOLD)
        : null;
  }
}

export function formatArbiMetric(value: number | null, format: ArbiMetricFormat): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (format === "duration") return formatDuration(value);
  if (format === "int") return Math.round(value).toLocaleString();
  if (format === "decimal1") return value.toFixed(1);
  if (format === "decimal2") return value.toFixed(2);
  if (format === "seconds") return `${value.toFixed(2)}s`;
  return `${value.toFixed(1)}%`;
}

export type ArbiAverageScope = "filtered" | "missionType" | "node" | "squad";

/** Runs that may feed an average or a personal-best pool. */
export function arbiUsableRuns(runs: readonly ArbiRunRecord[]): ArbiRunRecord[] {
  return runs.filter((run) => !isIncompleteRun(run) && run.duplicateOf === undefined);
}

export function arbiAveragePool(
  runs: readonly ArbiRunRecord[],
  reference: ArbiRunRecord | null,
  scope: ArbiAverageScope,
): ArbiRunRecord[] {
  const usable = arbiUsableRuns(runs);
  if (!reference || scope === "filtered") return usable;
  if (scope === "missionType") {
    return usable.filter((run) => run.missionType === reference.missionType);
  }
  if (scope === "node") return usable.filter((run) => run.node === reference.node);
  const squad = reference.players?.length ?? 0;
  return usable.filter((run) => (run.players?.length ?? 0) === squad);
}

interface ArbiCompareCell {
  value: number | null;
  best: boolean;
}

interface ArbiCompareRow {
  metric: ArbiMetricDef;
  cells: ArbiCompareCell[];
  average: number | null;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** One row per metric, cells in `runs` order, best value flagged (ties share it). */
export function buildArbiComparison(
  runs: readonly ArbiRunRecord[],
  averagePool: readonly ArbiRunRecord[],
): ArbiCompareRow[] {
  return ARBI_COMPARE_METRICS.map((metric) => {
    const values = runs.map((run) => arbiMetricValue(run, metric.key));
    const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
    const bestValue =
      present.length > 0
        ? metric.better === "high"
          ? Math.max(...present)
          : Math.min(...present)
        : null;
    const poolValues = averagePool
      .map((run) => arbiMetricValue(run, metric.key))
      .filter((v): v is number => v !== null && Number.isFinite(v));
    return {
      metric,
      cells: values.map((value) => ({
        value,
        // A single column has no comparison to win.
        best: bestValue !== null && present.length > 1 && value === bestValue,
      })),
      average: mean(poolValues),
    };
  });
}
