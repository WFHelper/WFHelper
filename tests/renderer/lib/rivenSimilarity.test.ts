import { describe, expect, it } from "vitest";

import {
  canonicalRivenStatName,
  computeRivenStatSimilarity,
  formatRivenListingStatValue,
} from "../../../renderer/riven-similarity.js";

describe("computeRivenStatSimilarity", () => {
  it("matches normalized and partially expanded stat names", () => {
    const result = computeRivenStatSimilarity(
      ["critical chance", "damage"],
      [{ name: "critical chance" }, { name: "base damage / melee damage" }],
    );

    expect(result.pct).toBe(100);
    expect(result.matchedNames).toEqual(new Set(["critical chance", "base damage / melee damage"]));
  });

  it("penalizes unmatched stats on either side", () => {
    const result = computeRivenStatSimilarity(
      ["critical chance", "damage"],
      [{ name: "critical chance" }, { name: "multishot" }],
    );

    expect(result.pct).toBe(33);
  });
});

describe("canonicalRivenStatName", () => {
  it("merges names that share one underlying attribute", () => {
    expect(canonicalRivenStatName("Attack Speed")).toBe("fire rate");
    expect(canonicalRivenStatName("Fire Rate")).toBe("fire rate");
    expect(canonicalRivenStatName("Melee Damage")).toBe("damage");
    expect(canonicalRivenStatName("Critical Chance for Slide Attack")).toBe("slide attack");
    expect(canonicalRivenStatName("Recoil")).toBe("weapon recoil");
    expect(canonicalRivenStatName("Heavy Attack")).toBe("heavy attack efficiency");
  });

  it("keeps distinct stats distinct - no substring merging", () => {
    expect(canonicalRivenStatName("Critical Damage")).toBe("critical damage");
    expect(canonicalRivenStatName("Damage")).toBe("damage");
    expect(canonicalRivenStatName("Critical Damage")).not.toBe(canonicalRivenStatName("Damage"));
    expect(canonicalRivenStatName("Zoom")).toBe("zoom");
  });

  it("normalizes case and whitespace, tolerates null", () => {
    expect(canonicalRivenStatName(" ATTACK SPEED ")).toBe("fire rate");
    expect(canonicalRivenStatName(null)).toBe("");
  });
});

describe("formatRivenListingStatValue", () => {
  it("prints the sign WFM sends, not the buff or curse side", () => {
    expect(formatRivenListingStatValue({ name: "Zoom", value: -4.4 })).toBe("−4%");
    expect(formatRivenListingStatValue({ name: "Weapon Recoil", value: 4.6 })).toBe("+5%");
    expect(formatRivenListingStatValue({ name: "Critical Damage", value: 110 })).toBe("+110%");
    expect(formatRivenListingStatValue({ name: "Multishot", value: -30.2 })).toBe("−30%");
  });

  it("prints faction damage as the multiplier WFM sends", () => {
    expect(formatRivenListingStatValue({ name: "Damage Vs Grineer", value: 0.98 })).toBe("x0.98");
    expect(formatRivenListingStatValue({ name: "damage vs corpus", value: 1.1 })).toBe("x1.10");
  });
});
