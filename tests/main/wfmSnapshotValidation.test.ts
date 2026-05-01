import { describe, expect, it } from "vitest";

import { isValidSnapshotBlob } from "../../config/shared/wfmSnapshotValidation";

const BASE_TIME = Date.UTC(2026, 4, 2, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

function snapshotWithPrice(price: unknown): unknown {
  return {
    version: 1,
    generatedAt: BASE_TIME,
    prices: {
      long_tail_scene: price,
    },
    meta: {},
    orderSummaries: {},
  };
}

function snapshotWithOkEntryAge(ageMs: number): unknown {
  const timestamp = BASE_TIME - ageMs;
  return snapshotWithPrice({
    status: "ok",
    median: 5,
    timestamp,
  });
}

describe("isValidSnapshotBlob", () => {
  it("accepts inactive no-data price markers", () => {
    expect(
      isValidSnapshotBlob(
        snapshotWithPrice({
          status: "no_data",
          median: null,
          timestamp: BASE_TIME,
        }),
        BASE_TIME,
      ),
    ).toBe(true);
  });

  it("rejects stale ok price entries", () => {
    expect(isValidSnapshotBlob(snapshotWithOkEntryAge(31 * DAY_MS), BASE_TIME)).toBe(false);
  });
});
