import { describe, expect, it } from "vitest";

import {
  arbiPersonalBest,
  arbiTrendSeries,
  rollingConsistency,
} from "../../../../src/lib/arbi/arbiTrends.js";
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

function makeRun(id: string, overrides: Partial<ArbiRunRecord> = {}): ArbiRunRecord {
  return {
    id,
    startedAt: 1_800_000_000_000,
    endedAt: 1_800_000_600_000,
    missionName: "Arbitration: Casta Defense (Ceres)",
    node: "Casta Defense (Ceres)",
    missionType: "defense",
    durationSec: 600,
    rotations: 4,
    drones: 10,
    totalEnemies: 200,
    vitusActual: null,
    logFile: null,
    logSizeBytes: 0,
    endReason: "mission-end",
    source: "live",
    stats: makeStats(),
    ...overrides,
  };
}

describe("arbiTrendSeries", () => {
  it("orders points oldest first and drops unusable runs", () => {
    const runs = [
      makeRun("c", { startedAt: 3000 }),
      makeRun("a", { startedAt: 1000 }),
      makeRun("b", { startedAt: 2000 }),
      makeRun("bad", { startedAt: 2500, endReason: "log-truncated" }),
      makeRun("dup", { startedAt: 2600, duplicateOf: "a" }),
    ];
    const series = arbiTrendSeries(runs, "dronesPerMin", "none");
    expect(series).toHaveLength(1);
    expect(series[0].key).toBe("");
    expect(series[0].points.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("splits by node and by mission type", () => {
    const runs = [
      makeRun("a", { node: "Casta", startedAt: 1000 }),
      makeRun("b", { node: "Casta", startedAt: 2000 }),
      makeRun("c", { node: "Stofler", missionType: "interception", startedAt: 3000 }),
    ];
    expect(arbiTrendSeries(runs, "dronesPerMin", "node").map((s) => s.key)).toEqual([
      "Casta",
      "Stofler",
    ]);
    expect(arbiTrendSeries(runs, "dronesPerMin", "missionType").map((s) => s.key)).toEqual([
      "defense",
      "interception",
    ]);
  });

  it("skips runs whose metric cannot be computed", () => {
    const runs = [makeRun("a"), makeRun("no-stats", { stats: null })];
    expect(arbiTrendSeries(runs, "expectedVitusPerMin", "none")[0].points.map((p) => p.id)).toEqual(
      ["a"],
    );
  });
});

describe("rollingConsistency", () => {
  const point = (value: number, i: number) => ({ id: `r${i}`, startedAt: i, value });

  it("returns null below two points and for a non-positive mean", () => {
    expect(rollingConsistency([point(5, 0)])).toBeNull();
    expect(rollingConsistency([point(0, 0), point(0, 1)])).toBeNull();
  });

  it("is zero for a flat series", () => {
    expect(rollingConsistency([3, 3, 3, 3].map(point))).toBe(0);
  });

  it("only looks at the last window", () => {
    // The first three values are wild; the last five are steady.
    const points = [1, 100, 1, 5, 5, 5, 5, 5].map(point);
    expect(rollingConsistency(points, 5)).toBe(0);
  });

  it("rises with spread", () => {
    const steady = rollingConsistency([9, 10, 11].map(point)) ?? 0;
    const wild = rollingConsistency([2, 10, 18].map(point)) ?? 0;
    expect(wild).toBeGreaterThan(steady);
  });
});

describe("arbiPersonalBest", () => {
  const base = { node: "Casta", missionType: "defense" as const, durationSec: 600 };

  it("marks the strongest run and reports the gap to the runner-up", () => {
    const best = makeRun("best", { ...base, drones: 40 });
    const pool = [best, makeRun("second", { ...base, drones: 20 }), makeRun("third", base)];
    const [dpm] = arbiPersonalBest(best, pool, ["dronesPerMin"]);
    expect(dpm.isPb).toBe(true);
    expect(dpm.rank).toBe(1);
    expect(dpm.poolSize).toBe(3);
    expect(dpm.vsBestPct).toBeCloseTo(100, 6);
    expect(dpm.vsSecondPct).toBeCloseTo(300, 6);
  });

  it("reports a negative delta against the record for a weaker run", () => {
    const weak = makeRun("weak", { ...base, drones: 10 });
    const pool = [makeRun("best", { ...base, drones: 40 }), weak];
    const [dpm] = arbiPersonalBest(weak, pool, ["dronesPerMin"]);
    expect(dpm.isPb).toBe(false);
    expect(dpm.rank).toBe(2);
    expect(dpm.vsBestPct).toBeCloseTo(-75, 6);
    expect(dpm.vsSecondPct).toBeNull();
  });

  it("keeps the pool to the same node and mission type", () => {
    const run = makeRun("run", { ...base, drones: 10 });
    const pool = [
      run,
      makeRun("other-node", { ...base, node: "Stofler", drones: 400 }),
      makeRun("other-type", { ...base, missionType: "interception", drones: 400 }),
    ];
    const [dpm] = arbiPersonalBest(run, pool, ["dronesPerMin"]);
    expect(dpm.poolSize).toBe(1);
    expect(dpm.isPb).toBe(true);
    expect(dpm.vsBestPct).toBeNull();
  });

  it("excludes truncated and duplicate runs from the record pool", () => {
    const run = makeRun("run", { ...base, drones: 10 });
    const pool = [
      run,
      makeRun("truncated", { ...base, drones: 400, endReason: "log-truncated" }),
      makeRun("duplicate", { ...base, drones: 400, duplicateOf: "run" }),
    ];
    const [dpm] = arbiPersonalBest(run, pool, ["dronesPerMin"]);
    expect(dpm.poolSize).toBe(1);
    expect(dpm.isPb).toBe(true);
  });

  it("omits a metric the run cannot supply", () => {
    const run = makeRun("run", { ...base, stats: null });
    expect(arbiPersonalBest(run, [run])).toHaveLength(1);
    expect(arbiPersonalBest(run, [run])[0].metric).toBe("dronesPerMin");
  });
});
