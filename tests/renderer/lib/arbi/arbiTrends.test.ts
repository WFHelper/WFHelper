import { describe, expect, it } from "vitest";

import { arbiPersonalBest } from "../../../../src/lib/arbi/arbiTrends.js";
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
