import { describe, expect, it, vi } from "vitest";

import type { MarketStatPoint } from "../../../../config/shared/marketStats.js";
import {
  createMedianLoader,
  MIN_TRADE_DAYS,
  ninetyDayMedian,
  type MedianTarget,
} from "../../../../src/lib/tradeWorkbench/medianReference.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 26, 12);
const TODAY = Date.UTC(2026, 8, 26);

function point(
  daysAgo: number,
  median: number,
  volume: number | null,
  rank: number | null = null,
): MarketStatPoint {
  return {
    source: "archive",
    time: TODAY - daysAgo * DAY,
    volume,
    median,
    movingAvg: null,
    avgPrice: null,
    openPrice: null,
    closedPrice: null,
    minPrice: null,
    maxPrice: null,
    donchTop: null,
    donchBot: null,
    rank,
  };
}

function days(medians: number[], volume: number | null = 1, rank: number | null = null) {
  return medians.map((median, index) => point(index + 1, median, volume, rank));
}

const TARGET: MedianTarget = { slug: "parallax_set", rank: null, subtype: null };

describe("ninetyDayMedian", () => {
  it("weights the daily medians by volume when every day has one", () => {
    const points = [...days([10, 10, 10, 10, 10, 10], 1), point(7, 30, 20)];
    expect(ninetyDayMedian(points, null, NOW)).toEqual({ median: 30, days: 7 });
  });

  it("takes the plain median once any day lacks a volume", () => {
    const points = [...days([10, 10, 10, 10, 10, 10], 1), point(7, 30, null)];
    expect(ninetyDayMedian(points, null, NOW)?.median).toBe(10);
  });

  it("matches the plain median when every day traded the same volume", () => {
    const points = days([10, 12, 14, 16, 18, 20, 22, 24], 5);
    expect(ninetyDayMedian(points, null, NOW)?.median).toBe(17);
  });

  it("uses only the row's rank, pooling rank 0 for a rankless row", () => {
    const points = [
      ...days([10, 10, 10, 10, 10, 10, 10], 1, 0),
      ...days([90, 90, 90, 90, 90, 90, 90], 1, 10),
    ];
    expect(ninetyDayMedian(points, 10, NOW)?.median).toBe(90);
    expect(ninetyDayMedian(points, 0, NOW)?.median).toBe(10);
    expect(ninetyDayMedian(points, null, NOW)?.median).toBe(10);
    expect(ninetyDayMedian(points, 5, NOW)).toBeNull();
  });

  it("prefers rankless rows over rank 0 for a rankless row", () => {
    const points = [
      ...days([10, 10, 10, 10, 10, 10, 10], 1, null),
      ...days([50, 50, 50, 50, 50, 50, 50], 1, 0),
    ];
    expect(ninetyDayMedian(points, null, NOW)?.median).toBe(10);
  });

  it("ignores rows older than 90 days", () => {
    const old = [91, 95, 120, 200].map((ago) => point(ago, 500, 50));
    const recent = days([20, 20, 20, 20, 20, 20, 20], 1);
    expect(ninetyDayMedian([...old, ...recent], null, NOW)).toEqual({ median: 20, days: 7 });
    expect(ninetyDayMedian([...old, point(89, 20, 1)], null, NOW)).toBeNull();
  });

  it(`needs ${MIN_TRADE_DAYS} trading days, and a zero-volume day does not count`, () => {
    const six = days([20, 20, 20, 20, 20, 20], 3);
    expect(ninetyDayMedian(six, null, NOW)).toBeNull();
    expect(ninetyDayMedian([...six, point(30, 20, 0)], null, NOW)).toBeNull();
    expect(ninetyDayMedian([...six, point(30, 22, 1)], null, NOW)).toEqual({ median: 20, days: 7 });
  });
});

describe("median loader", () => {
  function history(): MarketStatPoint[] {
    return [
      ...days([20, 20, 20, 20, 20, 20, 20], 1, null),
      ...days([60, 60, 60, 60, 60, 60, 60], 1, 5),
    ];
  }

  it("fetches a slug's history once and caches each rank for the session", async () => {
    const fetchHistory = vi.fn(async () => history());
    const loader = createMedianLoader({ fetch48h: vi.fn(), fetchHistory, now: () => NOW });
    const ranked = { ...TARGET, rank: 5 };

    await loader.load("median-90d", [TARGET, ranked]);
    await loader.load("median-90d", [TARGET, ranked]);

    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(loader.peek("median-90d", TARGET)).toEqual({ median: 20, days: 7 });
    expect(loader.peek("median-90d", ranked)).toEqual({ median: 60, days: 7 });
    expect(loader.peek("median-48h", TARGET)).toBeNull();
  });

  it("survives a failed fetch and asks again on the next load", async () => {
    const fetchHistory = vi
      .fn<(slug: string) => Promise<MarketStatPoint[] | null>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(null)
      .mockResolvedValue(history());
    const other = { ...TARGET, slug: "other_set" };
    const loader = createMedianLoader({ fetch48h: vi.fn(), fetchHistory, now: () => NOW });

    await loader.load("median-90d", [TARGET, other]);
    expect(loader.peek("median-90d", TARGET)).toBeNull();
    expect(loader.peek("median-90d", other)).toBeNull();

    await loader.load("median-90d", [TARGET, other]);
    expect(fetchHistory).toHaveBeenCalledTimes(4);
    expect(loader.peek("median-90d", TARGET)?.median).toBe(20);
    expect(loader.peek("median-90d", other)?.median).toBe(20);
  });

  it("treats an empty history as no price", async () => {
    const loader = createMedianLoader({
      fetch48h: vi.fn(),
      fetchHistory: async () => [],
      now: () => NOW,
    });
    await loader.load("median-90d", [TARGET]);
    expect(loader.peek("median-90d", TARGET)).toBeNull();
  });

  it("never runs more fetches at once than its cap", async () => {
    let active = 0;
    let peak = 0;
    const fetchHistory = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return history();
    });
    const loader = createMedianLoader({
      fetch48h: vi.fn(),
      fetchHistory,
      now: () => NOW,
      concurrency: 2,
    });
    const targets = Array.from({ length: 7 }, (_, index) => ({ ...TARGET, slug: `item_${index}` }));

    await loader.load("median-90d", targets);

    expect(fetchHistory).toHaveBeenCalledTimes(7);
    expect(peak).toBe(2);
  });

  it("reads the 48h price per rank on every load and maps a miss to no price", async () => {
    const fetch48h = vi
      .fn<(slug: string, rank: number | null) => Promise<number | null>>()
      .mockResolvedValueOnce(41)
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(43);
    const loader = createMedianLoader({ fetch48h, fetchHistory: vi.fn(), now: () => NOW });
    const ranked = { ...TARGET, rank: 3 };

    await loader.load("median-48h", [TARGET]);
    expect(loader.peek("median-48h", TARGET)).toEqual({ median: 41, days: null });
    await loader.load("median-48h", [ranked]);
    expect(loader.peek("median-48h", ranked)).toBeNull();
    await loader.load("median-48h", [ranked]);
    expect(loader.peek("median-48h", ranked)?.median).toBe(43);
    expect(fetch48h).toHaveBeenLastCalledWith("parallax_set", 3);
  });

  it("starts no further request once its load is cancelled", async () => {
    let stopped = false;
    const fetchHistory = vi.fn(async () => {
      stopped = true;
      return history();
    });
    const loader = createMedianLoader({
      fetch48h: vi.fn(),
      fetchHistory,
      now: () => NOW,
      concurrency: 1,
    });
    const targets = Array.from({ length: 3 }, (_, index) => ({ ...TARGET, slug: `item_${index}` }));

    await loader.load("median-90d", targets, () => true);
    expect(fetchHistory).not.toHaveBeenCalled();
    await loader.load("median-90d", targets, () => stopped);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it("gives a row with a subtype no median and fetches nothing for it", async () => {
    const fetchHistory = vi.fn(async () => history());
    const fetch48h = vi.fn(async () => 40);
    const loader = createMedianLoader({ fetch48h, fetchHistory, now: () => NOW });
    const relic = { slug: "axi_a1_relic", rank: null, subtype: "radiant" };

    await loader.load("median-90d", [relic]);
    await loader.load("median-48h", [relic]);
    await loader.load("match-cheapest", [TARGET]);

    expect(fetchHistory).not.toHaveBeenCalled();
    expect(fetch48h).not.toHaveBeenCalled();
    expect(loader.peek("median-90d", relic)).toBeNull();
  });
});
