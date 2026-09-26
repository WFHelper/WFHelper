import { describe, expect, it } from "vitest";

import {
  buildRepriceRows,
  priceRepriceRow,
  repriceRowsToSend,
  repriceTotals,
  runReprice,
  type RepriceRow,
} from "../../../src/lib/market/repriceOrders";
import {
  DEFAULT_DAMPING_RULE,
  type PricingListing,
} from "../../../src/lib/tradeWorkbench/pricingStrategies";
import type { WfmOrder } from "../../../src/types/market";

function order(overrides: Partial<WfmOrder> = {}): WfmOrder {
  return {
    id: "a".repeat(24),
    orderType: "sell",
    platinum: 50,
    quantity: 1,
    visible: true,
    modRank: null,
    itemId: "item-1",
    itemName: "Fixture Item",
    itemUrlName: "fixture_item",
    itemThumb: null,
    ...overrides,
  } as WfmOrder;
}

function listing(platinum: number, userName = "someone"): PricingListing {
  return { platinum, quantity: 1, status: "ingame", userName };
}

describe("buildRepriceRows", () => {
  it("drops orders with no slug to price against", () => {
    const rows = buildRepriceRows([order(), order({ id: "b".repeat(24), itemUrlName: null })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe("fixture_item");
    expect(rows[0].currentPrice).toBe(50);
  });

  it("drops an order with no price, which cannot be repriced from", () => {
    expect(buildRepriceRows([order({ platinum: 0 })])).toHaveLength(0);
  });

  it("drops buy orders, which the sell-side strategies would misprice", () => {
    const rows = buildRepriceRows([
      order({ id: "b".repeat(24), orderType: "buy", platinum: 30 }),
      order(),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].order.orderType).toBe("sell");
  });

  it("selects every row, so an untouched modal still reprices everything", () => {
    const rows = buildRepriceRows([order(), order({ id: "b".repeat(24) })]);
    expect(rows.map((row) => row.selected)).toEqual([true, true]);
  });

  it("carries the listing subtype so the book is filtered to that refinement", () => {
    const rows = buildRepriceRows([order({ subtype: "radiant" }), order({ id: "c".repeat(24) })]);
    expect(rows[0].subtype).toBe("radiant");
    expect(rows[1].subtype).toBeNull();
  });
});

describe("priceRepriceRow", () => {
  const base = buildRepriceRows([order()])[0];

  it("refuses a buy order handed in from elsewhere", () => {
    const row = {
      ...base,
      order: order({ orderType: "buy" }),
      sellBook: [listing(175, "rival")],
    };
    const priced = priceRepriceRow(row, { id: "cheapest-minus-one" }, null);
    expect(priced.skipReason).toBe("not-sell");
    expect(priced.nextPrice).toBeNull();
    expect(repriceRowsToSend([priced])).toHaveLength(0);
  });

  it("marks a row with no book instead of pricing it blind", () => {
    const priced = priceRepriceRow(base, { id: "match-cheapest" }, null);
    expect(priced.skipReason).toBe("no-book");
    expect(priced.nextPrice).toBeNull();
  });

  it("never counts our own listing as the competition", () => {
    const cheap = buildRepriceRows([order({ platinum: 30 })])[0];
    const row = { ...cheap, sellBook: [listing(10, "me"), listing(44, "rival")] };
    const priced = priceRepriceRow(row, { id: "match-cheapest" }, "ME");
    expect(priced.nextPrice).toBe(44);
  });

  it("skips a row the strategy leaves where it is", () => {
    const row = { ...base, sellBook: [listing(50, "rival")] };
    const priced = priceRepriceRow(row, { id: "match-cheapest" }, null);
    expect(priced.skipReason).toBe("unchanged");
    expect(repriceRowsToSend([priced])).toHaveLength(0);
  });

  it("holds the price when too few listings sit below it", () => {
    const row = { ...base, sellBook: [listing(20, "rival")] };
    const priced = priceRepriceRow(row, { id: "match-cheapest" }, null);
    expect(priced.nextPrice).toBe(50);
    expect(priced.skipReason).toBe("unchanged");
  });

  it("follows the market down once enough listings are below", () => {
    const row = {
      ...base,
      sellBook: [listing(46), listing(47), listing(48), listing(49)],
    };
    const priced = priceRepriceRow(row, { id: "match-cheapest" }, null);
    expect(priced.nextPrice).toBe(46);
    expect(priced.skipReason).toBeNull();
  });

  it("prices a median strategy from its reference, not a lone 1p seller", () => {
    const row = { ...base, sellBook: [listing(1, "undercutter"), listing(58), listing(61)] };
    const config = { id: "median-90d", offsetPlat: -1 } as const;
    const priced = priceRepriceRow(row, config, null, DEFAULT_DAMPING_RULE, {
      median: 60,
      days: 40,
    });
    expect(priced.nextPrice).toBe(59);
    expect(priced.skipReason).toBeNull();
    expect(priceRepriceRow(row, config, null).skipReason).toBe("no-price");
  });
});

describe("runReprice", () => {
  function sendable(count: number): RepriceRow[] {
    return Array.from({ length: count }, (_, index) => {
      const row = buildRepriceRows([
        order({ id: `id-${index}`, itemName: `Item ${index}` }),
      ])[0] as RepriceRow;
      return { ...row, nextPrice: row.currentPrice - 5, skipReason: null };
    });
  }

  it("sends nothing more once cancelled, the in-flight row included", async () => {
    const rows = sendable(3);
    const sent: string[] = [];
    let cancelled = false;
    const result = await runReprice(rows, {
      updateOrder: async (row) => {
        sent.push(row.rowId);
        cancelled = true;
        return {};
      },
      isCancelled: () => cancelled,
    });

    expect(sent).toEqual(["id-0"]);
    expect(result.cancelled).toBe(true);
    expect(result.applied).toEqual([{ id: "id-0", platinum: 45 }]);
  });

  it("stops on a lost session instead of failing every remaining row", async () => {
    const rows = sendable(3);
    let calls = 0;
    const result = await runReprice(rows, {
      updateOrder: async () => {
        calls += 1;
        return { error: "Warframe.market session expired or invalid." };
      },
      isSignedOut: async () => true,
    });

    expect(calls).toBe(1);
    expect(result.stopReason).toBe("auth");
    expect(result.failed).toEqual(["Item 0"]);
    expect(result.applied).toHaveLength(0);
  });

  it("works through a transient failure that left the session alive", async () => {
    const rows = sendable(3);
    let calls = 0;
    const result = await runReprice(rows, {
      updateOrder: async () => {
        calls += 1;
        return calls === 1 ? { error: "HTTP 503" } : {};
      },
      isSignedOut: async () => false,
    });

    expect(calls).toBe(3);
    expect(result.stopReason).toBeNull();
    expect(result.failed).toEqual(["Item 0"]);
    expect(result.applied).toHaveLength(2);
  });

  it("does not abandon the run when the session probe itself fails", async () => {
    const rows = sendable(2);
    const result = await runReprice(rows, {
      updateOrder: async () => ({ error: "HTTP 503" }),
      isSignedOut: async () => {
        throw new Error("ipc gone");
      },
    });

    expect(result.stopReason).toBeNull();
    expect(result.failed).toHaveLength(2);
  });

  it("counts a rejected call as a failed row and keeps the sent ones", async () => {
    const rows = sendable(2);
    let calls = 0;
    const result = await runReprice(rows, {
      updateOrder: async () => {
        calls += 1;
        if (calls === 1) throw new Error("channel closed");
        return {};
      },
    });

    expect(result.failed).toEqual(["Item 0"]);
    expect(result.applied).toEqual([{ id: "id-1", platinum: 45 }]);
  });

  it("treats a payload whose error field is not a string as a success", async () => {
    const result = await runReprice(sendable(1), {
      updateOrder: async () => ({ id: "id-0", platinum: 45, error: 0 }),
    });

    expect(result.failed).toHaveLength(0);
    expect(result.applied).toHaveLength(1);
  });

  it("reports progress after every row so a run can be watched", async () => {
    const seen: Array<[number, number]> = [];
    let calls = 0;
    await runReprice(sendable(3), {
      updateOrder: async () => {
        calls += 1;
        return calls === 2 ? { error: "HTTP 500" } : {};
      },
      onProgress: (applied, failed) => seen.push([applied, failed.length]),
    });

    expect(seen).toEqual([
      [1, 0],
      [1, 1],
      [2, 1],
    ]);
  });
});

describe("repriceRowsToSend", () => {
  it("leaves an unselected row alone even when the strategy moved its price", () => {
    const base = buildRepriceRows([order()])[0];
    const priced = { ...base, nextPrice: 40, skipReason: null };

    expect(repriceRowsToSend([priced])).toHaveLength(1);
    expect(repriceRowsToSend([{ ...priced, selected: false }])).toHaveLength(0);
  });
});

describe("repriceTotals", () => {
  it("counts the rows a run would send and which way they move", () => {
    const base = buildRepriceRows([order()])[0];
    const up = { ...base, nextPrice: 60, skipReason: null };
    const down = { ...base, rowId: "down", nextPrice: 40, skipReason: null };
    const held = { ...base, rowId: "held", nextPrice: 50, skipReason: "unchanged" as const };

    expect(repriceTotals([up, down, held])).toEqual({
      rows: 3,
      sending: 2,
      raised: 1,
      lowered: 1,
      platinumDelta: 0,
    });
  });

  it("summarises the selection only, while the row count stays the whole list", () => {
    const base = buildRepriceRows([order()])[0];
    const up = { ...base, nextPrice: 60, skipReason: null };
    const down = { ...base, rowId: "down", nextPrice: 40, skipReason: null, selected: false };

    expect(repriceTotals([up, down])).toEqual({
      rows: 2,
      sending: 1,
      raised: 1,
      lowered: 0,
      platinumDelta: 10,
    });
  });
});
