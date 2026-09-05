import { describe, expect, it } from "vitest";

import { computeDroneCadence } from "../../../../src/lib/arbi/arbiDroneCadence.js";
import type { ArbiDroneCadence } from "../../../../src/lib/arbi/arbiDroneCadence.js";
import type { ArbiRunStats } from "../../../../src/types/ipc.js";

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

function cadenceOf(overrides: Partial<ArbiRunStats>): ArbiDroneCadence {
  const cadence = computeDroneCadence(makeStats(overrides));
  if (!cadence) throw new Error("expected a cadence");
  return cadence;
}

function pctFor(cadence: ArbiDroneCadence, label: string): number {
  return cadence.buckets.find((b) => b.label === label)?.pct ?? -1;
}

describe("computeDroneCadence", () => {
  it("weights buckets by wait time, not by wait count", () => {
    const cadence = cadenceOf({
      preciseStartSec: 0,
      droneTimestamps: [0, 0.5, 2, 5, 20],
      lastActivitySec: 30,
    });

    // gaps 0.5s, 1.5s, 3s, 15s over 20s of waiting
    expect(cadence.totalWaitSec).toBeCloseTo(20, 6);
    expect(pctFor(cadence, "0-1s")).toBeCloseTo(2.5, 6);
    expect(pctFor(cadence, "1-2s")).toBeCloseTo(7.5, 6);
    expect(pctFor(cadence, "2-3s")).toBeCloseTo(0, 6);
    expect(pctFor(cadence, "3-5s")).toBeCloseTo(15, 6);
    expect(pctFor(cadence, "12s+")).toBeCloseTo(75, 6);
    expect(cadence.dryPct).toBeCloseTo(75, 6);
  });

  it("subtracts reward screens and load stalls from the gap", () => {
    const cadence = cadenceOf({
      preciseStartSec: 0,
      droneTimestamps: [0, 0.5, 2, 5, 20],
      lastActivitySec: 30,
      pauseIntervals: [{ start: 5, end: 12 }],
      idleIntervals: [{ start: 10, end: 15 }],
    });

    // the 15s gap loses the merged [5,15] downtime and becomes a 5s wait
    expect(cadence.totalWaitSec).toBeCloseTo(10, 6);
    expect(pctFor(cadence, "5-8s")).toBeCloseTo(50, 6);
    expect(pctFor(cadence, "12s+")).toBeCloseTo(0, 6);
    expect(cadence.dryPct).toBeCloseTo(0, 6);
  });

  it("reports the densest 10s window relative to the run start", () => {
    const cadence = cadenceOf({
      preciseStartSec: 100,
      droneTimestamps: [101, 140, 141, 142, 143, 160],
      lastActivitySec: 200,
    });

    expect(cadence.peak).toEqual({ drones: 4, atSec: 40 });
  });

  it("scans a 10s window, so a wider burst does not win", () => {
    const cadence = cadenceOf({
      preciseStartSec: 100,
      // 5 drones over 20s, then 4 inside 6s.
      droneTimestamps: [110, 115, 120, 125, 130, 200, 202, 204, 206],
      lastActivitySec: 300,
    });

    expect(cadence.peak).toEqual({ drones: 4, atSec: 100 });
  });

  it("returns null without a usable window or a second drone", () => {
    expect(computeDroneCadence(makeStats({ droneTimestamps: [1, 2] }))).toBeNull();
    expect(
      computeDroneCadence(
        makeStats({ preciseStartSec: 0, droneTimestamps: [5], lastActivitySec: 30 }),
      ),
    ).toBeNull();
  });
});
