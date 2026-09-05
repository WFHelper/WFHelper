import { describe, expect, it } from "vitest";

import { dropRarityColour, formatDropChance } from "../../../src/lib/dropDisplay.js";

describe("dropRarityColour", () => {
  it("maps every rarity the drop tables spell", () => {
    expect(dropRarityColour("Common")).toBe("var(--rarity-common)");
    expect(dropRarityColour("Uncommon")).toBe("var(--rarity-uncommon)");
    expect(dropRarityColour("Rare")).toBe("var(--rarity-rare)");
    expect(dropRarityColour("Legendary")).toBe("var(--rarity-rare)");
  });

  it("falls back to muted for an unknown or empty rarity", () => {
    expect(dropRarityColour("Mythic")).toBe("var(--text-muted)");
    expect(dropRarityColour("")).toBe("var(--text-muted)");
  });
});

describe("formatDropChance", () => {
  it("keeps two decimals and drops trailing zeroes", () => {
    expect(formatDropChance(11.06)).toBe("11.06%");
    expect(formatDropChance(2.5)).toBe("2.5%");
    expect(formatDropChance(0.6667)).toBe("0.67%");
    expect(formatDropChance(0)).toBe("0%");
  });

  it("renders nothing for a non-finite chance", () => {
    expect(formatDropChance(Number.NaN)).toBe("");
    expect(formatDropChance(Number.POSITIVE_INFINITY)).toBe("");
  });
});
