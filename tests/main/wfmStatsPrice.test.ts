import { afterEach, describe, expect, it, vi } from "vitest";

import * as wfmStats from "../../config/shared/wfmStats";
import * as wfmStatsPrice from "../../services/wfmStatsPrice";
import * as wfmClient from "../../services/wfmClient";
import { WfmApiError } from "../../services/wfmTypes";

describe("wfm stats helpers", () => {
  const now = Date.parse("2026-09-08T12:00:00Z");
  const row = (hours: number, wa_price: unknown, volume: unknown, rest = {}) => ({
    datetime: new Date(now - hours * 3600000).toISOString(),
    wa_price,
    volume,
    ...rest,
  });
  const average = (rows: unknown[], rank?: number) =>
    wfmStats.extractAverageFromStatsPayload(
      {
        payload: { statistics_closed: { "48hours": rows } },
      },
      { now, ...(rank == null ? {} : { rank }) },
    );

  it("rejects stale, future, malformed, empty and fallback-only samples", () => {
    expect(
      average([
        null,
        row(49, 100, 100),
        row(-1, 100, 100),
        row(1, -10, 1),
        row(1, 10, 0),
        row(1, true, 1),
        row(1, undefined, 1, { median: 50, min_price: 10, avg_price: 30 }),
      ]),
    ).toBeNull();
    expect(average([row(1, 10, 1, { datetime: "invalid" }), row(1, 10, Infinity)])).toBeNull();
  });

  it("keeps rank pools separate and defaults ranked items to unranked", () => {
    const rows = [row(1, 10, 2, { mod_rank: 0 }), row(1, 100, 4, { mod_rank: 10 })];
    expect(average(rows)?.average).toBe(10);
    expect(average(rows, 10)?.average).toBe(100);
    expect(average(rows, 5)).toBeNull();
    expect(average([row(1, 100, 1)], 10)).toBeNull();
  });

  it("counts duplicated buckets once and rounds only the final weighted result", () => {
    expect(average([row(2, 10.4, 1), row(2, 10.4, 1), row(1, 12.4, 3)])).toMatchObject({
      average: 12,
      volume: 4,
      timestamp: now - 3600000,
    });
  });

  const book = (rank: number | null, medians: number[], orderType = "sell") =>
    medians.map((median, index) => ({
      datetime: new Date(now - index * 3600000).toISOString(),
      order_type: orderType,
      median,
      ...(rank == null ? {} : { mod_rank: rank }),
    }));
  const history = (rank: number | null, entries: Array<[days: number, median: number]>) =>
    entries.map(([days, median]) => ({
      datetime: new Date(now - days * 86400000).toISOString(),
      median,
      wa_price: median,
      volume: 1,
      ...(rank == null ? {} : { mod_rank: rank }),
    }));
  const averageWith = (
    rows: unknown[],
    stats: { live?: unknown[]; days?: unknown[] },
    rank?: number,
  ) =>
    wfmStats.extractAverageFromStatsPayload(
      {
        payload: {
          statistics_closed: { "48hours": rows, "90days": stats.days ?? [] },
          statistics_live: { "48hours": stats.live ?? [] },
        },
      },
      { now, ...(rank == null ? {} : { rank }) },
    );

  it("drops a fake close far above the live sell book of its rank", () => {
    const live = [...book(0, [5, 5, 10, 4]), ...book(5, [30, 24]), ...book(0, [900], "buy")];
    const fake = row(4, 69420, 1, { mod_rank: 0 });

    expect(averageWith([fake], { live }, 0)).toBeNull();
    expect(averageWith([fake], { live })).toBeNull();
    expect(averageWith([fake, row(2, 5, 3, { mod_rank: 0 })], { live }, 0)).toMatchObject({
      average: 5,
      volume: 3,
      timestamp: now - 2 * 3600000,
    });
    expect(averageWith([row(1, 45, 1, { mod_rank: 0 })], { live }, 0)?.average).toBe(45);
    expect(averageWith([row(1, 250, 1, { mod_rank: 5 })], { live }, 5)?.average).toBe(250);
    expect(averageWith([row(1, 400, 1, { mod_rank: 5 })], { live }, 5)).toBeNull();
  });

  it("falls back to the closed history before the window when no book exists", () => {
    const fake = row(4, 69420, 1);
    const days = history(null, [
      [30, 4],
      [20, 5],
      [10, 5],
      [1, 69420],
    ]);

    expect(averageWith([fake], { days })).toBeNull();
    expect(averageWith([fake], { days: history(null, [[1, 69420]]) })?.average).toBe(69420);
    expect(averageWith([fake], { days: history(3, [[30, 4]]) })?.average).toBe(69420);
    expect(averageWith([fake], {})?.average).toBe(69420);
  });
  afterEach(() => {
    wfmStatsPrice.__test__.clearCache();
    vi.restoreAllMocks();
  });

  it("weights closed sales across the window and ignores live listings", () => {
    const value = wfmStats.extractAverageFromStatsPayload(
      {
        payload: {
          statistics_closed: {
            "48hours": [
              { datetime: "2025-01-01T10:00:00Z", wa_price: 10, volume: 9 },
              { datetime: "2025-01-01T11:00:00Z", wa_price: 30, volume: 1 },
              { datetime: "2025-01-01T11:00:00Z", wa_price: 100, volume: 100, order_type: "buy" },
            ],
          },
          statistics_live: {
            "48_hours": [
              { datetime: "2025-01-01T12:00:00Z", wa_price: 999, volume: 1000, order_type: "sell" },
            ],
          },
        },
      },
      { now: Date.parse("2025-01-01T12:00:00Z") },
    );

    expect(value).toMatchObject({ average: 12, volume: 10 });
  });

  it("returns null when stats endpoint request throws", async () => {
    const requestSpy = vi
      .spyOn(wfmClient, "request")
      .mockRejectedValue(new WfmApiError("HTTP 503", "WFM_API_ERROR", 503));

    await expect(wfmStatsPrice.fetchPriceBySlug("soma_prime_receiver")).resolves.toBeNull();
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("caches successful results and avoids duplicate fetches", async () => {
    const requestSpy = vi.spyOn(wfmClient, "request").mockResolvedValue({
      payload: {
        statistics_closed: {
          "48hours": [
            { datetime: new Date().toISOString(), wa_price: 42, volume: 1, order_type: "sell" },
          ],
        },
      },
    });

    const first = await wfmStatsPrice.fetchPriceBySlug("Soma_Prime_Receiver");
    const second = await wfmStatsPrice.fetchPriceBySlug("soma_prime_receiver");

    expect(first).toBe(42);
    expect(second).toBe(42);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });
});
