import { describe, expect, it } from "vitest";

import * as sharedStats from "../../config/shared/wfmStats";

import { __test__ as rendererWfmPriceTest } from "../../src/lib/wfm/wfmPrice.js";

const canonicalStatsPayload = {
  payload: {
    statistics_closed: {
      "48hours": [
        { datetime: "2026-01-01T08:00:00Z", order_type: "sell", median: 21 },
        { datetime: "2026-01-01T09:00:00Z", order_type: "buy", median: 999 },
      ],
    },
    statistics_live: {
      "48_hours": [{ datetime: "2026-01-01T10:00:00Z", order_type: "sell", moving_avg: 24 }],
    },
  },
};

describe("shared parser parity", () => {
  it("extracts the same median across shared and renderer codepaths", () => {
    const expected = 24;

    expect(sharedStats.extractMedianFromStatsPayload(canonicalStatsPayload)).toBe(expected);
    expect(rendererWfmPriceTest.extractMedianFromStatsPayload(canonicalStatsPayload)).toBe(
      expected,
    );
  });
});
