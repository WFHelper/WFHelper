import { describe, expect, it } from "vitest";

import {
  DEFAULT_DAMPING_RULE,
  maxAllowedDrop,
  suggestPrice,
  WORKBENCH_STRATEGY_IDS,
  type DampingRule,
  type MedianStrategyId,
  type PricingContext,
  type PricingListing,
  type WorkbenchStrategyId,
} from "../../../../src/lib/tradeWorkbench/pricingStrategies.js";

function listing(platinum: number, overrides: Partial<PricingListing> = {}): PricingListing {
  return { platinum, quantity: 1, status: "ingame", userName: `seller${platinum}`, ...overrides };
}

/** A WFM bulk listing: `platinum` buys `perTrade` items at once. */
function bulkListing(
  platinum: number,
  perTrade: number,
  overrides: Partial<PricingListing> = {},
): PricingListing {
  return {
    ...listing(platinum, overrides),
    unitPlatinum: Math.round((platinum / perTrade) * 100) / 100,
    quantity: perTrade * 4,
  };
}

function ctx(sell: PricingListing[], overrides: Partial<PricingContext> = {}): PricingContext {
  return { sellListings: sell, currentPrice: null, ...overrides };
}

const RULE: DampingRule = { minListingsBelow: 3, maxDropPercent: 10, maxDropPlat: 8 };

describe("workbench pricing strategies", () => {
  it("offers every strategy exactly once in the picker list", () => {
    const expected: WorkbenchStrategyId[] = [
      "match-cheapest",
      "cheapest-minus-one",
      "percent-offset",
      "bounded-cheapest-average",
      "median-48h",
      "median-90d",
      "target-margin",
      "manual",
    ];
    expect([...WORKBENCH_STRATEGY_IDS].sort()).toEqual([...expected].sort());
  });

  it("match-cheapest returns the cheapest active listing", () => {
    const result = suggestPrice(
      { id: "match-cheapest" },
      ctx([listing(30), listing(25), listing(40)]),
    );
    expect(result.price).toBe(25);
    expect(result.inputs.cheapest).toBe(25);
    expect(result.inputs.listingsConsidered).toBe(3);
  });

  it("ignores offline sellers and our own listing", () => {
    const result = suggestPrice(
      { id: "match-cheapest" },
      ctx(
        [
          listing(10, { status: "offline" }),
          listing(12, { userName: "Me" }),
          listing(20, { userName: "rival" }),
        ],
        { ownUserName: "me" },
      ),
    );
    expect(result.price).toBe(20);
    expect(result.inputs.listingsConsidered).toBe(1);
  });

  it("cheapest-minus-one floors at 1 platinum", () => {
    expect(suggestPrice({ id: "cheapest-minus-one" }, ctx([listing(1)])).price).toBe(1);
    expect(suggestPrice({ id: "cheapest-minus-one" }, ctx([listing(15)])).price).toBe(14);
  });

  it("percent-offset applies the signed percentage to the cheapest", () => {
    const result = suggestPrice({ id: "percent-offset", percent: -10 }, ctx([listing(100)]));
    expect(result.price).toBe(90);
  });

  it("bounded cheapest-average averages only listings inside the threshold", () => {
    const result = suggestPrice(
      { id: "bounded-cheapest-average", count: 5, thresholdPercent: 10 },
      ctx([listing(100), listing(105), listing(110), listing(140)]),
    );
    expect(result.price).toBe(105);
    expect(result.inputs.average).toBe(105);
    expect(result.inputs.listingsConsidered).toBe(3);
    expect(result.confidence).toBe(0.6);
  });

  it("bounded cheapest-average caps the pool at N cheapest", () => {
    const result = suggestPrice(
      { id: "bounded-cheapest-average", count: 2, thresholdPercent: 50 },
      ctx([listing(100), listing(110), listing(120)]),
    );
    expect(result.price).toBe(105);
    expect(result.confidence).toBe(1);
  });

  it("target-margin prices from cost and flags an unlikely ask", () => {
    const cheapExpensive = suggestPrice(
      { id: "target-margin", costPlat: 100, marginPercent: 20 },
      ctx([listing(90)]),
    );
    expect(cheapExpensive.price).toBe(120);
    expect(cheapExpensive.confidence).toBe(0.3);

    const competitive = suggestPrice(
      { id: "target-margin", costPlat: 100, marginPercent: 20 },
      ctx([listing(150)]),
    );
    expect(competitive.price).toBe(120);
    expect(competitive.confidence).toBe(0.6);
  });

  it("manual suggests no price at all, so a row stays unpriced", () => {
    const result = suggestPrice({ id: "manual" }, ctx([listing(40), listing(50)]));
    expect(result.price).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("target-margin with no cost yields no price instead of a 1p ask", () => {
    const result = suggestPrice(
      { id: "target-margin", costPlat: 0, marginPercent: 20 },
      ctx([listing(40)]),
    );
    expect(result.price).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("target-margin at a cost that rounds below 1p yields no price", () => {
    const result = suggestPrice(
      { id: "target-margin", costPlat: 0, marginPercent: -100 },
      ctx([listing(40)]),
    );
    expect(result.price).toBeNull();
  });

  it("compares a bulk listing by its per-item price, not its listed price", () => {
    const book = [bulkListing(97, 6, { userName: "bulk" }), listing(20, { userName: "single" })];

    expect(suggestPrice({ id: "match-cheapest" }, ctx(book)).inputs.cheapest).toBe(16.17);
    expect(suggestPrice({ id: "match-cheapest" }, ctx(book)).price).toBe(16);
    expect(suggestPrice({ id: "cheapest-minus-one" }, ctx(book)).price).toBe(15);
    expect(suggestPrice({ id: "percent-offset", percent: 10 }, ctx(book)).price).toBe(18);
  });

  it("keeps a dearer bulk listing out of the bounded average", () => {
    const result = suggestPrice(
      { id: "bounded-cheapest-average", count: 5, thresholdPercent: 10 },
      ctx([listing(100), listing(110), bulkListing(240, 2, { userName: "bulk" })]),
    );
    expect(result.price).toBe(105);
    expect(result.inputs.listingsConsidered).toBe(2);
  });

  it("prices our own bulk listing per trade, the way WFM takes it", () => {
    const result = suggestPrice({ id: "match-cheapest" }, ctx([listing(20)], { ownPerTrade: 6 }));
    expect(result.price).toBe(120);
    expect(result.inputs.cheapest).toBe(20);
  });

  it("returns null price with zero confidence on an empty book", () => {
    const result = suggestPrice({ id: "match-cheapest" }, ctx([]));
    expect(result.price).toBeNull();
    expect(result.confidence).toBe(0);
  });
});

describe("downward damping guard", () => {
  it("does not damp without an existing listing", () => {
    const result = suggestPrice({ id: "match-cheapest" }, ctx([listing(10)]), RULE);
    expect(result.price).toBe(10);
    expect(result.damping).toBeUndefined();
  });

  it("does not damp an upward or equal move", () => {
    const result = suggestPrice(
      { id: "match-cheapest" },
      ctx([listing(60)], { currentPrice: 50 }),
      RULE,
    );
    expect(result.price).toBe(60);
    expect(result.damping).toBeUndefined();
  });

  it("holds the price when fewer than N listings undercut us", () => {
    const result = suggestPrice(
      { id: "match-cheapest" },
      ctx([listing(45), listing(47), listing(55)], { currentPrice: 50 }),
      RULE,
    );
    expect(result.price).toBe(50);
    expect(result.damping).toEqual({ applied: true, reason: "depth", undampedPrice: 45 });
    expect(result.inputs.listingsBelowCurrent).toBe(2);
  });

  it("follows the market at exactly N listings below and drop within bound", () => {
    const result = suggestPrice(
      { id: "match-cheapest" },
      ctx([listing(46), listing(47), listing(48)], { currentPrice: 50 }),
      RULE,
    );
    expect(result.price).toBe(46);
    expect(result.damping).toBeUndefined();
  });

  it("follows a drop exactly at the max-drop bound", () => {
    const result = suggestPrice(
      { id: "match-cheapest" },
      ctx([listing(45), listing(46), listing(47)], { currentPrice: 50 }),
      RULE,
    );
    expect(result.price).toBe(45);
    expect(result.damping).toBeUndefined();
  });

  it("clamps a drop beyond the bound to the max allowed step", () => {
    const result = suggestPrice(
      { id: "match-cheapest" },
      ctx([listing(20), listing(21), listing(22)], { currentPrice: 50 }),
      RULE,
    );
    expect(result.price).toBe(45);
    expect(result.damping).toEqual({ applied: true, reason: "max-drop", undampedPrice: 20 });
  });

  it("uses the smaller of the percent and absolute drop bounds", () => {
    expect(maxAllowedDrop(50, RULE)).toBe(5); // 10% of 50 < 8 plat
    expect(maxAllowedDrop(200, RULE)).toBe(8); // 10% of 200 > 8 plat
    expect(maxAllowedDrop(5, RULE)).toBe(1); // never below a 1p step
  });

  it("never damps a manual row: there is no suggestion to damp", () => {
    const result = suggestPrice({ id: "manual" }, ctx([listing(45)], { currentPrice: 50 }), RULE);
    expect(result.price).toBeNull();
    expect(result.damping).toBeUndefined();
  });

  it("default rule is sane", () => {
    expect(DEFAULT_DAMPING_RULE.minListingsBelow).toBeGreaterThan(0);
    expect(DEFAULT_DAMPING_RULE.maxDropPercent).toBeGreaterThan(0);
    expect(DEFAULT_DAMPING_RULE.maxDropPlat).toBeGreaterThan(0);
  });
});

describe("median strategies", () => {
  const MEDIAN_IDS: MedianStrategyId[] = ["median-48h", "median-90d"];
  const OUTLIER_BOOK = [listing(1, { userName: "undercutter" }), listing(40), listing(42)];

  it.each(MEDIAN_IDS)("%s ignores a lone 1p seller and prices from the median", (id) => {
    const result = suggestPrice(
      { id, offsetPlat: 0 },
      ctx(OUTLIER_BOOK, { median: { median: 50, days: 20 } }),
    );
    expect(result.price).toBe(50);
    expect(result.inputs.cheapest).toBe(1);
    expect(result.inputs.listingsConsidered).toBe(3);
    expect(result.inputs.median).toBe(50);
  });

  it.each([
    [-1, 49],
    [2, 52],
  ])("adds a plat offset of %i to the median", (offsetPlat, expected) => {
    for (const id of MEDIAN_IDS) {
      const result = suggestPrice(
        { id, offsetPlat },
        ctx(OUTLIER_BOOK, { median: { median: 50, days: null } }),
      );
      expect(result.price).toBe(expected);
    }
  });

  it.each(MEDIAN_IDS)("%s leaves the row unpriced without a median", (id) => {
    for (const median of [null, undefined]) {
      const result = suggestPrice(
        { id, offsetPlat: -1 },
        ctx([listing(40)], median === null ? { median } : {}),
      );
      expect(result.price).toBeNull();
      expect(result.confidence).toBe(0);
    }
  });

  it("an offset that takes the ask below 1p yields no price, not a 1p listing", () => {
    const result = suggestPrice(
      { id: "median-48h", offsetPlat: -1 },
      ctx([listing(40)], { median: { median: 1, days: null } }),
    );
    expect(result.price).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("prices without any listing book at all", () => {
    const result = suggestPrice(
      { id: "median-90d", offsetPlat: 0 },
      ctx([], { median: { median: 30.4, days: 12 } }),
    );
    expect(result.price).toBe(30);
    expect(result.inputs.cheapest).toBeNull();
    expect(result.inputs.medianDays).toBe(12);
  });

  it("prices a bulk listing per trade from the per-item median", () => {
    const result = suggestPrice(
      { id: "median-48h", offsetPlat: -1 },
      ctx([listing(12)], { ownPerTrade: 5, median: { median: 10, days: null } }),
    );
    expect(result.price).toBe(45);
  });

  it("scales confidence with trading days and keeps the 48h price at a fixed middle", () => {
    const at = (days: number | null): number =>
      suggestPrice({ id: "median-90d", offsetPlat: 0 }, ctx([], { median: { median: 20, days } }))
        .confidence;
    expect(at(15)).toBe(0.5);
    expect(at(45)).toBe(1);
    expect(at(7)).toBeLessThan(at(20));
    expect(at(null)).toBe(0.5);
  });

  it("still goes through the downward damping guard", () => {
    const held = suggestPrice(
      { id: "median-90d", offsetPlat: 0 },
      ctx([listing(1), listing(70)], { currentPrice: 80, median: { median: 50, days: 30 } }),
      RULE,
    );
    expect(held.price).toBe(80);
    expect(held.damping).toEqual({ applied: true, reason: "depth", undampedPrice: 50 });
  });
});
