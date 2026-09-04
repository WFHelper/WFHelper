import { describe, expect, it } from "vitest";

import {
  dpmSeries,
  dronesPerRotation,
  formatBytes,
  formatClock,
  formatDuration,
  missionKindLabel,
  overlapSeconds,
  relativePerformanceHue,
  rotationClearCells,
  saturationAboveThresholdPct,
  bucketSuccessMixPct,
  thresholdHue,
  waveClearCells,
} from "../../../../src/lib/arbi/arbiChartData.js";
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

describe("formatDuration", () => {
  it("formats hours, minutes and seconds", () => {
    expect(formatDuration(3725)).toBe("1h 2m 5s");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(0)).toBe("0m 0s");
  });
});

describe("formatBytes", () => {
  it("scales to sensible units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("dronesPerRotation", () => {
  it("buckets drones by reward boundaries", () => {
    const stats = makeStats({
      droneTimestamps: [10, 20, 90, 110, 250],
      rewardTimestamps: [100, 200, 300],
    });
    expect(dronesPerRotation(stats)).toEqual([3, 1, 1]);
  });
});

describe("dpmSeries", () => {
  it("computes per-rotation DPM from the precise start", () => {
    const stats = makeStats({
      preciseStartSec: 0,
      droneTimestamps: [10, 20, 30, 70, 80, 110],
      rewardTimestamps: [60, 120],
      lastActivitySec: 120,
    });
    // rotation 1: 3 drones in 60s = 3/min; rotation 2: 3 drones in 60s = 3/min
    expect(dpmSeries(stats)).toEqual([3, 3]);
  });

  it("returns empty without rotations", () => {
    expect(dpmSeries(makeStats({ droneTimestamps: [1, 2] }))).toEqual([]);
  });

  it("falls back to the first drone when the recorded start is after reward 1", () => {
    const stats = makeStats({
      preciseStartSec: 130,
      droneTimestamps: [10, 20, 30, 70, 80, 110],
      rewardTimestamps: [120, 240],
      lastActivitySec: 240,
    });
    // start falls back to drone[0]=10: rotation 1 covers 6 drones in 110s,
    // not 6 drones in a clamped 10s window (which read as 36 DPM).
    const [r1, r2] = dpmSeries(stats);
    expect(r1).toBeCloseTo(6 / (110 / 60), 5);
    expect(r2).toBe(0);
  });
});

describe("formatClock", () => {
  it("formats m:ss and floors at zero", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(600)).toBe("10:00");
    expect(formatClock(-5)).toBe("0:00");
  });
});

describe("overlapSeconds", () => {
  it("sums only the part of each interval inside the window", () => {
    const intervals = [
      { start: 0, end: 10 },
      { start: 50, end: 70 },
      { start: 200, end: 210 },
    ];
    expect(overlapSeconds(intervals, 5, 60)).toBe(15);
    expect(overlapSeconds(intervals, 100, 150)).toBe(0);
    expect(overlapSeconds([], 0, 10)).toBe(0);
  });
});

describe("clear map cells", () => {
  it("times rotations reward to reward, minus the reward screens", () => {
    const stats = makeStats({
      preciseStartSec: 0,
      droneTimestamps: [10],
      rewardTimestamps: [60, 120],
      lastActivitySec: 120,
      pauseIntervals: [{ start: 50, end: 70 }],
      rotationSaturationPct: [40, 60],
    });
    expect(rotationClearCells(stats)).toEqual([
      { index: 1, durationSec: 50, saturationPct: 40 },
      { index: 2, durationSec: 50, saturationPct: 60 },
    ]);
  });

  it("reports a null saturation share when the record predates it", () => {
    const stats = makeStats({
      preciseStartSec: 0,
      rewardTimestamps: [60],
      lastActivitySec: 60,
    });
    expect(rotationClearCells(stats)).toEqual([{ index: 1, durationSec: 60, saturationPct: null }]);
  });

  it("passes wave and round timings straight through", () => {
    const stats = makeStats({
      waves: [
        { index: 1, durationSec: 30, saturationPct: 12.5 },
        { index: 2, durationSec: 40 },
      ],
    });
    expect(waveClearCells(stats)).toEqual([
      { index: 1, durationSec: 30, saturationPct: 12.5 },
      { index: 2, durationSec: 40, saturationPct: null },
    ]);
    expect(waveClearCells(makeStats())).toEqual([]);
  });
});

describe("saturation helpers", () => {
  const buckets = [
    { minCount: 0, label: "0-2", seconds: 30, pct: 30 },
    { minCount: 15, label: "15-17", seconds: 50, pct: 50 },
    { minCount: 27, label: "27+", seconds: 20, pct: 20 },
  ];

  it("computes time share above a threshold", () => {
    expect(saturationAboveThresholdPct(buckets, 15)).toBeCloseTo(70, 6);
    expect(saturationAboveThresholdPct(buckets, 27)).toBeCloseTo(20, 6);
    expect(saturationAboveThresholdPct([], 15)).toBe(0);
  });

  it("maps bucket index and threshold pct to hues", () => {
    expect(bucketSuccessMixPct(0)).toBe(100);
    expect(bucketSuccessMixPct(9)).toBe(0);
    expect(thresholdHue(0)).toBe(120);
    expect(thresholdHue(18)).toBe(0);
    expect(thresholdHue(100)).toBe(0);
  });
});

describe("relativePerformanceHue", () => {
  it("spans red to green across the range", () => {
    expect(relativePerformanceHue(0, 0, 10)).toBe(0);
    expect(relativePerformanceHue(10, 0, 10)).toBe(120);
    expect(relativePerformanceHue(5, 5, 5)).toBe(0);
  });
});

describe("missionKindLabel", () => {
  it("names known other-type modes and strips the prefix from unknown ones", () => {
    expect(missionKindLabel({ missionType: "other", missionTypeRaw: "MT_PURIFY" })).toBe(
      "Infested Salvage",
    );
    expect(missionKindLabel({ missionType: "other", missionTypeRaw: "MT_FUTURE_MODE" })).toBe(
      "FUTURE_MODE",
    );
  });

  it("defers to the i18n label for full-stats types and missing raw types", () => {
    expect(missionKindLabel({ missionType: "defense", missionTypeRaw: "MT_DEFENSE" })).toBeNull();
    expect(missionKindLabel({ missionType: "other", missionTypeRaw: null })).toBeNull();
    expect(missionKindLabel({ missionType: "other" })).toBeNull();
  });
});
