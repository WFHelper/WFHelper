import { describe, expect, it } from "vitest";

import {
  arbiAveragePool,
  arbiMetricValue,
  arbiUsableRuns,
  buildArbiComparison,
  formatArbiMetric,
  isIncompleteRun,
} from "../../../../src/lib/arbi/arbiCompare.js";
import type { ArbiRunRecord, ArbiRunStats } from "../../../../src/types/ipc.js";

function makeStats(overrides: Partial<ArbiRunStats> = {}): ArbiRunStats {
  return {
    killsPerDrone: 0,
    avgDroneIntervalSec: null,
    expectedVitusMean: 0,
    expectedVitusStd: 0,
    vitusPerMin: 0,
    wavesPerRotation: 3,
    droneTimestamps: [],
    rewardTimestamps: [],
    preciseStartSec: null,
    lastActivitySec: 0,
    saturationBuckets: [],
    waves: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<ArbiRunRecord> = {}): ArbiRunRecord {
  return {
    id: "2026-07-08_00-15-00",
    startedAt: 1_800_000_000_000,
    endedAt: 1_800_000_600_000,
    missionName: "Arbitration: Casta Defense (Ceres)",
    node: "Casta Defense (Ceres)",
    missionType: "defense",
    durationSec: 600,
    rotations: 4,
    drones: 20,
    totalEnemies: 400,
    vitusActual: null,
    logFile: null,
    logSizeBytes: 0,
    endReason: "mission-end",
    source: "live",
    stats: makeStats(),
    ...overrides,
  };
}

describe("arbiMetricValue", () => {
  it("derives per-minute rates from the record, without stats", () => {
    const run = makeRun({ stats: null });
    expect(arbiMetricValue(run, "dronesPerMin")).toBeCloseTo(2, 6);
    expect(arbiMetricValue(run, "enemiesPerMin")).toBeCloseTo(40, 6);
    expect(arbiMetricValue(run, "dronesPerRotation")).toBeCloseTo(5, 6);
    expect(arbiMetricValue(run, "killsPerDrone")).toBeCloseTo(20, 6);
  });

  it("returns null for stats-only metrics when a run has no stats", () => {
    const run = makeRun({ stats: null });
    expect(arbiMetricValue(run, "expectedVitus")).toBeNull();
    expect(arbiMetricValue(run, "avgDroneIntervalSec")).toBeNull();
    expect(arbiMetricValue(run, "saturationPct")).toBeNull();
    expect(arbiMetricValue(run, "expectedVitusPerMin")).toBeNull();
  });

  it("prefers the typed-in vitus over the model for vitus/min", () => {
    const modelled = makeRun({ stats: makeStats({ vitusPerMin: 3 }) });
    expect(arbiMetricValue(modelled, "vitusPerMin")).toBeCloseTo(3, 6);
    const actual = makeRun({ vitusActual: 60, stats: makeStats({ vitusPerMin: 3 }) });
    expect(arbiMetricValue(actual, "vitusPerMin")).toBeCloseTo(6, 6);
    // The expected rate stays the model even when the actual is known.
    expect(arbiMetricValue(actual, "expectedVitusPerMin")).toBeCloseTo(3, 6);
  });

  it("guards zero-length and zero-rotation runs", () => {
    const run = makeRun({ durationSec: 0, rotations: 0, drones: 0 });
    expect(arbiMetricValue(run, "dronesPerMin")).toBeNull();
    expect(arbiMetricValue(run, "dronesPerRotation")).toBeNull();
    expect(arbiMetricValue(run, "killsPerDrone")).toBeNull();
  });

  it("reads the saturation share from the run's own buckets", () => {
    const run = makeRun({
      stats: makeStats({
        saturationBuckets: [
          { minCount: 0, label: "0-2", seconds: 30, pct: 30 },
          { minCount: 15, label: "15-17", seconds: 70, pct: 70 },
        ],
      }),
    });
    expect(arbiMetricValue(run, "saturationPct")).toBeCloseTo(70, 6);
  });
});

describe("formatArbiMetric", () => {
  it("formats each unit and passes null through", () => {
    expect(formatArbiMetric(3725, "duration")).toBe("1h 2m 5s");
    expect(formatArbiMetric(1.234, "decimal2")).toBe("1.23");
    expect(formatArbiMetric(1.25, "seconds")).toBe("1.25s");
    expect(formatArbiMetric(12.34, "percent")).toBe("12.3%");
    expect(formatArbiMetric(null, "int")).toBeNull();
    expect(formatArbiMetric(Number.NaN, "int")).toBeNull();
  });
});

describe("arbiUsableRuns", () => {
  it("drops truncated logs and flagged duplicates", () => {
    const good = makeRun({ id: "a" });
    const truncated = makeRun({ id: "b", endReason: "log-truncated" });
    const duplicate = makeRun({ id: "c", duplicateOf: "a" });
    expect(isIncompleteRun(truncated)).toBe(true);
    expect(arbiUsableRuns([good, truncated, duplicate]).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("arbiAveragePool", () => {
  const reference = makeRun({ id: "ref", node: "Casta", missionType: "defense", players: ["a"] });
  const runs = [
    reference,
    makeRun({ id: "same-node", node: "Casta", missionType: "interception", players: ["a", "b"] }),
    makeRun({ id: "same-type", node: "Stofler", missionType: "defense", players: ["a", "b"] }),
    makeRun({ id: "same-squad", node: "Stofler", missionType: "interception", players: ["z"] }),
  ];

  it("keeps every usable run when the scope is the filtered list", () => {
    expect(arbiAveragePool(runs, reference, "filtered")).toHaveLength(4);
  });

  it("narrows by node, mission type and squad size", () => {
    expect(arbiAveragePool(runs, reference, "node").map((r) => r.id)).toEqual(["ref", "same-node"]);
    expect(arbiAveragePool(runs, reference, "missionType").map((r) => r.id)).toEqual([
      "ref",
      "same-type",
    ]);
    expect(arbiAveragePool(runs, reference, "squad").map((r) => r.id)).toEqual([
      "ref",
      "same-squad",
    ]);
  });

  it("falls back to every usable run without a reference", () => {
    expect(arbiAveragePool(runs, null, "node")).toHaveLength(4);
  });
});

describe("buildArbiComparison", () => {
  const fast = makeRun({ id: "fast", drones: 40, durationSec: 600 });
  const slow = makeRun({ id: "slow", drones: 10, durationSec: 600 });

  it("flags the best cell per row for both directions", () => {
    const rows = buildArbiComparison([fast, slow], []);
    const dpm = rows.find((row) => row.metric.key === "dronesPerMin");
    expect(dpm?.cells.map((c) => c.best)).toEqual([true, false]);
    // Fewer kills per drone is the better end of that row.
    const kpd = rows.find((row) => row.metric.key === "killsPerDrone");
    expect(kpd?.cells.map((c) => c.best)).toEqual([true, false]);
  });

  it("highlights nothing when a single run is compared", () => {
    const rows = buildArbiComparison([fast], []);
    expect(rows.every((row) => row.cells.every((cell) => !cell.best))).toBe(true);
  });

  it("shares the highlight on a tie", () => {
    const rows = buildArbiComparison([fast, makeRun({ id: "twin", drones: 40 })], []);
    const drones = rows.find((row) => row.metric.key === "drones");
    expect(drones?.cells.map((c) => c.best)).toEqual([true, true]);
  });

  it("averages only the runs that have the metric", () => {
    const rows = buildArbiComparison([fast], [fast, slow, makeRun({ id: "n", stats: null })]);
    const expected = rows.find((row) => row.metric.key === "expectedVitus");
    // The stats-less run contributes nothing rather than a zero.
    expect(expected?.average).toBe(0);
    const dpm = rows.find((row) => row.metric.key === "dronesPerMin");
    expect(dpm?.average).toBeCloseTo((4 + 1 + 2) / 3, 6);
  });

  it("emits null cells for a run without stats", () => {
    const rows = buildArbiComparison([makeRun({ id: "other", stats: null })], []);
    const saturation = rows.find((row) => row.metric.key === "saturationPct");
    expect(saturation?.cells[0].value).toBeNull();
  });
});
