import { describe, expect, it } from "vitest";

import { isValidSnapshotBlob } from "../../config/shared/wfmSnapshotValidation";

const BASE_TIME = Date.UTC(2026, 4, 2, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

function snapshotWithEntryAge(ageMs: number): unknown {
  const timestamp = BASE_TIME - ageMs;
  return {
    version: 1,
    generatedAt: BASE_TIME,
    prices: {
      long_tail_scene: {
        status: "ok",
        median: 5,
        timestamp,
      },
    },
    meta: {},
    orderSummaries: {},
  };
}

describe("isValidSnapshotBlob", () => {
  it("accepts long-tail entries within the worker snapshot freshness contract", () => {
    expect(isValidSnapshotBlob(snapshotWithEntryAge(44 * DAY_MS), BASE_TIME)).toBe(true);
  });

  it("rejects entries beyond the worker snapshot freshness contract", () => {
    expect(isValidSnapshotBlob(snapshotWithEntryAge(46 * DAY_MS), BASE_TIME)).toBe(false);
  });
});
