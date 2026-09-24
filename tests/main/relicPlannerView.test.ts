import { describe, expect, it } from "vitest";

import {
  DEFAULT_RELIC_PLANNER_FILTERS,
  RELIC_OWNED_ABOVE_STEPS,
  compareRelicTierThenName,
  normalizeRelicOverlayFilterPush,
  normalizeRelicPlannerFilters,
  relicDucatonator,
  relicOwnedCountForMode,
  relicQualityForMode,
  selectRelicPlannerRows,
  sortRelicPlannerRows,
  type RelicPlannerFilters,
  type RelicPlannerRow,
  type RelicVaultedMode,
} from "../../config/shared/relicPlannerView";

function row(overrides: Partial<RelicPlannerRow> & { name: string }): RelicPlannerRow {
  return {
    tier: "Lith",
    vaulted: false,
    ownedCount: 0,
    ownedTotal: 0,
    plat: null,
    ducat: null,
    ratio: null,
    ...overrides,
  };
}

const ALL_PASS = {
  matchesSearch: () => true,
  hasNeededReward: () => true,
};

function filters(overrides: Partial<RelicPlannerFilters> = {}): RelicPlannerFilters {
  return { ...DEFAULT_RELIC_PLANNER_FILTERS, ...overrides };
}

function names(rows: readonly RelicPlannerRow[]): string[] {
  return rows.map((entry) => entry.name);
}

describe("relic planner ordering", () => {
  const rows = [
    row({ name: "Axi A1", tier: "Axi", plat: 10, ducat: 300, ratio: 30, ownedCount: 1 }),
    row({ name: "Lith B2", tier: "Lith", plat: 40, ducat: 200, ratio: 5, ownedCount: 7 }),
    row({ name: "Lith A2", tier: "Lith", plat: 25, ducat: 250, ratio: 10, ownedCount: 3 }),
    row({ name: "Neo C3", tier: "Neo", plat: null, ducat: null, ratio: null, ownedCount: 2 }),
  ];

  it("orders by tier then name, and reverses on desc", () => {
    expect(names(sortRelicPlannerRows(rows, "tier", "asc"))).toEqual([
      "Lith A2",
      "Lith B2",
      "Neo C3",
      "Axi A1",
    ]);
    expect(names(sortRelicPlannerRows(rows, "tier", "desc"))).toEqual([
      "Axi A1",
      "Neo C3",
      "Lith B2",
      "Lith A2",
    ]);
  });

  it("orders by name in both directions", () => {
    expect(names(sortRelicPlannerRows(rows, "name", "asc"))).toEqual([
      "Axi A1",
      "Lith A2",
      "Lith B2",
      "Neo C3",
    ]);
    expect(names(sortRelicPlannerRows(rows, "name", "desc"))).toEqual([
      "Neo C3",
      "Lith B2",
      "Lith A2",
      "Axi A1",
    ]);
  });

  it("orders by platinum, ducats and the ducatonator", () => {
    expect(names(sortRelicPlannerRows(rows, "ev", "desc"))).toEqual([
      "Lith B2",
      "Lith A2",
      "Axi A1",
      "Neo C3",
    ]);
    expect(names(sortRelicPlannerRows(rows, "ducat", "desc"))).toEqual([
      "Axi A1",
      "Lith A2",
      "Lith B2",
      "Neo C3",
    ]);
    expect(names(sortRelicPlannerRows(rows, "ducatonator", "desc"))).toEqual([
      "Axi A1",
      "Lith A2",
      "Lith B2",
      "Neo C3",
    ]);
  });

  it("orders by owned copies", () => {
    expect(names(sortRelicPlannerRows(rows, "owned", "desc"))).toEqual([
      "Lith B2",
      "Lith A2",
      "Neo C3",
      "Axi A1",
    ]);
    expect(names(sortRelicPlannerRows(rows, "owned", "asc"))).toEqual([
      "Axi A1",
      "Neo C3",
      "Lith A2",
      "Lith B2",
    ]);
  });

  it("keeps a metric-less row last in either direction", () => {
    expect(names(sortRelicPlannerRows(rows, "ev", "asc")).at(-1)).toBe("Neo C3");
    expect(names(sortRelicPlannerRows(rows, "ev", "desc")).at(-1)).toBe("Neo C3");
  });

  it("breaks an equal metric by tier then name", () => {
    const tied = [
      row({ name: "Neo B", tier: "Neo", plat: 5 }),
      row({ name: "Lith B", tier: "Lith", plat: 5 }),
      row({ name: "Lith A", tier: "Lith", plat: 5 }),
    ];
    expect(names(sortRelicPlannerRows(tied, "ev", "desc"))).toEqual(["Lith A", "Lith B", "Neo B"]);
  });

  it("ranks an unknown tier past every known one", () => {
    expect(
      compareRelicTierThenName({ name: "A", tier: "Omnia" }, { name: "B", tier: "Requiem" }),
    ).toBeGreaterThan(0);
  });

  it("does not mutate the input array", () => {
    const input = [...rows];
    sortRelicPlannerRows(input, "ev", "desc");
    expect(names(input)).toEqual(names(rows));
  });
});

describe("relic planner filters", () => {
  it("keeps vaulted, unvaulted or both", () => {
    const rows = [
      row({ name: "A vaulted", vaulted: true }),
      row({ name: "B open", vaulted: false }),
    ];
    const kept = (vaultedMode: RelicVaultedMode) =>
      names(selectRelicPlannerRows(rows, filters({ vaultedMode }), ALL_PASS));

    expect(kept("all")).toEqual(["A vaulted", "B open"]);
    expect(kept("vaulted")).toEqual(["A vaulted"]);
    expect(kept("unvaulted")).toEqual(["B open"]);
  });

  it("asks the search hook only while there is search text", () => {
    const rows = [row({ name: "A" }), row({ name: "B" })];
    const seen: string[] = [];
    const hooks = {
      matchesSearch: (entry: RelicPlannerRow) => {
        seen.push(entry.name);
        return entry.name === "A";
      },
      hasNeededReward: () => true,
    };

    expect(names(selectRelicPlannerRows(rows, filters(), hooks))).toEqual(["A", "B"]);
    expect(seen).toEqual([]);

    expect(names(selectRelicPlannerRows(rows, filters({ search: "a" }), hooks))).toEqual(["A"]);
    expect(seen).toEqual(["A", "B"]);
  });

  it("asks the needed-reward hook only while that filter is on", () => {
    const rows = [row({ name: "A" }), row({ name: "B" })];
    const hooks = {
      matchesSearch: () => true,
      hasNeededReward: (entry: RelicPlannerRow) => entry.name === "B",
    };

    expect(names(selectRelicPlannerRows(rows, filters(), hooks))).toEqual(["A", "B"]);
    expect(
      names(selectRelicPlannerRows(rows, filters({ containsNeededReward: true }), hooks)),
    ).toEqual(["B"]);
  });

  it("hides relics at or below the copies threshold", () => {
    const rows = [
      row({ name: "A two", ownedTotal: 2 }),
      row({ name: "B three", ownedTotal: 3 }),
      row({ name: "C ten", ownedTotal: 10 }),
    ];

    expect(names(selectRelicPlannerRows(rows, filters(), ALL_PASS))).toEqual([
      "A two",
      "B three",
      "C ten",
    ]);
    expect(names(selectRelicPlannerRows(rows, filters({ ownedAbove: 2 }), ALL_PASS))).toEqual([
      "B three",
      "C ten",
    ]);
    expect(names(selectRelicPlannerRows(rows, filters({ ownedAbove: 10 }), ALL_PASS))).toEqual([]);
  });

  it("counts copies across grades instead of the quality mode's own count", () => {
    const rows = [row({ name: "Mixed", ownedCount: 1, ownedTotal: 6 })];
    expect(
      names(
        selectRelicPlannerRows(rows, filters({ ownedAbove: 4, qualityMode: "radiant" }), ALL_PASS),
      ),
    ).toEqual(["Mixed"]);
  });

  it("filters before it sorts", () => {
    const rows = [
      row({ name: "Cheap", plat: 1, vaulted: true }),
      row({ name: "Rich", plat: 99, vaulted: false }),
      row({ name: "Mid", plat: 50, vaulted: true }),
    ];
    expect(
      names(
        selectRelicPlannerRows(
          rows,
          filters({ vaultedMode: "vaulted", sortMode: "ev", sortDirection: "desc" }),
          ALL_PASS,
        ),
      ),
    ).toEqual(["Mid", "Cheap"]);
  });
});

describe("relic quality modes", () => {
  const owned = { intact: 3, exceptional: 0, flawless: 2, radiant: 0 };

  it("sums every grade in owned mode and reads one grade otherwise", () => {
    expect(relicOwnedCountForMode(owned, "owned")).toBe(5);
    expect(relicOwnedCountForMode(owned, "intact")).toBe(3);
    expect(relicOwnedCountForMode(owned, "radiant")).toBe(0);
    expect(relicOwnedCountForMode(null, "owned")).toBe(0);
  });

  it("picks the highest owned grade for owned mode", () => {
    expect(relicQualityForMode("owned", owned)).toBe("flawless");
    expect(relicQualityForMode("owned", { intact: 0 })).toBe(null);
  });

  it("prefers a pinned grade the player actually owns", () => {
    expect(relicQualityForMode("owned", owned, "intact")).toBe("intact");
    expect(relicQualityForMode("owned", owned, "radiant")).toBe("flawless");
  });

  it("returns the named grade even when none is owned", () => {
    expect(relicQualityForMode("radiant", owned)).toBe("radiant");
  });

  it("guards the ducatonator against a missing or zero platinum value", () => {
    expect(relicDucatonator(10, 300)).toBe(30);
    expect(relicDucatonator(0, 300)).toBe(null);
    expect(relicDucatonator(null, 300)).toBe(null);
    expect(relicDucatonator(10, null)).toBe(null);
  });
});

describe("pushed filter validation", () => {
  it("falls back per field instead of dropping the whole payload", () => {
    const fallback = filters({ squadSize: 4, sortMode: "ev", sortDirection: "desc" });
    expect(
      normalizeRelicPlannerFilters(
        { squadSize: 9, sortMode: "chaos", qualityMode: "radiant" },
        fallback,
      ),
    ).toEqual({ ...fallback, qualityMode: "radiant" });
  });

  it("rejects a non-integer or out-of-range squad size", () => {
    for (const squadSize of [0, 5, 2.5, "3", NaN, null]) {
      expect(normalizeRelicPlannerFilters({ squadSize }).squadSize).toBe(
        DEFAULT_RELIC_PLANNER_FILTERS.squadSize,
      );
    }
    expect(normalizeRelicPlannerFilters({ squadSize: 3 }).squadSize).toBe(3);
  });

  it("accepts only the copy thresholds the planner offers", () => {
    expect(RELIC_OWNED_ABOVE_STEPS).toEqual([2, 4, 6, 8, 10]);
    for (const ownedAbove of [0, ...RELIC_OWNED_ABOVE_STEPS]) {
      expect(normalizeRelicPlannerFilters({ ownedAbove }).ownedAbove).toBe(ownedAbove);
    }
    for (const ownedAbove of [1, 3, 12, -2, 2.5, "4", null, NaN, Infinity]) {
      expect(
        normalizeRelicPlannerFilters({ ownedAbove }, filters({ ownedAbove: 6 })).ownedAbove,
      ).toBe(6);
    }
  });

  it("caps the search text and ignores a non-string one", () => {
    expect(normalizeRelicPlannerFilters({ search: "x".repeat(500) }).search).toHaveLength(200);
    expect(normalizeRelicPlannerFilters({ search: 42 }).search).toBe("");
  });

  it("keeps every mode inside its own vocabulary", () => {
    const hostile = normalizeRelicPlannerFilters({
      vaultedMode: "__proto__",
      qualityMode: "owned",
      sortMode: "owned",
      sortDirection: "sideways",
      containsNeededReward: "yes",
    });
    expect(hostile).toEqual({
      ...DEFAULT_RELIC_PLANNER_FILTERS,
      qualityMode: "owned",
      sortMode: "owned",
    });
  });

  it("returns the fallback for a payload that is not an object", () => {
    expect(normalizeRelicPlannerFilters(null)).toEqual(DEFAULT_RELIC_PLANNER_FILTERS);
    expect(normalizeRelicPlannerFilters([1, 2])).toEqual(DEFAULT_RELIC_PLANNER_FILTERS);
  });

  it("keeps only known group keys and known grades in the pinned-quality map", () => {
    const hostile = JSON.parse(
      `{"Neo Z9":"radiant","  Lith A1  ":"intact","Axi B2":"pristine","Meso C3":3,"":"intact","${"x".repeat(200)}":"intact","__proto__":"intact"}`,
    ) as Record<string, unknown>;
    expect(Object.hasOwn(hostile, "__proto__")).toBe(true);
    const push = normalizeRelicOverlayFilterPush({ pinnedQualities: hostile });
    expect(push.pinnedQualities).toEqual({ "Neo Z9": "radiant", "Lith A1": "intact" });
    expect(Object.getPrototypeOf(push.pinnedQualities ?? {})).toBe(Object.prototype);
  });

  it("drops a pinned-quality payload that is not a record", () => {
    expect(normalizeRelicOverlayFilterPush({}).pinnedQualities).toBe(null);
    expect(normalizeRelicOverlayFilterPush({ pinnedQualities: ["Neo Z9"] }).pinnedQualities).toBe(
      null,
    );
    expect(normalizeRelicOverlayFilterPush({ pinnedQualities: "radiant" }).pinnedQualities).toBe(
      null,
    );
  });

  it("normalizes the tier hint and the needed-reward keys", () => {
    const push = normalizeRelicOverlayFilterPush({
      tierFilter: "Neo",
      neededRewardKeys: ["Neo Z9", "  Lith A1  ", "", 7, "x".repeat(200)],
    });
    expect(push.tierFilter).toBe("Neo");
    expect(push.neededRewardKeys).toEqual(["Neo Z9", "Lith A1"]);

    expect(normalizeRelicOverlayFilterPush({ tierFilter: 3 }).tierFilter).toBe(null);
    expect(normalizeRelicOverlayFilterPush({}).neededRewardKeys).toBe(null);
  });
});
