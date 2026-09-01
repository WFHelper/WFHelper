import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bestSeller,
  categoryNames,
  categoryRollup,
  computeFlow,
  distinctItemCategories,
  fifoCostBasis,
  filterEvents,
  formatPct,
  formatPlat,
  itemKey,
  loadCategoryOverrides,
  makeItemCategoryResolver,
  resolveRangePreset,
  saveCategoryOverrides,
  toDayKey,
  topItems,
  UNCATEGORIZED,
  withCategoryOverrides,
  worthToday,
  yearComparison,
} from "../../../src/lib/stats/tradeAnalytics.js";
import type { TradeEvent, TradeItem, TradeType } from "../../../src/types/ipc.js";

let seq = 0;

function item(
  name: string,
  direction: "given" | "received",
  count = 1,
  internalName?: string,
): TradeItem {
  return {
    internalName: internalName ?? `/Lotus/${name.replace(/\s+/g, "")}`,
    displayName: name,
    count,
    direction,
  };
}

function ev(date: string, type: TradeType, plat: number, items: TradeItem[]): TradeEvent {
  return { id: `e${++seq}`, date, type, platChange: plat, items };
}

/** Local-noon ISO so a timezone shift cannot roll the day key over. */
function at(day: string): string {
  return `${day}T12:00:00.000Z`.replace("Z", "");
}

describe("toDayKey / filterEvents", () => {
  it("derives the local day and filters inclusively", () => {
    expect(toDayKey(at("2026-03-04"))).toBe("2026-03-04");
    const events = [
      ev(at("2026-01-01"), "sale", 10, [item("A", "given")]),
      ev(at("2026-02-15"), "sale", 20, [item("B", "given")]),
      ev(at("2026-03-31"), "sale", 30, [item("C", "given")]),
    ];
    const inside = filterEvents(events, { from: "2026-01-01", to: "2026-02-15" });
    expect(inside.map((e) => e.platChange)).toEqual([10, 20]);
    expect(filterEvents(events, {})).toHaveLength(3);
  });

  it("drops rows with an unparseable date only when a bound is set", () => {
    const bad = ev("not-a-date", "sale", 5, [item("A", "given")]);
    expect(filterEvents([bad], {})).toHaveLength(1);
    expect(filterEvents([bad], { from: "2026-01-01" })).toHaveLength(0);
  });
});

describe("resolveRangePreset", () => {
  const now = new Date(2026, 4, 10, 12, 0, 0); // 2026-05-10 local

  it("builds bounded windows", () => {
    expect(resolveRangePreset("all", now)).toEqual({});
    expect(resolveRangePreset("30d", now)).toEqual({ from: "2026-04-11", to: "2026-05-10" });
    expect(resolveRangePreset("ytd", now)).toEqual({ from: "2026-01-01", to: "2026-05-10" });
    expect(resolveRangePreset("lastYear", now)).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
  });

  it("keeps the caller's bounds for custom", () => {
    const current = { from: "2024-02-02", to: "2024-03-03" };
    expect(resolveRangePreset("custom", now, current)).toEqual(current);
  });
});

describe("computeFlow", () => {
  it("splits plat in and out and counts active days", () => {
    const flow = computeFlow([
      ev(at("2026-01-01"), "sale", 100, [item("A", "given")]),
      ev(at("2026-01-01"), "sale", 50, [item("B", "given")]),
      ev(at("2026-01-02"), "purchase", 30, [item("C", "received")]),
      ev(at("2026-01-03"), "trade", 0, [item("D", "given"), item("E", "received")]),
    ]);
    expect(flow).toMatchObject({
      platIn: 150,
      platOut: 30,
      net: 120,
      volume: 180,
      sales: 2,
      purchases: 1,
      swaps: 1,
      events: 4,
      activeDays: 3,
    });
  });

  it("is all zeros on an empty ledger", () => {
    expect(computeFlow([])).toMatchObject({ platIn: 0, platOut: 0, net: 0, volume: 0, events: 0 });
  });

  it("treats a negative platChange as its magnitude", () => {
    expect(computeFlow([ev(at("2026-01-01"), "sale", -40, [item("A", "given")])]).platIn).toBe(40);
  });
});

describe("topItems / bestSeller", () => {
  it("allocates a multi-item event's platinum across its units", () => {
    const events = [
      ev(at("2026-01-01"), "sale", 100, [item("A", "given", 1), item("B", "given", 3)]),
    ];
    const sold = topItems(events, "sold");
    expect(sold.find((r) => r.name === "A")).toMatchObject({ units: 1, platinum: 25 });
    expect(sold.find((r) => r.name === "B")).toMatchObject({ units: 3, platinum: 75 });
  });

  it("keeps sales and purchases on their own side", () => {
    const events = [
      ev(at("2026-01-01"), "sale", 90, [item("Sold", "given")]),
      ev(at("2026-01-02"), "purchase", 40, [item("Bought", "received")]),
    ];
    expect(topItems(events, "sold").map((r) => r.name)).toEqual(["Sold"]);
    expect(topItems(events, "bought").map((r) => r.name)).toEqual(["Bought"]);
  });

  it("reports null average when nothing was priced", () => {
    const rows = topItems([ev(at("2026-01-01"), "sale", 0, [item("Freebie", "given")])], "sold");
    expect(rows[0].avgUnitPlat).toBeNull();
  });

  it("returns null best seller for an empty range", () => {
    expect(bestSeller([])).toBeNull();
  });
});

describe("categoryRollup", () => {
  const resolve = (i: TradeItem): string => (i.displayName.startsWith("Prime") ? "Warframe" : "");

  it("buckets by resolver and folds unknowns into one row", () => {
    const events = [
      ev(at("2026-01-01"), "sale", 200, [item("Prime Set", "given")]),
      ev(at("2026-01-02"), "purchase", 60, [item("Mystery Mod", "received")]),
    ];
    const rows = categoryRollup(events, resolve);
    expect(rows.find((r) => r.category === "Warframe")).toMatchObject({
      platIn: 200,
      platOut: 0,
      net: 200,
      soldUnits: 1,
    });
    expect(rows.find((r) => r.category === UNCATEGORIZED)).toMatchObject({
      platOut: 60,
      net: -60,
      boughtUnits: 1,
    });
  });

  it("lets a user override beat the item database", () => {
    const overridden = withCategoryOverrides(resolve, {
      [itemKey(item("Mystery Mod", "received"))]: "Mods",
    });
    const rows = categoryRollup(
      [ev(at("2026-01-02"), "purchase", 60, [item("Mystery Mod", "received")])],
      overridden,
    );
    expect(rows.map((r) => r.category)).toEqual(["Mods"]);
  });
});

describe("makeItemCategoryResolver", () => {
  const db = {
    "/Lotus/Powersuits/Ash/AshPrime": { name: "Ash Prime", category: "Warframes" },
    "/Lotus/Weapons/Tenno/Nikana": { name: "Nikana Prime", category: "Melee" },
  };
  const wfm = {
    "ash prime": { url_name: "ash_prime", gameRef: "/lotus/powersuits/ash/ashprime" },
    "nikana prime": { url_name: "nikana_prime", gameRef: "/Lotus/Weapons/Tenno/Nikana" },
    orphan: { url_name: "orphan", gameRef: null },
  };

  /** A row as the EE.log tracker writes it: no uniqueName, slug from the catalog. */
  function live(displayName: string, slug?: string): TradeItem {
    return {
      internalName: "",
      displayName,
      count: 1,
      direction: "given",
      ...(slug ? { wfmSlug: slug } : {}),
    };
  }

  it("resolves a live row through its market slug", () => {
    const resolve = makeItemCategoryResolver(db, wfm);
    expect(resolve(live("Ash Prime", "ash_prime"))).toBe("Warframes");
  });

  it("falls back to the display name when the row carries no slug", () => {
    const resolve = makeItemCategoryResolver(db, wfm);
    expect(resolve(live("Nikana Prime"))).toBe("Melee");
  });

  it("folds a gameRef whose casing differs from the item database key", () => {
    const resolve = makeItemCategoryResolver(db, wfm);
    // The catalog spells Ash Prime's gameRef all-lowercase.
    expect(resolve(live("Ash Prime", "ash_prime"))).toBe("Warframes");
    expect(resolve({ ...live("Ash Prime"), internalName: "/lotus/powersuits/ash/ashprime" })).toBe(
      "Warframes",
    );
  });

  it("prefers a uniqueName the row already carries", () => {
    const resolve = makeItemCategoryResolver(db, wfm);
    expect(
      resolve({ ...live("Anything", "ash_prime"), internalName: "/Lotus/Weapons/Tenno/Nikana" }),
    ).toBe("Melee");
  });

  it("reports uncategorized instead of guessing", () => {
    const resolve = makeItemCategoryResolver(db, wfm);
    expect(resolve(live("Unknown Thing", "orphan"))).toBe(UNCATEGORIZED);
    expect(resolve(live("Unknown Thing"))).toBe(UNCATEGORIZED);
    expect(makeItemCategoryResolver({}, {})(live("Ash Prime", "ash_prime"))).toBe(UNCATEGORIZED);
  });
});

describe("itemKey", () => {
  it("joins an old row with no uniqueName to a newer one by the market slug", () => {
    const legacy: TradeItem = {
      internalName: "",
      displayName: "Ash Prime Chassis",
      count: 1,
      direction: "given",
      wfmSlug: "ash_prime_chassis",
    };
    const current: TradeItem = {
      ...legacy,
      internalName: "/Lotus/Types/Recipes/AshPrimeChassis",
    };
    expect(itemKey(legacy)).toBe(itemKey(current));
  });
});

describe("yearComparison", () => {
  const now = new Date(2026, 5, 1);

  it("compares this year against last year", () => {
    const cmp = yearComparison(
      [
        ev(at("2026-02-01"), "sale", 150, [item("A", "given")]),
        ev(at("2025-02-01"), "sale", 100, [item("A", "given")]),
      ],
      now,
    );
    expect(cmp.currentYear).toBe(2026);
    expect(cmp.current.platIn).toBe(150);
    expect(cmp.previous.platIn).toBe(100);
    expect(cmp.netDeltaPct).toBeCloseTo(50);
    expect(cmp.hasPrevious).toBe(true);
  });

  it("never divides by a zero prior year", () => {
    const cmp = yearComparison([ev(at("2026-02-01"), "sale", 150, [item("A", "given")])], now);
    expect(cmp.netDeltaPct).toBeNull();
    expect(cmp.volumeDeltaPct).toBeNull();
    expect(cmp.hasPrevious).toBe(false);
  });

  it("uses an absolute denominator so a negative prior year stays finite", () => {
    const cmp = yearComparison(
      [
        ev(at("2025-02-01"), "purchase", 100, [item("A", "received")]),
        ev(at("2026-02-01"), "sale", 50, [item("A", "given")]),
      ],
      now,
    );
    expect(cmp.previous.net).toBe(-100);
    expect(cmp.netDeltaPct).toBeCloseTo(150);
  });
});

describe("fifoCostBasis", () => {
  it("matches sales to the oldest purchase lot first", () => {
    const basis = fifoCostBasis([
      ev(at("2026-01-01"), "purchase", 10, [item("Widget", "received")]),
      ev(at("2026-01-02"), "purchase", 30, [item("Widget", "received")]),
      ev(at("2026-01-03"), "sale", 50, [item("Widget", "given")]),
    ]);
    expect(basis.matchedUnits).toBe(1);
    expect(basis.matchedCost).toBe(10);
    expect(basis.estimatedMargin).toBe(40);
    expect(basis.heldUnits).toBe(1);
    expect(basis.heldCost).toBe(30);
  });

  it("labels itself estimated", () => {
    expect(fifoCostBasis([]).estimated).toBe(true);
  });

  it("reports a farmed sale as unpriced, not as zero-cost profit", () => {
    const basis = fifoCostBasis([ev(at("2026-01-01"), "sale", 80, [item("Farmed", "given")])]);
    expect(basis.unpricedUnits).toBe(1);
    expect(basis.matchedUnits).toBe(0);
    expect(basis.matchedRevenue).toBe(0);
    expect(basis.estimatedMargin).toBe(0);
    expect(basis.estimatedMarginPct).toBeNull();
    expect(basis.unpricedRevenue).toBe(80);
  });

  it("splits a partly covered sale into matched and unpriced units", () => {
    const basis = fifoCostBasis([
      ev(at("2026-01-01"), "purchase", 20, [item("Widget", "received", 1)]),
      ev(at("2026-01-02"), "sale", 90, [item("Widget", "given", 3)]),
    ]);
    expect(basis.matchedUnits).toBe(1);
    expect(basis.unpricedUnits).toBe(2);
    expect(basis.matchedRevenue).toBe(30);
    expect(basis.unpricedRevenue).toBe(60);
    expect(basis.estimatedMargin).toBe(10);
  });

  it("consumes a lot on a swap without booking revenue", () => {
    const basis = fifoCostBasis([
      ev(at("2026-01-01"), "purchase", 20, [item("Widget", "received")]),
      ev(at("2026-01-02"), "trade", 0, [item("Widget", "given"), item("Other", "received")]),
      ev(at("2026-01-03"), "sale", 90, [item("Widget", "given")]),
    ]);
    expect(basis.swappedUnits).toBe(1);
    expect(basis.heldUnits).toBe(0);
    expect(basis.unpricedUnits).toBe(1);
    expect(basis.matchedUnits).toBe(0);
  });

  it("orders by date regardless of the input order", () => {
    const late = ev(at("2026-01-03"), "sale", 50, [item("Widget", "given")]);
    const early = ev(at("2026-01-01"), "purchase", 10, [item("Widget", "received")]);
    expect(fifoCostBasis([late, early]).matchedUnits).toBe(1);
  });

  it("keeps a same-timestamp purchase ahead of the sale it pays for", () => {
    const stamp = at("2026-01-01");
    const basis = fifoCostBasis([
      ev(stamp, "purchase", 10, [item("Widget", "received")]),
      ev(stamp, "sale", 40, [item("Widget", "given")]),
    ]);
    expect(basis.matchedUnits).toBe(1);
    expect(basis.estimatedMargin).toBe(30);
  });

  it("matches a same-timestamp purchase even when the sale is listed first", () => {
    const stamp = at("2026-01-01");
    const basis = fifoCostBasis([
      ev(stamp, "sale", 40, [item("Widget", "given")]),
      ev(stamp, "purchase", 10, [item("Widget", "received")]),
    ]);
    expect(basis.matchedUnits).toBe(1);
    expect(basis.unpricedUnits).toBe(0);
    expect(basis.estimatedMargin).toBe(30);
  });

  it("keys by uniqueName so two names for one item still match", () => {
    const basis = fifoCostBasis([
      ev(at("2026-01-01"), "purchase", 10, [item("Widget", "received", 1, "/Lotus/Widget")]),
      ev(at("2026-01-02"), "sale", 40, [item("Widget (Veiled)", "given", 1, "/Lotus/Widget")]),
    ]);
    expect(basis.matchedUnits).toBe(1);
    expect(basis.estimatedMargin).toBe(30);
  });
});

describe("worthToday", () => {
  const events = [
    ev(at("2026-01-01"), "sale", 100, [item("Priced", "given", 2)]),
    ev(at("2026-01-02"), "sale", 40, [item("Unpriced", "given", 1)]),
  ];

  it("prices what it can and counts what it cannot", () => {
    const result = worthToday(events, (i) => (i.displayName === "Priced" ? 60 : null));
    expect(result.totalWorth).toBe(120);
    expect(result.pricedUnits).toBe(2);
    expect(result.unpricedUnits).toBe(1);
    expect(result.unpricedRows).toBe(1);
    expect(result.realized).toBe(140);
  });

  it("never treats a missing price as zero", () => {
    const result = worthToday(events, () => null);
    expect(result.totalWorth).toBe(0);
    expect(result.unpricedRows).toBe(2);
    expect(result.rows.every((r) => r.worth === null && r.median === null)).toBe(true);
  });

  it("ignores a non-finite median", () => {
    const result = worthToday(events, () => Number.NaN);
    expect(result.unpricedRows).toBe(2);
    expect(result.totalWorth).toBe(0);
  });
});

describe("distinctItemCategories / categoryNames", () => {
  const events = [
    ev(at("2026-01-01"), "sale", 10, [item("Zephyr Prime", "given")]),
    ev(at("2026-01-02"), "purchase", 5, [item("Ammo Drum", "received")]),
    ev(at("2026-01-03"), "sale", 20, [item("Zephyr Prime", "given")]),
  ];
  const resolve = (i: TradeItem): string =>
    i.displayName === "Zephyr Prime" ? "Warframe" : UNCATEGORIZED;

  it("lists each item once, name-sorted, and flags overridden rows", () => {
    const overrides = { [itemKey(item("Ammo Drum", "received"))]: "Mods" };
    const rows = distinctItemCategories(
      events,
      withCategoryOverrides(resolve, overrides),
      overrides,
    );
    expect(rows.map((r) => r.name)).toEqual(["Ammo Drum", "Zephyr Prime"]);
    expect(rows[0]).toMatchObject({ resolved: "Mods", overridden: true });
    expect(rows[1]).toMatchObject({ resolved: "Warframe", overridden: false });
  });

  it("suggests only real categories, never the uncategorized sentinel", () => {
    const rows = distinctItemCategories(events, resolve, {});
    expect(categoryNames(rows)).toEqual(["Warframe"]);
  });
});

describe("formatting", () => {
  it("rounds platinum and signs percentages", () => {
    expect(formatPlat(1234.6, "en")).toBe("1,235");
    expect(formatPlat(Number.NaN, "en")).toBe("0");
    expect(formatPct(12.34, "en")).toBe("+12.3%");
    expect(formatPct(-5, "en")).toBe("-5.0%");
    expect(formatPct(null, "en")).toBeNull();
  });
});

describe("category overrides persistence", () => {
  let mem: Map<string, string>;

  beforeEach(() => {
    mem = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => void mem.set(key, value),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips through localStorage", () => {
    saveCategoryOverrides({ "/Lotus/Widget": "Mods" });
    expect(loadCategoryOverrides()).toEqual({ "/Lotus/Widget": "Mods" });
  });

  it("degrades to empty on corrupt or wrongly typed data", () => {
    mem.set("wf_analysis_category_overrides", "{not json");
    expect(loadCategoryOverrides()).toEqual({});
    mem.set("wf_analysis_category_overrides", JSON.stringify({ a: 5, b: "  " }));
    expect(loadCategoryOverrides()).toEqual({});
  });

  it("returns empty when storage is absent entirely", () => {
    vi.unstubAllGlobals();
    expect(loadCategoryOverrides()).toEqual({});
  });
});
