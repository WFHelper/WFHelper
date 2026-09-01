import { describe, expect, it } from "vitest";

import {
  DEFAULT_DAMPING_RULE,
  maxAllowedDrop,
  suggestPrice,
  WORKBENCH_STRATEGY_IDS,
  type DampingRule,
  type PricingContext,
  type PricingListing,
  type WorkbenchStrategyId,
} from "../../../../src/lib/tradeWorkbench/pricingStrategies.js";

function listing(platinum: number, overrides: Partial<PricingListing> = {}): PricingListing {
  return { platinum, quantity: 1, status: "ingame", userName: `seller${platinum}`, ...overrides };
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
    // min 100, 10% ceiling = 110: pool is 100/105/110, not 140.
    const result = suggestPrice(
      { id: "bounded-cheapest-average", count: 5, thresholdPercent: 10 },
      ctx([listing(100), listing(105), listing(110), listing(140)]),
    );
    expect(result.price).toBe(105);
    expect(result.inputs.average).toBe(105);
    expect(result.inputs.listingsConsidered).toBe(3);
    // Confidence follows sample completeness: 3 of the requested 5.
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
    // Two below 50 with minListingsBelow 3: hold at 50.
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
    // Three below 50, drop 50 -> 46 = 4 <= allowed 5 (10% of 50, plat cap 8).
    const result = suggestPrice(
      { id: "match-cheapest" },
      ctx([listing(46), listing(47), listing(48)], { currentPrice: 50 }),
      RULE,
    );
    expect(result.price).toBe(46);
    expect(result.damping).toBeUndefined();
  });

  it("follows a drop exactly at the max-drop bound", () => {
    // Allowed drop = min(floor(50*10%), 8) = 5; 50 -> 45 is exactly 5.
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
