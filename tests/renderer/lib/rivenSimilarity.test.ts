import { describe, expect, it } from "vitest";

import { computeRivenStatSimilarity } from "../../../renderer/riven-similarity.js";

describe("computeRivenStatSimilarity", () => {
  it("matches normalized and partially expanded stat names", () => {
    const result = computeRivenStatSimilarity(
      ["critical chance", "damage"],
      [{ name: "critical chance" }, { name: "base damage / melee damage" }],
    );

    expect(result.pct).toBe(100);
    expect(result.matchedNames).toEqual(
      new Set(["critical chance", "base damage / melee damage"]),
    );
  });

  it("penalizes unmatched stats on either side", () => {
    const result = computeRivenStatSimilarity(
      ["critical chance", "damage"],
      [{ name: "critical chance" }, { name: "multishot" }],
    );

    expect(result.pct).toBe(33);
  });
});
