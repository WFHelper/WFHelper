import { describe, expect, it } from "vitest";

import { PET_TRAITS } from "../../src/data/petTraits.js";

const HEX = /^#[0-9a-f]{6}$/;
const LOCALES = ["en", "de", "zh"] as const;

describe("generated pet trait table", () => {
  it("carries every pet fur colour DE names", () => {
    const entries = Object.entries(PET_TRAITS.colors);
    expect(entries.length).toBeGreaterThanOrEqual(140);

    for (const [uniqueName, color] of entries) {
      expect(uniqueName.startsWith("/Lotus/")).toBe(true);
      expect(color.hex, uniqueName).toMatch(HEX);
      for (const locale of LOCALES) {
        expect(color.name[locale].trim(), `${uniqueName} ${locale}`).not.toBe("");
      }
    }
  });

  it("carries the fur patterns live pets use", () => {
    const entries = Object.entries(PET_TRAITS.patterns);
    expect(entries.length).toBeGreaterThanOrEqual(12);

    for (const [uniqueName, pattern] of entries) {
      expect(uniqueName).toMatch(/\/Patterns\//);
      for (const locale of LOCALES) {
        expect(pattern.name[locale].trim(), `${uniqueName} ${locale}`).not.toBe("");
      }
    }
  });

  it("keeps both tables sorted so a rebuild produces a readable diff", () => {
    for (const table of [PET_TRAITS.colors, PET_TRAITS.patterns]) {
      const keys = Object.keys(table);
      expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
    }
  });
});
