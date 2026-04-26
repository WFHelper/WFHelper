import { afterEach, describe, expect, it, vi } from "vitest";

import * as wfmStats from "../../config/shared/wfmStats";
import * as wfmStatsPrice from "../../services/wfmStatsPrice";
import * as wfmClient from "../../services/wfmClient";

describe("wfm stats helpers", () => {
  afterEach(() => {
    wfmStatsPrice.__test__.clearCache();
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

  it("returns null when stats endpoint request throws", async () => {
    const requestSpy = vi
      .spyOn(wfmClient, "request")
      .mockRejectedValue(new wfmClient.WfmApiError("HTTP 503", "WFM_API_ERROR", 503));

    await expect(wfmStatsPrice.fetchPriceBySlug("soma_prime_receiver")).resolves.toBeNull();
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("caches successful results and avoids duplicate fetches", async () => {
    const requestSpy = vi.spyOn(wfmClient, "request").mockResolvedValue({
      payload: {
        statistics_closed: {
          "48hours": [{ datetime: "2025-01-01T12:00:00Z", median: 42, order_type: "sell" }],
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
