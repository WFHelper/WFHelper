import { describe, expect, it } from "vitest";

import { computePinnedTotals } from "../../../src/lib/pinnedSummary.js";

const FERRITE = "/Lotus/Types/Items/MiscItems/Ferrite";
const MORPHICS = "/Lotus/Types/Items/MiscItems/Morphics";

const entries = [
  {
    source: "blueprint",
    uniqueName: "/Lotus/Types/Recipes/NyxChassis",
    buildPrice: 15_000,
    ingredients: [
      { uniqueName: FERRITE, count: 300 },
      { uniqueName: MORPHICS, count: 1 },
    ],
  },
  {
    source: "blueprint",
    uniqueName: "/Lotus/Types/Recipes/NyxSystems",
    buildPrice: 15_000,
    ingredients: [
      { uniqueName: FERRITE, count: 500 },
      { uniqueName: MORPHICS, count: 1 },
    ],
  },
  {
    source: "blueprint",
    uniqueName: "/Lotus/Types/Recipes/Unpinned",
    buildPrice: 99_000,
    ingredients: [{ uniqueName: FERRITE, count: 9999 }],
  },
  {
    source: "building",
    uniqueName: "/Lotus/Types/Recipes/NyxChassis",
    buildPrice: 15_000,
    ingredients: [{ uniqueName: FERRITE, count: 300 }],
  },
];

describe("computePinnedTotals", () => {
  it("sums needs and credits across pinned blueprints only", () => {
    const pinned = new Set(["/Lotus/Types/Recipes/NyxChassis", "/Lotus/Types/Recipes/NyxSystems"]);
    const owned = new Map([
      [FERRITE, 600],
      [MORPHICS, 5],
    ]);
    const totals = computePinnedTotals(entries, pinned, (un) => owned.get(un) ?? 0);

    expect(totals.count).toBe(2);
    expect(totals.credits).toBe(30_000);
    expect(totals.resources).toEqual([
      { uniqueName: FERRITE, needed: 800, owned: 600 },
      { uniqueName: MORPHICS, needed: 2, owned: 5 },
    ]);
    expect(totals.missing).toEqual([{ uniqueName: FERRITE, needed: 800, owned: 600 }]);
  });

  it("returns an empty summary with nothing pinned", () => {
    const totals = computePinnedTotals(entries, new Set(), () => 0);
    expect(totals.count).toBe(0);
    expect(totals.resources).toHaveLength(0);
    expect(totals.missing).toHaveLength(0);
  });
});
