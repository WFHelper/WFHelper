import { afterEach, describe, expect, it, vi } from "vitest";

import * as wfmStats from "../../services/wfmStats";
import * as wfmStatsPrice from "../../services/wfmStatsPrice";

describe("wfm stats helpers", () => {
  afterEach(() => {
    wfmStatsPrice.__test__.clearCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("extracts the latest sell median from payload", () => {
    const value = wfmStats.extractMedianFromStatsPayload({
      payload: {
        statistics_closed: {
          "48hours": [
            { datetime: "2025-01-01T10:00:00Z", median: 7, order_type: "sell" },
            { datetime: "2025-01-01T11:00:00Z", median: 9, order_type: "buy" },
          ],
        },
        statistics_live: {
          "48_hours": [{ datetime: "2025-01-01T12:00:00Z", moving_avg: 11, order_type: "sell" }],
        },
      },
    });

    expect(value).toBe(11);
  });

  it("returns null when stats endpoint response is not OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      }),
    );

    await expect(wfmStatsPrice.fetchPriceBySlug("soma_prime_receiver")).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caches successful results and avoids duplicate fetches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          payload: {
            statistics_closed: {
              "48hours": [{ datetime: "2025-01-01T12:00:00Z", median: 42, order_type: "sell" }],
            },
          },
        }),
      }),
    );

    const first = await wfmStatsPrice.fetchPriceBySlug("Soma_Prime_Receiver");
    const second = await wfmStatsPrice.fetchPriceBySlug("soma_prime_receiver");

    expect(first).toBe(42);
    expect(second).toBe(42);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
