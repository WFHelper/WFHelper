import { describe, expect, it } from "vitest";

import {
  FILTER_CONTROL_FIELDS,
  FILTER_CONTROL_IDS,
  FILTER_CONTROL_LABEL_KEYS,
  FILTER_CONTROL_SUPPORT,
  FILTER_SCOPES,
  applySharedFiltersAndSort,
  defaultSortDirection,
  isBasicFilterControl,
  matchesSearch,
  matchesSharedFilters,
} from "../../../src/lib/filters.js";
import type { SharedFiltersState } from "../../../src/types/filters.js";

function defaultFilters(): SharedFiltersState {
  return {
    search: "",
    primeMode: "all",
    masteredMode: "all",
    sortBy: "name",
    sortDirection: "asc",
    orderPlaced: "all",
    mastered: "all",
    spares: "all",
    vaulted: "all",
    partType: "all",
    favorite: "all",
    minimumPlatinum: 0,
    minimumAmount: 0,
    equipped: "all",
    leveledUp: "all",
    subsumed: "all",
    foundryState: "all",
  };
}

describe("matchesSearch", () => {
  // Resource rows carry only name/displayName/internalName, and the Everything
  // tab runs them through the same search box as full inventory rows.
  const resource = {
    name: "Orokin Cell",
    displayName: "Orokinzelle",
    imageUrl: null,
    internalName: "/Lotus/Types/Items/MiscItems/OrokinCell",
    count: 42,
  };

  it("applies every field of the rule to sparse resource rows", () => {
    expect(matchesSearch(resource, "orokin cell")).toBe(true);
    expect(matchesSearch(resource, "orokinzelle")).toBe(true);
    expect(matchesSearch(resource, "MiscItems")).toBe(true);
    expect(matchesSearch(resource, "")).toBe(true);
    expect(matchesSearch(resource, "  ")).toBe(true);
    expect(matchesSearch(resource, "argon")).toBe(false);
  });

  it("covers category, label and keywords on rows that carry them", () => {
    const item = {
      name: "Lith A1 Relic",
      category: "relics",
      categoryLabel: "Relic",
      internalName: "/Lotus/Types/Game/Projections/T1VoidProjectionAssaultRifleAExceptional",
      keywords: ["braton prime blueprint"],
    };

    expect(matchesSearch(item, "RELIC")).toBe(true);
    expect(matchesSearch(item, "relics")).toBe(true);
    expect(matchesSearch(item, "braton prime")).toBe(true);
    expect(matchesSearch(item, "soma")).toBe(false);
  });

  it("stays consistent with the shared filter entry point", () => {
    for (const query of ["orokin", "orokinzelle", "MiscItems", "argon"]) {
      expect(matchesSharedFilters(resource, { ...defaultFilters(), search: query })).toBe(
        matchesSearch(resource, query),
      );
    }
  });
});

describe("shared filters", () => {
  it("searches the localized name and the English one alike", () => {
    const item = {
      name: "Serration",
      displayName: "Einkerbung",
      internalName: "/Lotus/Upgrades/Mods/Rifle/WeaponDamageAmountMod",
      category: "mods",
    };
    const filters = defaultFilters();

    expect(matchesSharedFilters(item, { ...filters, search: "einkerb" })).toBe(true);
    expect(matchesSharedFilters(item, { ...filters, search: "serrat" })).toBe(true);
    expect(matchesSharedFilters(item, { ...filters, search: "vitality" })).toBe(false);
  });

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

  it("drops items without a subsumed flag when the subsumed filter is active", () => {
    const base = { name: "Nyx", subsumed: false };
    const done = { name: "Rhino", subsumed: true };
    const prime = { name: "Nyx Prime", subsumed: undefined };

    const yes: SharedFiltersState = { ...defaultFilters(), subsumed: "yes" };
    const no: SharedFiltersState = { ...defaultFilters(), subsumed: "no" };

    expect(matchesSharedFilters(done, yes)).toBe(true);
    expect(matchesSharedFilters(base, yes)).toBe(false);
    expect(matchesSharedFilters(prime, yes)).toBe(false);
    expect(matchesSharedFilters(base, no)).toBe(true);
    expect(matchesSharedFilters(done, no)).toBe(false);
    expect(matchesSharedFilters(prime, no)).toBe(false);
    expect(matchesSharedFilters(prime, defaultFilters())).toBe(true);
  });

  it("prefers combinedAmount over amount for the minimum amount filter", () => {
    const filters: SharedFiltersState = { ...defaultFilters(), minimumAmount: 2 };

    expect(matchesSharedFilters({ name: "Bite", amount: 1, combinedAmount: 2 }, filters)).toBe(
      true,
    );
    expect(matchesSharedFilters({ name: "Bite", amount: 1 }, filters)).toBe(false);
    expect(matchesSharedFilters({ name: "Serration", amount: 3 }, filters)).toBe(true);
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

  it("accepts custom minimum platinum values", () => {
    const filters: SharedFiltersState = {
      ...defaultFilters(),
      minimumPlatinum: 7,
    };
    const items = [
      { name: "Six", platinum: 6 },
      { name: "Seven", platinum: 7 },
    ];

    expect(applySharedFiltersAndSort(items, filters).map((item) => item.name)).toEqual(["Seven"]);
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

describe("mastery filters", () => {
  it("ranks the biggest mastery gain first", () => {
    const items = [
      { name: "Dual Ether", masteryXpRemaining: 3000 },
      { name: "Voidrig", masteryXpRemaining: 6200 },
      { name: "Maxed Skana", masteryXpRemaining: 0 },
    ];

    const sorted = applySharedFiltersAndSort(items, {
      ...defaultFilters(),
      sortBy: "mastery_xp",
      sortDirection: "desc",
    });

    expect(sorted.map((row) => row.name)).toEqual(["Voidrig", "Dual Ether", "Maxed Skana"]);
  });

  it("sorts items with no mastery figure last either way", () => {
    const items = [{ name: "Unknown" }, { name: "Known", masteryXpRemaining: 100 }];

    for (const sortDirection of ["asc", "desc"] as const) {
      const sorted = applySharedFiltersAndSort(items, {
        ...defaultFilters(),
        sortBy: "mastery_xp",
        sortDirection,
      });
      expect(sorted[sorted.length - 1].name).toBe("Unknown");
    }
  });

  const foundryItems = [
    { name: "Claimable Build", foundryState: "claimable" as const },
    { name: "Still Cooking", foundryState: "building" as const },
    { name: "All Parts Owned", foundryState: "buildable" as const },
    { name: "Missing A Part", foundryState: "missing" as const },
    { name: "Owned And Mastered" },
  ];

  it("keeps only builds waiting to be claimed", () => {
    const filtered = applySharedFiltersAndSort(foundryItems, {
      ...defaultFilters(),
      foundryState: "claimable",
    });

    expect(filtered.map((row) => row.name)).toEqual(["Claimable Build"]);
  });

  it("full-set mode keeps buildable parents and drops their part blueprints", () => {
    const withParts = [
      ...foundryItems,
      { name: "Rhino Prime Systems", foundryState: "buildable" as const, looseComponent: true },
      { name: "Missing Part Component", foundryState: "missing" as const, looseComponent: true },
    ];
    const filtered = applySharedFiltersAndSort(withParts, {
      ...defaultFilters(),
      foundryState: "buildable_sets",
    });

    expect(filtered.map((row) => row.name)).toEqual(["All Parts Owned"]);
  });

  it("plain buildable still lists the part blueprints alongside the parent", () => {
    const withParts = [
      ...foundryItems,
      { name: "Rhino Prime Systems", foundryState: "buildable" as const, looseComponent: true },
    ];
    const filtered = applySharedFiltersAndSort(withParts, {
      ...defaultFilters(),
      foundryState: "buildable",
    });

    expect(filtered.map((row) => row.name)).toEqual(["All Parts Owned", "Rhino Prime Systems"]);
  });

  it("not-ready drops claimable and ready-to-build rows and nothing else", () => {
    const filtered = applySharedFiltersAndSort(foundryItems, {
      ...defaultFilters(),
      foundryState: "not_ready",
    });

    expect(filtered.map((row) => row.name)).toEqual([
      "Missing A Part",
      "Owned And Mastered",
      "Still Cooking",
    ]);
  });

  it("sorts by owned part count, most complete first", () => {
    const items = [
      { name: "One Part", partsOwned: 1 },
      { name: "Three Parts", partsOwned: 3 },
      { name: "No Parts Tracked" },
    ];

    const filtered = applySharedFiltersAndSort(items, {
      ...defaultFilters(),
      sortBy: "parts_owned",
      sortDirection: "desc",
    });

    expect(filtered.map((row) => row.name)).toEqual([
      "Three Parts",
      "One Part",
      "No Parts Tracked",
    ]);
  });

  it("keeps only items whose parts are all sitting in the inventory", () => {
    const filtered = applySharedFiltersAndSort(foundryItems, {
      ...defaultFilters(),
      foundryState: "buildable",
    });

    expect(filtered.map((row) => row.name)).toEqual(["All Parts Owned"]);
  });
});

describe("filter control registry", () => {
  it("maps every control to fields the filter state actually has", () => {
    const state = defaultFilters();
    for (const id of FILTER_CONTROL_IDS) {
      const fields = FILTER_CONTROL_FIELDS[id];
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) expect(state).toHaveProperty(field);
    }
  });

  it("splits the bar into the basic row and the inventory-only advanced row", () => {
    expect(FILTER_CONTROL_IDS.filter(isBasicFilterControl)).toEqual([
      "search",
      "prime",
      "mastery",
      "foundryState",
      "vaulted",
      "subsumed",
      "sort",
    ]);
    expect(isBasicFilterControl("spares")).toBe(false);
    expect(isBasicFilterControl("vaultedChips")).toBe(false);
  });

  it("supports only controls it knows how to reset, in every scope", () => {
    for (const scope of FILTER_SCOPES) {
      for (const id of FILTER_CONTROL_SUPPORT[scope]) {
        expect(FILTER_CONTROL_IDS).toContain(id);
        expect(FILTER_CONTROL_LABEL_KEYS[id]).toBeTruthy();
      }
    }
  });
});

describe("defaultSortDirection", () => {
  it("keeps name-like sorts ascending and value sorts descending in every view", () => {
    expect(defaultSortDirection("name")).toBe("asc");
    expect(defaultSortDirection("tier")).toBe("asc");
    expect(defaultSortDirection("time")).toBe("asc");
    expect(defaultSortDirection("missing_parts")).toBe("asc");
    for (const key of ["platinum", "ducats", "amount", "count", "mastery_xp", "ev", "ducat"]) {
      expect(defaultSortDirection(key)).toBe("desc");
    }
  });
});
