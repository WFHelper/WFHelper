import { describe, it, expect } from "vitest";

import {
  bestOrderPrice,
  formatUnitPlatinum,
  normalizePerTrade,
  normalizeWfmOrderBookSide,
} from "../../config/shared/wfmOrders";

function buyOrder(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "buy",
    platinum: 97,
    quantity: 24,
    visible: true,
    user: { ingameName: "K1r1ll47", status: "ingame" },
    ...overrides,
  };
}

describe("normalizeWfmOrderBookSide bulk orders", () => {
  it("reads perTrade in both spellings and prices the order per item", () => {
    const [v2] = normalizeWfmOrderBookSide([buyOrder({ perTrade: 6 })], "buy", null);
    const [v1] = normalizeWfmOrderBookSide(
      [buyOrder({ order_type: "buy", type: undefined, per_trade: 6 })],
      "buy",
      null,
    );

    // 97p buys six arcanes, the way warframe.market's own site reads it.
    expect(v2).toMatchObject({ platinum: 97, quantity: 24, perTrade: 6, unitPlatinum: 16.17 });
    expect(v1).toMatchObject({ platinum: 97, perTrade: 6, unitPlatinum: 16.17 });
  });

  it("falls back to one per trade for a missing, invalid or oversized value", () => {
    const rows = normalizeWfmOrderBookSide(
      [
        buyOrder({ user: { ingameName: "absent", status: "ingame" } }),
        buyOrder({ perTrade: 0, user: { ingameName: "zero", status: "ingame" } }),
        buyOrder({ perTrade: -3, user: { ingameName: "negative", status: "ingame" } }),
        buyOrder({ perTrade: 2.5, user: { ingameName: "fractional", status: "ingame" } }),
        buyOrder({ perTrade: "nope", user: { ingameName: "text", status: "ingame" } }),
        buyOrder({ perTrade: 40, user: { ingameName: "oversized", status: "ingame" } }),
      ],
      "buy",
      null,
    );

    expect(rows).toHaveLength(6);
    expect(rows.find((row) => row.userName === "oversized")).toMatchObject({ perTrade: 24 });
    for (const name of ["absent", "zero", "negative", "fractional", "text"]) {
      expect(rows.find((row) => row.userName === name)).toMatchObject({
        perTrade: 1,
        unitPlatinum: 97,
      });
    }
  });

  it("sorts both sides by the per-item price", () => {
    const orders = [
      buyOrder({ platinum: 97, perTrade: 6, user: { ingameName: "bulk", status: "ingame" } }),
      buyOrder({ platinum: 20, quantity: 1, user: { ingameName: "single", status: "ingame" } }),
      {
        ...buyOrder({ platinum: 97, perTrade: 6 }),
        type: "sell",
        user: { ingameName: "bulkSell" },
      },
      {
        ...buyOrder({ platinum: 20, quantity: 1 }),
        type: "sell",
        user: { ingameName: "singleSell" },
      },
    ];

    expect(normalizeWfmOrderBookSide(orders, "buy", null).map((row) => row.userName)).toEqual([
      "single",
      "bulk",
    ]);
    expect(normalizeWfmOrderBookSide(orders, "sell", null).map((row) => row.userName)).toEqual([
      "bulkSell",
      "singleSell",
    ]);
  });
});

describe("normalizeWfmOrderBookSide Ayatan stars", () => {
  it("keeps socketed star counts and leaves the keys off every other order", () => {
    const [sculpture, plain, broken] = normalizeWfmOrderBookSide(
      [
        buyOrder({ amberStars: 1, cyanStars: 2, user: { ingameName: "a", status: "ingame" } }),
        buyOrder({ user: { ingameName: "b", status: "ingame" } }),
        buyOrder({ amberStars: -1, cyanStars: 1.5, user: { ingameName: "c", status: "ingame" } }),
      ],
      "buy",
      null,
    );

    expect(sculpture).toMatchObject({ amberStars: 1, cyanStars: 2 });
    expect(plain).not.toHaveProperty("amberStars");
    expect(plain).not.toHaveProperty("cyanStars");
    expect(broken).not.toHaveProperty("amberStars");
    expect(broken).not.toHaveProperty("cyanStars");
  });
});

describe("bestOrderPrice", () => {
  const entry = (platinum: number, unitPlatinum?: number) => ({
    platinum,
    status: "ingame",
    ...(unitPlatinum == null ? {} : { unitPlatinum }),
  });

  it("compares per-item prices and rounds the winner", () => {
    expect(bestOrderPrice([entry(97, 16.17), entry(20)], "buy", true)).toBe(20);
    expect(bestOrderPrice([entry(97, 16.17), entry(30)], "sell", true)).toBe(16);
  });

  it("keeps using the listed price when no unit price is present", () => {
    expect(bestOrderPrice([entry(90), entry(80)], "sell", true)).toBe(80);
    expect(bestOrderPrice([entry(50), entry(65)], "buy", true)).toBe(65);
    expect(bestOrderPrice([], "buy", true)).toBeNull();
  });

  it("skips offline sellers only when active orders are asked for", () => {
    const offline = { platinum: 5, unitPlatinum: 5, status: "offline" };
    expect(bestOrderPrice([offline, entry(30)], "sell", true)).toBe(30);
    expect(bestOrderPrice([offline, entry(30)], "sell", false)).toBe(5);
  });

  it("never reports a live listing as free", () => {
    // 1p for three items: 0.33 per item, which rounds to nothing.
    expect(bestOrderPrice([entry(1, 0.33)], "sell", true)).toBe(1);
    expect(bestOrderPrice([entry(1, 0.33)], "buy", true)).toBe(1);
    expect(bestOrderPrice([entry(1, 0.33), entry(20)], "sell", true)).toBe(1);
  });
});

describe("normalizePerTrade", () => {
  it("clamps to the listed quantity only when one is given", () => {
    expect(normalizePerTrade(6, 24)).toBe(6);
    expect(normalizePerTrade(40, 24)).toBe(24);
    expect(normalizePerTrade(40)).toBe(40);
  });

  it("falls back to one for anything that is not a positive integer", () => {
    for (const value of [undefined, null, 0, -3, 2.5, "nope", {}]) {
      expect(normalizePerTrade(value, 24)).toBe(1);
    }
  });
});

describe("formatUnitPlatinum", () => {
  it("prints whole prices bare and fractional ones without trailing zeros", () => {
    expect(formatUnitPlatinum(97)).toBe("97");
    expect(formatUnitPlatinum(16.166666)).toBe("16.17");
    expect(formatUnitPlatinum(16.1)).toBe("16.1");
    expect(formatUnitPlatinum(-80)).toBe("-80");
  });
});
