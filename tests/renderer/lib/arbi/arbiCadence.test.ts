import { describe, expect, it } from "vitest";

import { computeCadence, hasCadenceData } from "../../../../src/lib/arbi/arbiCadence.js";
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
    preciseStartSec: 0,
    lastActivitySec: 0,
    saturationBuckets: [],
    waves: null,
    pauseIntervals: [],
    idleIntervals: [],
    ...overrides,
  };
}

/** Drones every `step` seconds from `from` up to and including `to`. */
function evenDrones(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let t = from; t <= to; t += step) out.push(t);
  return out;
}

describe("hasCadenceData", () => {
  it("requires the pause window field and more than one drone", () => {
    expect(hasCadenceData(null)).toBe(false);
    const legacy = makeStats({ droneTimestamps: [10, 20] });
    delete legacy.pauseIntervals;
    expect(hasCadenceData(legacy)).toBe(false);
    expect(hasCadenceData(makeStats({ droneTimestamps: [10] }))).toBe(false);
    expect(hasCadenceData(makeStats({ droneTimestamps: [10, 20] }))).toBe(true);
  });
});

describe("computeCadence", () => {
  it("returns null without a usable run window", () => {
    expect(computeCadence(makeStats({ preciseStartSec: 100, lastActivitySec: 100 }))).toBeNull();
    expect(
      computeCadence(makeStats({ preciseStartSec: null, droneTimestamps: [], lastActivitySec: 5 })),
    ).toBeNull();
  });

  it("marks a steady drone stream as one active segment", () => {
    const cadence = computeCadence(
      makeStats({
        preciseStartSec: 0,
        lastActivitySec: 300,
        droneTimestamps: evenDrones(10, 300, 10),
      }),
    );
    expect(cadence?.segments.map((s) => s.kind)).toEqual(["active"]);
    expect(cadence?.drySpellCount).toBe(0);
    expect(cadence?.activeShare).toBeCloseTo(1, 6);
  });

  it("flags a gap longer than the threshold as a dry spell", () => {
    const cadence = computeCadence(
      makeStats({
        preciseStartSec: 0,
        lastActivitySec: 400,
        // 10s cadence, then 200s of nothing, then 10s cadence again.
        droneTimestamps: [...evenDrones(10, 100, 10), ...evenDrones(300, 400, 10)],
      }),
    );
    // Median interval is 10s, so the 45s floor decides the threshold.
    expect(cadence?.dryThresholdSec).toBe(45);
    expect(cadence?.drySpellCount).toBe(1);
    expect(cadence?.longestDry?.start).toBe(100);
    expect(cadence?.longestDry?.end).toBe(300);
    expect(cadence?.activeShare).toBeCloseTo(0.5, 6);
  });

  it("raises the threshold on a slow run so its normal pace is not a dry spell", () => {
    const cadence = computeCadence(
      makeStats({
        preciseStartSec: 0,
        lastActivitySec: 600,
        droneTimestamps: evenDrones(60, 600, 60),
      }),
    );
    expect(cadence?.dryThresholdSec).toBe(180);
    expect(cadence?.drySpellCount).toBe(0);
  });

  it("attributes a reward pause to the reward segment, not a dry spell", () => {
    const cadence = computeCadence(
      makeStats({
        preciseStartSec: 0,
        lastActivitySec: 400,
        droneTimestamps: [...evenDrones(10, 100, 10), ...evenDrones(300, 400, 10)],
        pauseIntervals: [{ start: 100, end: 300 }],
      }),
    );
    expect(cadence?.drySpellCount).toBe(0);
    expect(cadence?.segments.map((s) => s.kind)).toEqual(["active", "reward", "active"]);
  });

  it("splits an idle stall out of the pause window as an unexplained gap", () => {
    const cadence = computeCadence(
      makeStats({
        preciseStartSec: 0,
        lastActivitySec: 400,
        droneTimestamps: [...evenDrones(10, 100, 10), ...evenDrones(300, 400, 10)],
        idleIntervals: [{ start: 150, end: 250 }],
      }),
    );
    const kinds = cadence?.segments.map((s) => s.kind) ?? [];
    expect(kinds).toContain("gap");
    // The non-idle halves of the same stretch still read as a dry spell.
    expect(cadence?.drySpellCount).toBeGreaterThan(0);
  });

  it("lets a reward pause win over an overlapping idle window", () => {
    const cadence = computeCadence(
      makeStats({
        preciseStartSec: 0,
        lastActivitySec: 400,
        droneTimestamps: [...evenDrones(10, 100, 10), ...evenDrones(300, 400, 10)],
        pauseIntervals: [{ start: 100, end: 300 }],
        idleIntervals: [{ start: 120, end: 280 }],
      }),
    );
    expect(cadence?.segments.some((s) => s.kind === "gap")).toBe(false);
  });

  it("counts drones per segment and finds the busiest minute", () => {
    const cadence = computeCadence(
      makeStats({
        preciseStartSec: 0,
        lastActivitySec: 400,
        // 11 drones inside the first 100s, 3 spread over the last stretch.
        droneTimestamps: [...evenDrones(0, 100, 10), 300, 350, 400],
      }),
    );
    expect(cadence?.busiestMinute?.drones).toBe(6);
    expect(cadence?.busiestMinute?.start).toBe(0);
    const total = cadence?.segments.reduce((sum, s) => sum + s.drones, 0);
    expect(total).toBe(14);
  });

  it("scans a 60s window, so a later burst beats a slower opening", () => {
    const cadence = computeCadence(
      makeStats({
        preciseStartSec: 0,
        lastActivitySec: 400,
        droneTimestamps: [0, 30, 200, 210, 220, 230],
      }),
    );
    expect(cadence?.busiestMinute).toEqual({ start: 200, drones: 4 });
  });

  it("tolerates records with the interval fields absent", () => {
    const legacy = makeStats({
      preciseStartSec: 0,
      lastActivitySec: 200,
      droneTimestamps: evenDrones(10, 200, 10),
    });
    delete legacy.pauseIntervals;
    delete legacy.idleIntervals;
    expect(computeCadence(legacy)?.segments.map((s) => s.kind)).toEqual(["active"]);
  });
});
