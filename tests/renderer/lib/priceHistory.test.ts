import { describe, expect, it, vi } from "vitest";

import { MARKET_STATS_MAX_POINTS } from "../../../config/shared/marketStats";
import { fetchBackendPriceHistory, parsePriceHistoryRows } from "../../../src/lib/wfm/priceHistory";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../../src/lib/wfm/backendLite", () => ({ fetchBackendRaw: mocks.fetch }));

const NOW = Date.UTC(2026, 8, 8, 12);
const DAY = 86_400_000;

function body(rows: unknown[]): unknown {
  return { ok: true, slug: "forma", generatedAt: NOW, rows };
}

describe("parsePriceHistoryRows", () => {
  it("aborts an archive body that stalls after its headers arrive", async () => {
    vi.useFakeTimers();
    let bodySignal: AbortSignal | undefined;
    mocks.fetch.mockImplementationOnce(async (_path, { signal }: { signal: AbortSignal }) => {
      bodySignal = signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason));
          },
        }),
      );
    });
    try {
      const pending = fetchBackendPriceHistory("forma");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toBeNull();
      expect(bodySignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps the daily median without inventing other price measurements", () => {
    const [point] = parsePriceHistoryRows(body([["2026-09-01", null, 12.5, 4]]), NOW);

    expect(point).toEqual({
      source: "archive",
      time: Date.UTC(2026, 8, 1),
      volume: 4,
      median: 12.5,
      movingAvg: null,
      avgPrice: null,
      openPrice: null,
      closedPrice: null,
      minPrice: null,
      maxPrice: null,
      donchTop: null,
      donchBot: null,
      rank: null,
    });
  });

  it("keeps the rank and leaves a missing volume unknown", () => {
    const points = parsePriceHistoryRows(
      body([
        ["2026-09-01", 0, 50, null],
        ["2026-09-01", 10, 200, 2],
      ]),
      NOW,
    );

    expect(points.map((entry) => [entry.rank, entry.median, entry.volume])).toEqual([
      [0, 50, null],
      [10, 200, 2],
    ]);
  });

  it("drops rows with a bad date, an out-of-range rank or an unusable price", () => {
    const points = parsePriceHistoryRows(
      body([
        ["2026-13-01", null, 10, 1],
        ["01-09-2026", null, 10, 1],
        ["2026-09-01", 21, 10, 1],
        ["2026-09-01", 1.5, 10, 1],
        ["2026-09-01", null, 0, 1],
        ["2026-09-01", null, "10", 1],
        ["2026-09-01", null, 10, -1],
        ["2026-09-01", null, 10],
        ["2026-09-01", null],
        "2026-09-01",
      ]),
      NOW,
    );

    expect(points.map((entry) => [entry.median, entry.volume])).toEqual([[10, null]]);
  });

  it("drops a day past tomorrow", () => {
    const future = new Date(NOW + 3 * DAY).toISOString().slice(0, 10);
    expect(parsePriceHistoryRows(body([[future, null, 10, 1]]), NOW)).toEqual([]);
  });

  it("keeps the newest days at the row cap", () => {
    const rows = Array.from({ length: MARKET_STATS_MAX_POINTS + 50 }, (_, index) => [
      new Date(NOW - index * DAY).toISOString().slice(0, 10),
      null,
      10,
      1,
    ]);
    const points = parsePriceHistoryRows(body(rows), NOW);
    expect(points).toHaveLength(MARKET_STATS_MAX_POINTS);
    const newest = Date.parse(`${new Date(NOW).toISOString().slice(0, 10)}T00:00:00.000Z`);
    expect(points[points.length - 1].time).toBe(newest);
    expect(points[0].time).toBe(newest - (MARKET_STATS_MAX_POINTS - 1) * DAY);
  });

  it("returns nothing for a payload that is not a price-history body", () => {
    expect(parsePriceHistoryRows(null, NOW)).toEqual([]);
    expect(parsePriceHistoryRows("rows", NOW)).toEqual([]);
    expect(parsePriceHistoryRows([["2026-09-01", null, 10, 1]], NOW)).toEqual([]);
    expect(parsePriceHistoryRows({ ok: false, rows: [["2026-09-01", null, 10, 1]] }, NOW)).toEqual(
      [],
    );
    expect(parsePriceHistoryRows({ ok: true, rows: "none" }, NOW)).toEqual([]);
  });
});
