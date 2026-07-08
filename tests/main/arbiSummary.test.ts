import { describe, expect, it } from "vitest";

import { buildArbiSummaryPayload } from "../../config/shared/arbiSummary";
import type { ArbiRunRecord, ArbiRunStats } from "../../config/shared/arbiTypes";

function makeStats(overrides: Partial<ArbiRunStats> = {}): ArbiRunStats {
  return {
    killsPerDrone: 6.4,
    avgDroneIntervalSec: 51.2,
    expectedVitusMean: 14.6,
    expectedVitusStd: 3.2,
    vitusPerMin: 0.42,
    wavesPerRotation: 3,
    droneTimestamps: [],
    rewardTimestamps: [],
    preciseStartSec: 100,
    lastActivitySec: 2000,
    saturationBuckets: [
      { minCount: 0, label: "0-2", seconds: 60, pct: 10 },
      { minCount: 12, label: "12-14", seconds: 120, pct: 20 },
      { minCount: 15, label: "15-17", seconds: 180, pct: 30.25 },
      { minCount: 27, label: "27+", seconds: 30, pct: 5.5 },
    ],
    waves: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<ArbiRunRecord> = {}): ArbiRunRecord {
  return {
    id: "2026-07-08_18-00-00",
    startedAt: 1_780_000_000_000,
    endedAt: 1_780_000_600_000,
    missionName: "Arbitration: Casta (Ceres)",
    node: "Casta (Ceres)",
    missionType: "defense",
    missionTypeRaw: "MT_DEFENSE",
    solNode: "SolNode149",
    durationSec: 2948,
    rotations: 4,
    drones: 120,
    totalEnemies: 800,
    vitusActual: null,
    logFile: "2026-07-08_18-00-00.log.gz",
    logSizeBytes: 12345,
    endReason: "mission-end",
    source: "live",
    stats: makeStats(),
    ...overrides,
  };
}

describe("buildArbiSummaryPayload", () => {
  it("builds a payload for a live multi-rotation mission-end run", () => {
    const payload = buildArbiSummaryPayload(makeRun());
    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({
      id: "2026-07-08_18-00-00",
      node: "Casta (Ceres)",
      missionType: "defense",
      durationSec: 2948,
      rotations: 4,
      drones: 120,
      totalEnemies: 800,
      expectedVitusMean: 14.6,
      expectedVitusStd: 3.2,
    });
  });

  it("sums saturation pct across all buckets at 15+ enemies", () => {
    const payload = buildArbiSummaryPayload(makeRun());
    // 30.25 + 5.5, rounded to one decimal
    expect(payload?.pctTimeAt15Plus).toBe(35.8);
  });

  it("also shows for aborted runs (leaving mid-mission after 2+ rotations)", () => {
    expect(buildArbiSummaryPayload(makeRun({ endReason: "aborted" }))).not.toBeNull();
  });

  it("skips single-rotation runs", () => {
    expect(buildArbiSummaryPayload(makeRun({ rotations: 1 }))).toBeNull();
    expect(buildArbiSummaryPayload(makeRun({ rotations: 0 }))).toBeNull();
  });

  it("skips imported runs", () => {
    expect(
      buildArbiSummaryPayload(makeRun({ source: "imported", endReason: "imported" })),
    ).toBeNull();
  });

  it("skips late finalizations that would pop long after the mission", () => {
    for (const endReason of ["inactivity", "app-quit", "log-truncated", "new-mission"] as const) {
      expect(buildArbiSummaryPayload(makeRun({ endReason }))).toBeNull();
    }
  });

  it("skips runs without computed stats", () => {
    expect(buildArbiSummaryPayload(makeRun({ stats: null }))).toBeNull();
  });
});
