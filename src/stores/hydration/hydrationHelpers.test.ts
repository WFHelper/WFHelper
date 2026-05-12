import { describe, expect, it } from "vitest";

import {
  resolvePriceRank,
  resolveRankedMaxRank,
  itemPriceRank,
  hasResolvedPrice,
  hasRankPairCoverage,
  isActiveOrderStatus,
  cheapestOrderPrice,
} from "./hydrationHelpers.js";
import type { InventoryBaseItem, ItemMetrics } from "../../lib/inventoryMarket.js";

function makeItem(overrides: Partial<InventoryBaseItem> = {}): InventoryBaseItem {
  return {
    name: "Test Item",
    internalName: "/Lotus/Test",
    inventoryGroup: "misc",
    partType: "normal",
    amount: 1,
    favorite: false,
    equipped: false,
    orderPlaced: false,
    completeSets: null,
    marketSlug: null,
    marketThumb: null,
    ...overrides,
  } as InventoryBaseItem;
}

function makeMetrics(overrides: Partial<ItemMetrics> = {}): ItemMetrics {
  return {
    platinum: null,
    ducats: null,
    slug: null,
    thumb: null,
    icon: null,
    hasPrice: false,
    hasDucats: false,
    hasMeta: false,
    ...overrides,
  };
}

describe("resolvePriceRank", () => {
  it("returns null for non-ranked groups", () => {
    expect(resolvePriceRank(makeItem({ inventoryGroup: "misc" }))).toBeNull();
    expect(resolvePriceRank(makeItem({ inventoryGroup: "relics" }))).toBeNull();
  });

  it("returns 0 for mods at rank 0", () => {
    const item = makeItem({ inventoryGroup: "mods", rank: 0 } as Partial<InventoryBaseItem>);
    expect(resolvePriceRank(item)).toBe(0);
  });

  it("returns maxRank for mods at max rank", () => {
    const item = makeItem({
      inventoryGroup: "mods",
      rank: 10,
      maxRank: 10,
    } as Partial<InventoryBaseItem>);
    expect(resolvePriceRank(item)).toBe(10);
  });

  it("returns 0 for mods below max rank", () => {
    const item = makeItem({
      inventoryGroup: "mods",
      rank: 5,
      maxRank: 10,
    } as Partial<InventoryBaseItem>);
    expect(resolvePriceRank(item)).toBe(0);
  });

  it("returns 0 for arcanes below max rank", () => {
    const item = makeItem({
      inventoryGroup: "arcanes",
      rank: 3,
      maxRank: 5,
    } as Partial<InventoryBaseItem>);
    expect(resolvePriceRank(item)).toBe(0);
  });

  it("defaults mod maxRank to 10", () => {
    const item = makeItem({ inventoryGroup: "mods", rank: 10 } as Partial<InventoryBaseItem>);
    expect(resolvePriceRank(item)).toBe(10);
  });

  it("defaults arcane maxRank to 5", () => {
    const item = makeItem({ inventoryGroup: "arcanes", rank: 5 } as Partial<InventoryBaseItem>);
    expect(resolvePriceRank(item)).toBe(5);
  });
});

describe("resolveRankedMaxRank", () => {
  it("returns null for non-ranked groups", () => {
    expect(resolveRankedMaxRank(makeItem({ inventoryGroup: "misc" }))).toBeNull();
  });

  it("defaults mods to 10", () => {
    expect(resolveRankedMaxRank(makeItem({ inventoryGroup: "mods" }))).toBe(10);
  });

  it("defaults arcanes to 5", () => {
    expect(resolveRankedMaxRank(makeItem({ inventoryGroup: "arcanes" }))).toBe(5);
  });

  it("uses explicit maxRank when available", () => {
    const item = makeItem({ inventoryGroup: "mods", maxRank: 3 } as Partial<InventoryBaseItem>);
    expect(resolveRankedMaxRank(item)).toBe(3);
  });
});

describe("itemPriceRank", () => {
  it("returns priceRank when present", () => {
    expect(itemPriceRank(makeMetrics({ priceRank: 5 }))).toBe(5);
  });

  it("returns null when metric is undefined", () => {
    expect(itemPriceRank(undefined)).toBeNull();
  });

  it("returns null when priceRank is null", () => {
    expect(itemPriceRank(makeMetrics({ priceRank: null }))).toBeNull();
  });
});

describe("hasResolvedPrice", () => {
  it("returns true when platinum is present", () => {
    expect(hasResolvedPrice(makeMetrics({ platinum: 10 }))).toBe(true);
  });

  it("returns true when platinumR0 is present", () => {
    expect(hasResolvedPrice(makeMetrics({ platinumR0: 5 }))).toBe(true);
  });

  it("returns true when platinumRmax is present", () => {
    expect(hasResolvedPrice(makeMetrics({ platinumRmax: 20 }))).toBe(true);
  });

  it("returns true when price was attempted without data", () => {
    expect(hasResolvedPrice(makeMetrics({ hasPrice: true }))).toBe(true);
  });

  it("returns false when no price fields are present", () => {
    expect(hasResolvedPrice(makeMetrics())).toBe(false);
  });

  it("returns false for undefined metric", () => {
    expect(hasResolvedPrice(undefined)).toBe(false);
  });
});

describe("hasRankPairCoverage", () => {
  it("returns true for non-ranked groups (always covered)", () => {
    expect(hasRankPairCoverage(undefined, makeItem({ inventoryGroup: "misc" }), {})).toBe(true);
  });

  it("returns false when price pair is incomplete", () => {
    const metric = makeMetrics({ hasPriceR0: true, hasPriceRmax: false });
    expect(hasRankPairCoverage(metric, makeItem({ inventoryGroup: "mods" }), {})).toBe(false);
  });

  it("returns true when price pair is complete and orders not needed", () => {
    const metric = makeMetrics({ hasPriceR0: true, hasPriceRmax: true });
    expect(hasRankPairCoverage(metric, makeItem({ inventoryGroup: "mods" }), {})).toBe(true);
  });

  it("returns true when non-tradable even if orders needed", () => {
    const metric = makeMetrics({ hasPriceR0: true, hasPriceRmax: true });
    const item = makeItem({
      inventoryGroup: "mods",
      tradable: false,
    } as Partial<InventoryBaseItem>);
    expect(hasRankPairCoverage(metric, item, { orders: true })).toBe(true);
  });

  it("returns false when tradable + orders needed but incomplete", () => {
    const metric = makeMetrics({
      hasPriceR0: true,
      hasPriceRmax: true,
      hasOrdersR0: true,
      hasOrdersRmax: false,
    });
    const item = makeItem({ inventoryGroup: "mods", tradable: true } as Partial<InventoryBaseItem>);
    expect(hasRankPairCoverage(metric, item, { orders: true })).toBe(false);
  });

  it("returns true when tradable + orders complete", () => {
    const metric = makeMetrics({
      hasPriceR0: true,
      hasPriceRmax: true,
      hasOrdersR0: true,
      hasOrdersRmax: true,
    });
    const item = makeItem({ inventoryGroup: "mods", tradable: true } as Partial<InventoryBaseItem>);
    expect(hasRankPairCoverage(metric, item, { orders: true })).toBe(true);
  });
});

describe("isActiveOrderStatus", () => {
  it("returns true for 'ingame'", () => {
    expect(isActiveOrderStatus("ingame")).toBe(true);
  });

  it("returns true for 'online'", () => {
    expect(isActiveOrderStatus("online")).toBe(true);
  });

  it("returns false for 'offline'", () => {
    expect(isActiveOrderStatus("offline")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isActiveOrderStatus(null)).toBe(false);
  });
});

describe("cheapestOrderPrice", () => {
  it("returns the cheapest price from all entries", () => {
    const entries = [
      { platinum: 20, status: "ingame" },
      { platinum: 10, status: "offline" },
      { platinum: 15, status: "online" },
    ];
    expect(cheapestOrderPrice(entries, false)).toBe(10);
  });

  it("filters by active status when activeOnly is true", () => {
    const entries = [
      { platinum: 20, status: "ingame" },
      { platinum: 5, status: "offline" },
      { platinum: 15, status: "online" },
    ];
    expect(cheapestOrderPrice(entries, true)).toBe(15);
  });

  it("returns null for empty list", () => {
    expect(cheapestOrderPrice([], false)).toBeNull();
  });

  it("returns null when no entries match activeOnly filter", () => {
    const entries = [{ platinum: 10, status: "offline" }];
    expect(cheapestOrderPrice(entries, true)).toBeNull();
  });
});
