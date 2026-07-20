import { describe, expect, it } from "vitest";

import { applySharedFiltersAndSort, matchesSharedFilters } from "../../../src/lib/filters.js";
import type { SharedFiltersState } from "../../../src/types/filters.js";

function defaultFilters(): SharedFiltersState {
  return {
    search: "",
    primeMode: "all",
    masteredMode: "all",
    sortBy: "name",
    sortDirection: "asc",
    orderPlaced: "all",
    vaulted: "all",
    partType: "all",
    favorite: "all",
    minimumPlatinum: 0,
    setComplete: "all",
    equipped: "all",
    leveledUp: "all",
    subsumed: "all",
  };
}

describe("shared filters", () => {
  it("matches search, prime mode, and mastered mode", () => {
    const item = {
      name: "Soma Prime",
      internalName: "/Lotus/Weapons/SomaPrime",
      category: "primary",
      isPrime: true,
      rank: 30,
      maxRank: 30,
    };

    const filters: SharedFiltersState = {
      ...defaultFilters(),
      search: "soma",
      primeMode: "prime",
      masteredMode: "mastered",
    };

    expect(matchesSharedFilters(item, filters)).toBe(true);
    expect(matchesSharedFilters(item, { ...filters, search: "boltor" })).toBe(false);
    expect(matchesSharedFilters(item, { ...filters, primeMode: "non_prime" })).toBe(false);
    expect(matchesSharedFilters(item, { ...filters, masteredMode: "not_mastered" })).toBe(false);
  });

  it("sorts by name with direction", () => {
    const items = [{ name: "B" }, { name: "A" }, { name: "C" }];

    const asc = applySharedFiltersAndSort(items, defaultFilters());
    const desc = applySharedFiltersAndSort(items, {
      ...defaultFilters(),
      sortDirection: "desc",
    });

    expect(asc.map((row) => row.name)).toEqual(["A", "B", "C"]);
    expect(desc.map((row) => row.name)).toEqual(["C", "B", "A"]);
  });

  it("sorts by platinum and enforces minimum platinum", () => {
    const items = [
      { name: "Item A", platinum: 20 },
      { name: "Item B", platinum: 5 },
      { name: "Item C", platinum: 12 },
    ];

    const sorted = applySharedFiltersAndSort(items, {
      ...defaultFilters(),
      sortBy: "platinum",
      sortDirection: "desc",
      minimumPlatinum: 10,
    });

    expect(sorted.map((row) => row.name)).toEqual(["Item A", "Item C"]);
  });

  it("derives ducatonator from ducats/platinum", () => {
    const items = [
      { name: "High Ratio", ducats: 100, platinum: 10 },
      { name: "Low Ratio", ducats: 45, platinum: 15 },
      { name: "No Price", ducats: 100, platinum: null },
    ];

    const sorted = applySharedFiltersAndSort(items, {
      ...defaultFilters(),
      sortBy: "ducatonator",
      sortDirection: "desc",
    });

    expect(sorted.map((row) => row.name)).toEqual(["High Ratio", "Low Ratio", "No Price"]);
  });

  it("applies part type and leveled-up toggles", () => {
    const items = [
      { name: "Prime Item", partType: "prime" as const, leveledUp: true },
      { name: "Normal Item", partType: "normal" as const, leveledUp: false },
    ];

    const filtered = applySharedFiltersAndSort(items, {
      ...defaultFilters(),
      partType: "normal",
      leveledUp: "no",
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("Normal Item");
  });

  it("filters vaulted items", () => {
    const items = [
      { name: "Vaulted Relic", vaulted: true },
      { name: "Available Relic", vaulted: false },
    ];

    const filtered = applySharedFiltersAndSort(items, {
      ...defaultFilters(),
      vaulted: "yes",
    });

    expect(filtered.map((row) => row.name)).toEqual(["Vaulted Relic"]);
  });
});
