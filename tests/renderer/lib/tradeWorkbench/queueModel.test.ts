import { describe, expect, it } from "vitest";

import { buildSafetyContext, safeToList } from "../../../../src/lib/inventory/safetyRules.js";
import {
  acknowledgeRowOverride,
  applyStrategy,
  attachExistingOrders,
  attachMarketData,
  bindingReasonKeys,
  buildPlanFromRows,
  buildQueueRows,
  buildSelectedQueueRows,
  buildSelectionSafetyContext,
  captureSafetySnapshot,
  dropStaleMarketData,
  mergeQueueRows,
  effectivePrice,
  eligibleSelectionKeys,
  filterQueueRows,
  loadQueueMarketData,
  planTotals,
  relicSubtypeFor,
  resolveQueueSlug,
  rowNeedsOverride,
  rowSafetyKey,
  rowWarnings,
  rowsNeedingMarketData,
  selectionKeyFor,
  setRowQuantity,
  unpricedHiddenCount,
  unpricedSelectedRows,
  type WorkbenchQueueRow,
} from "../../../../src/lib/tradeWorkbench/queueModel.js";
import { NO_PLAT_RANGE } from "../../../../src/lib/market/platRange.js";
import {
  parseWorkbenchPlan,
  WORKBENCH_MAX_ROWS_PER_RUN,
} from "../../../../config/shared/tradeWorkbenchTypes.js";
import type { PricingListing } from "../../../../src/lib/tradeWorkbench/pricingStrategies.js";
import type { ItemDbEntry, ParsedItem } from "../../../../src/types/inventory.js";
import type { WfmItemsLookup } from "../../../../src/types/ipc.js";
import type { WfmOrder } from "../../../../src/types/market.js";

function makeItem(name: string, overrides: Partial<ParsedItem> = {}): ParsedItem {
  return {
    name,
    internalName: `/Lotus/Test/${name.replace(/\s+/g, "")}`,
    category: "Misc",
    categoryLabel: "Misc",
    rank: 0,
    maxRank: 0,
    imageUrl: null,
    isPrime: false,
    masteryReq: 0,
    vaulted: false,
    tradable: true,
    description: "",
    components: [],
    drops: [],
    wikiaUrl: null,
    amount: 5,
    inventoryGroup: "all_parts",
    ...overrides,
  };
}

function lookupFor(...items: Array<{ name: string; slug: string }>): WfmItemsLookup {
  const lookup: WfmItemsLookup = {};
  for (const item of items) {
    lookup[item.name.toLowerCase()] = { url_name: item.slug, item_name: item.name };
  }
  return lookup;
}

function makeOrder(overrides: Partial<WfmOrder> = {}): WfmOrder {
  return {
    id: "order-1",
    orderType: "sell",
    platinum: 30,
    quantity: 2,
    visible: true,
    modRank: null,
    itemId: "abc",
    itemName: "Lex Prime Barrel",
    itemUrlName: "lex_prime_barrel",
    itemThumb: null,
    ...overrides,
  };
}

const EMPTY_CTX = buildSafetyContext({ itemDb: {} });

function sellBook(...prices: number[]): PricingListing[] {
  return prices.map((platinum, index) => ({
    platinum,
    quantity: 1,
    status: "ingame",
    userName: `seller${index}`,
  }));
}

function pricedRows(count: number): WorkbenchQueueRow[] {
  const rows: WorkbenchQueueRow[] = [];
  for (let i = 0; i < count; i++) {
    const built = buildQueueRows(
      [makeItem(`Item ${i}`)],
      EMPTY_CTX,
      lookupFor({ name: `Item ${i}`, slug: `item_${i}` }),
    );
    rows.push({ ...built[0], rowId: `r${i}`, selected: true, manualPrice: 5 });
  }
  return rows;
}

describe("workbench queue selection", () => {
  it("builds rows only for catalog-resolvable items and defaults qty to safe", () => {
    const items = [makeItem("Lex Prime Barrel"), makeItem("Unknown Thing")];
    const rows = buildQueueRows(
      items,
      EMPTY_CTX,
      lookupFor({ name: "Lex Prime Barrel", slug: "lex_prime_barrel" }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe("lex_prime_barrel");
    expect(rows[0].verdict.safe).toBe(5);
    expect(rows[0].quantity).toBe(5);
  });

  it("skips WFM-excluded slugs and incomplete sets", () => {
    const items = [
      makeItem("Vendor Relic"),
      makeItem("Partial Set", { inventoryGroup: "incomplete_sets" }),
    ];
    const rows = buildQueueRows(
      items,
      EMPTY_CTX,
      lookupFor(
        { name: "Vendor Relic", slug: "vendor_relic" },
        { name: "Partial Set", slug: "partial_set" },
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it("respects safety caps: protected copies need an explicit override", () => {
    const items = [makeItem("Boltor", { inventoryGroup: "equipment", amount: 2 })];
    const rows = buildQueueRows(items, EMPTY_CTX, lookupFor({ name: "Boltor", slug: "boltor" }));
    expect(rows[0].verdict).toMatchObject({ total: 2, reserved: 1, safe: 1 });
    expect(rows[0].quantity).toBe(1);
    expect(rowSafetyKey(rows[0])).toBe(rows[0].item.internalName);
    expect(bindingReasonKeys(rows[0].verdict)).toEqual(["inventory.safety.reason.lastCopy"]);

    let row = setRowQuantity(rows[0], 2);
    expect(rowNeedsOverride(row)).toBe(true);
    expect(rowWarnings(row)).toContain("override-needed");

    row = acknowledgeRowOverride(row, 123);
    expect(row.overrideAcknowledged).toBe(true);
    expect(row.overrideAcknowledgedAt).toBe(123);

    expect(setRowQuantity(row, 99).quantity).toBe(2);

    const sold = setRowQuantity(
      { ...row, verdict: { ...row.verdict, total: 1, safe: 1, reserved: 0 } },
      row.quantity,
    );
    expect(sold.quantity).toBe(1);
    expect(sold.overrideAcknowledged).toBe(false);
  });

  it("raising the quantity past a prior acknowledgement re-requires consent", () => {
    const spareCtx = buildSafetyContext({
      itemDb: {},
      settings: { spareDefault: 2, spares: {}, locks: [], setKeep: [] },
    });
    const items = [makeItem("Ammo Drum", { amount: 5 })];
    const rows = buildQueueRows(
      items,
      spareCtx,
      lookupFor({ name: "Ammo Drum", slug: "ammo_drum" }),
    );
    expect(rows[0].verdict).toMatchObject({ total: 5, safe: 3 });

    let row = acknowledgeRowOverride(setRowQuantity(rows[0], 4), 1);
    expect(row.overrideAcknowledged).toBe(true);
    row = setRowQuantity(row, 5);
    expect(row.overrideAcknowledged).toBe(false);
    row = setRowQuantity(acknowledgeRowOverride(row, 2), 3);
    expect(row.overrideAcknowledged).toBe(false);
    expect(rowNeedsOverride(row)).toBe(false);
  });

  it("matches an existing sell listing and plans an update for it", () => {
    const items = [makeItem("Lex Prime Barrel")];
    const rows = buildQueueRows(
      items,
      EMPTY_CTX,
      lookupFor({ name: "Lex Prime Barrel", slug: "lex_prime_barrel" }),
    );
    let row = attachMarketData(rows[0], sellBook(28, 28, 29, 31), null, [makeOrder()]);
    expect(row.existingOrder).toEqual({ id: "order-1", platinum: 30, quantity: 2, perTrade: 1 });
    expect(row.market?.lowestSell).toBe(28);
    expect(row.market?.activeSellers).toBe(4);

    row = applyStrategy(row, { id: "match-cheapest" }, null);
    expect(row.suggestion?.price).toBe(28);
    row = { ...row, selected: true };

    const { plan, overCap } = buildPlanFromRows([row], 1000);
    expect(overCap).toBe(false);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({
      mode: "update",
      orderId: "order-1",
      platinum: 28,
      quantity: 5,
      slug: "lex_prime_barrel",
    });
  });

  it("reads a bulk order at its per-item price on both sides of the book", () => {
    const items = [makeItem("Lex Prime Barrel")];
    const rows = buildQueueRows(
      items,
      EMPTY_CTX,
      lookupFor({ name: "Lex Prime Barrel", slug: "lex_prime_barrel" }),
    );
    const bulk = (platinum: number, perTrade: number, userName: string): PricingListing => ({
      platinum,
      unitPlatinum: Math.round((platinum / perTrade) * 100) / 100,
      quantity: perTrade * 4,
      status: "ingame",
      userName,
    });
    const row = attachMarketData(
      rows[0],
      [bulk(97, 6, "bulkSeller"), ...sellBook(20)],
      [bulk(97, 6, "bulkBuyer"), ...sellBook(20)],
      [],
    );

    expect(row.market?.lowestSell).toBe(16.17);
    expect(row.market?.highestBuy).toBe(20);
    expect(row.market?.spread).toBeCloseTo(-3.83, 2);
    expect(applyStrategy(row, { id: "match-cheapest" }, null).suggestion?.price).toBe(16);
  });

  it("keeps the suggestion in our own listing units when we sell in bulk", () => {
    const items = [makeItem("Lex Prime Barrel")];
    const rows = buildQueueRows(
      items,
      EMPTY_CTX,
      lookupFor({ name: "Lex Prime Barrel", slug: "lex_prime_barrel" }),
    );
    const order = makeOrder({ platinum: 100, perTrade: 6 });
    const row = attachMarketData(rows[0], sellBook(20, 21, 22), null, [order]);

    expect(row.existingOrder?.perTrade).toBe(6);
    expect(applyStrategy(row, { id: "match-cheapest" }, null).suggestion?.price).toBe(120);
  });

  it("manual price wins over suggestion, which wins over the existing listing", () => {
    const items = [makeItem("Lex Prime Barrel")];
    const rows = buildQueueRows(
      items,
      EMPTY_CTX,
      lookupFor({ name: "Lex Prime Barrel", slug: "lex_prime_barrel" }),
    );
    let row = attachMarketData(rows[0], sellBook(28, 28, 29), null, [makeOrder()]);
    expect(effectivePrice(row)).toBe(30);
    row = applyStrategy(row, { id: "match-cheapest" }, null);
    expect(effectivePrice(row)).toBe(28);
    row = { ...row, manualPrice: 33 };
    expect(effectivePrice(row)).toBe(33);
  });

  it("excludes unselected rows and unacknowledged overrides from the plan", () => {
    const items = [
      makeItem("Boltor", { inventoryGroup: "equipment", amount: 2 }),
      makeItem("Lex Prime Barrel"),
    ];
    const rows = buildQueueRows(
      items,
      EMPTY_CTX,
      lookupFor(
        { name: "Boltor", slug: "boltor" },
        { name: "Lex Prime Barrel", slug: "lex_prime_barrel" },
      ),
    );
    const overriding = {
      ...setRowQuantity(attachMarketData(rows[0], sellBook(10), null, []), 2),
      selected: true,
      manualPrice: 10,
    };
    const unselected = { ...attachMarketData(rows[1], sellBook(10), null, []), manualPrice: 10 };
    expect(buildPlanFromRows([overriding, unselected], 1).plan.rows).toHaveLength(0);

    const acked = acknowledgeRowOverride(overriding, 5);
    const { plan } = buildPlanFromRows([acked, unselected], 1);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].override).toEqual({
      acknowledgedAt: 5,
      reasonKeys: ["inventory.safety.reason.lastCopy"],
    });
  });

  it("flags a selection larger than the per-run cap without truncating", () => {
    const rows = pricedRows(WORKBENCH_MAX_ROWS_PER_RUN + 1);
    const { plan, overCap } = buildPlanFromRows(rows, 1);
    expect(overCap).toBe(true);
    expect(plan.rows).toHaveLength(WORKBENCH_MAX_ROWS_PER_RUN + 1);
    expect(planTotals(rows).rows).toBe(WORKBENCH_MAX_ROWS_PER_RUN + 1);
  });

  it("accepts a selection of exactly the per-run cap", () => {
    expect(WORKBENCH_MAX_ROWS_PER_RUN).toBe(100);
    const { plan, overCap } = buildPlanFromRows(pricedRows(WORKBENCH_MAX_ROWS_PER_RUN), 1);
    expect(overCap).toBe(false);
    expect(plan.rows).toHaveLength(WORKBENCH_MAX_ROWS_PER_RUN);
  });

  it("gives two plans built in the same millisecond distinct ids", () => {
    const built = buildQueueRows(
      [makeItem("Lex Prime Barrel")],
      EMPTY_CTX,
      lookupFor({ name: "Lex Prime Barrel", slug: "lex_prime_barrel" }),
    );
    const row = { ...built[0], selected: true, manualPrice: 5 };
    const first = buildPlanFromRows([row], 1000).plan;
    const second = buildPlanFromRows([row], 1000).plan;
    expect(first.planId).not.toBe(second.planId);
    expect(parseWorkbenchPlan(first)?.planId).toBe(first.planId);
    expect(parseWorkbenchPlan(second)?.planId).toBe(second.planId);
  });

  it("captures the safety snapshot from the live context, not the stale queue", () => {
    const items = [makeItem("Lex Prime Barrel")];
    const rows = buildQueueRows(
      items,
      EMPTY_CTX,
      lookupFor({ name: "Lex Prime Barrel", slug: "lex_prime_barrel" }),
    );
    expect(rows[0].verdict.safe).toBe(5);

    const lockedCtx = buildSafetyContext({
      itemDb: {},
      settings: {
        spareDefault: 0,
        spares: {},
        locks: [rows[0].item.internalName],
        setKeep: [],
      },
    });
    const snapshot = captureSafetySnapshot(rows, lockedCtx, 42);
    expect(snapshot.rows[rows[0].rowId]).toEqual({ safe: 0, total: 5 });
    expect(snapshot.capturedAt).toBe(42);
  });

  it("resolves slugs via the catalog gameRef before the display name", () => {
    const item = makeItem("Renamed Thing");
    const lookup: WfmItemsLookup = {
      [item.internalName.toLowerCase()]: {
        url_name: "real_slug",
        item_name: "Something Else (Key)",
        gameRef: item.internalName,
      },
    };
    expect(resolveQueueSlug(item, lookup)).toBe("real_slug");
    expect(resolveQueueSlug(makeItem("Absent"), lookup)).toBeNull();
  });

  it("refuses a catalog record whose gameRef names a different item", () => {
    const item = makeItem("Collision");
    const lookup: WfmItemsLookup = {
      [item.internalName.toLowerCase()]: {
        url_name: "other_slug",
        item_name: "Other Thing",
        gameRef: "/Lotus/Test/SomethingElse",
      },
      collision: { url_name: "collision", item_name: "Collision", gameRef: null },
    };
    expect(resolveQueueSlug(item, lookup)).toBe("collision");
  });

  it("derives relic subtype from the row name", () => {
    expect(relicSubtypeFor(makeItem("Lith A1 Radiant", { inventoryGroup: "relics" }))).toBe(
      "radiant",
    );
    expect(relicSubtypeFor(makeItem("Lith A1", { inventoryGroup: "relics" }))).toBe("intact");
    expect(relicSubtypeFor(makeItem("Lex Prime Barrel"))).toBeNull();
  });
});

describe("inventory selection join", () => {
  it("keys a row by its inventoryKey, falling back to the internal name", () => {
    expect(selectionKeyFor(makeItem("Serration", { inventoryKey: "serration#r5" }))).toBe(
      "serration#r5",
    );
    expect(selectionKeyFor(makeItem("Lex Prime Barrel"))).toBe("/Lotus/Test/LexPrimeBarrel");
    expect(selectionKeyFor(makeItem("Blank", { inventoryKey: "  " }))).toBe("/Lotus/Test/Blank");
  });

  it("reports only queue-eligible rows as selectable", () => {
    const sellable = makeItem("Lex Prime Barrel", { inventoryKey: "lex#0" });
    const unknown = makeItem("Unknown Thing");
    const empty = makeItem("Sold Out", { amount: 0 });
    const keys = eligibleSelectionKeys(
      [sellable, unknown, empty],
      EMPTY_CTX,
      lookupFor(
        { name: "Lex Prime Barrel", slug: "lex_prime_barrel" },
        { name: "Sold Out", slug: "sold_out" },
      ),
    );
    expect([...keys]).toEqual(["lex#0"]);
  });

  it("skips an inventory row whose name is not a string instead of throwing", () => {
    const broken = makeItem("Broken", { name: 117 as unknown as string, inventoryKey: "broken#0" });
    const sellable = makeItem("Lex Prime Barrel", { inventoryKey: "lex#0" });
    const lookup = lookupFor({ name: "Lex Prime Barrel", slug: "lex_prime_barrel" });

    expect([...eligibleSelectionKeys([broken, sellable], EMPTY_CTX, lookup)]).toEqual(["lex#0"]);
    expect(resolveQueueSlug(broken, lookup)).toBeNull();
  });

  it("builds the queue from the ticked keys only and pre-ticks every row", () => {
    const items = [
      makeItem("Lex Prime Barrel", { inventoryKey: "lex#0" }),
      makeItem("Boltor Prime Receiver", { inventoryKey: "boltor#0" }),
    ];
    const lookup = lookupFor(
      { name: "Lex Prime Barrel", slug: "lex_prime_barrel" },
      { name: "Boltor Prime Receiver", slug: "boltor_prime_receiver" },
    );
    const rows = buildSelectedQueueRows(items, EMPTY_CTX, lookup, new Set(["boltor#0"]));
    expect(rows.map((row) => row.slug)).toEqual(["boltor_prime_receiver"]);
    expect(rows[0].selected).toBe(true);
  });

  it("keeps every rank row of one selected item", () => {
    const items = [
      makeItem("Serration", { inventoryGroup: "mods", rank: 0, inventoryKey: "serration" }),
      makeItem("Serration", { inventoryGroup: "mods", rank: 10, inventoryKey: "serration" }),
    ];
    const rows = buildSelectedQueueRows(
      items,
      EMPTY_CTX,
      lookupFor({ name: "Serration", slug: "serration" }),
      new Set(["serration"]),
    );
    expect(rows.map((row) => row.rank)).toEqual([0, 10]);
  });

  it("ignores an empty selection", () => {
    const rows = buildSelectedQueueRows(
      [makeItem("Lex Prime Barrel")],
      EMPTY_CTX,
      lookupFor({ name: "Lex Prime Barrel", slug: "lex_prime_barrel" }),
      new Set(),
    );
    expect(rows).toEqual([]);
  });
});

describe("workbench queue merge across a reopen", () => {
  const LOOKUP = lookupFor(
    { name: "Lex Prime Barrel", slug: "lex_prime_barrel" },
    { name: "Boltor Prime Receiver", slug: "boltor_prime_receiver" },
  );

  function selectedRows(names: string[], selection: string[]): WorkbenchQueueRow[] {
    const items = names.map((name) => makeItem(name, { inventoryKey: name }));
    return buildSelectedQueueRows(items, EMPTY_CTX, LOOKUP, new Set(selection));
  }

  it("restores the fetched book, suggestion and manual price for an unchanged selection", () => {
    const before = selectedRows(["Lex Prime Barrel"], ["Lex Prime Barrel"]);
    let priced = attachMarketData(before[0], sellBook(30, 34, 40), null, []);
    priced = applyStrategy(priced, { id: "cheapest-minus-one" }, null);
    priced = { ...priced, manualPrice: 27 };
    priced = setRowQuantity(priced, 3);

    const rebuilt = selectedRows(["Lex Prime Barrel"], ["Lex Prime Barrel"]);
    const merged = mergeQueueRows([priced], rebuilt);
    expect(merged).toHaveLength(1);
    expect(merged[0].sellBook).toEqual(priced.sellBook);
    expect(merged[0].market?.lowestSell).toBe(30);
    expect(merged[0].suggestion?.price).toBe(29);
    expect(merged[0].manualPrice).toBe(27);
    expect(merged[0].quantity).toBe(3);
  });

  it("rebuilds only the changed rows and drops the deselected ones", () => {
    const before = selectedRows(
      ["Lex Prime Barrel", "Boltor Prime Receiver"],
      ["Lex Prime Barrel", "Boltor Prime Receiver"],
    );
    const cached = before.map((row) => attachMarketData(row, sellBook(20, 25), null, []));

    const rebuilt = selectedRows(
      ["Lex Prime Barrel", "Boltor Prime Receiver"],
      ["Boltor Prime Receiver"],
    );
    const merged = mergeQueueRows(cached, rebuilt);
    expect(merged.map((row) => row.slug)).toEqual(["boltor_prime_receiver"]);
    expect(merged[0].sellBook).not.toBeNull();
  });

  it("keeps a fresh row untouched when nothing was cached for it", () => {
    const rebuilt = selectedRows(["Lex Prime Barrel"], ["Lex Prime Barrel"]);
    const merged = mergeQueueRows([], rebuilt);
    expect(merged[0].sellBook).toBeNull();
    expect(merged[0].suggestion).toBeNull();
  });

  it("re-reads the existing order instead of carrying the cached one", () => {
    const before = selectedRows(["Lex Prime Barrel"], ["Lex Prime Barrel"]);
    const cached = attachMarketData(before[0], sellBook(30), null, [makeOrder({ platinum: 31 })]);
    expect(cached.existingOrder?.platinum).toBe(31);

    const rebuilt = selectedRows(["Lex Prime Barrel"], ["Lex Prime Barrel"]).map((row) =>
      attachMarketData(row, null, null, []),
    );
    expect(mergeQueueRows([cached], rebuilt)[0].existingOrder).toBeNull();
  });

  it("drops an acknowledgement the fresh verdict no longer covers", () => {
    const items = [makeItem("Boltor", { inventoryGroup: "equipment", amount: 2 })];
    const built = buildQueueRows(items, EMPTY_CTX, lookupFor({ name: "Boltor", slug: "boltor" }));
    const acknowledged = acknowledgeRowOverride(setRowQuantity(built[0], 2), 123);
    expect(acknowledged.overrideAcknowledged).toBe(true);

    const same = mergeQueueRows(
      [acknowledged],
      buildQueueRows(items, EMPTY_CTX, lookupFor({ name: "Boltor", slug: "boltor" })),
    );
    expect(same[0].quantity).toBe(2);
    expect(same[0].overrideAcknowledged).toBe(true);

    const fewer = buildQueueRows(
      [makeItem("Boltor", { inventoryGroup: "equipment", amount: 1 })],
      EMPTY_CTX,
      lookupFor({ name: "Boltor", slug: "boltor" }),
    );
    const narrowed = mergeQueueRows([acknowledged], fewer);
    expect(narrowed[0].quantity).toBe(1);
    expect(narrowed[0].overrideAcknowledged).toBe(false);
  });
});

describe("pricing gate and own-order join", () => {
  function priced(strategy: Parameters<typeof applyStrategy>[1]): WorkbenchQueueRow {
    const rows = buildQueueRows(
      [makeItem("Lex Prime Barrel")],
      EMPTY_CTX,
      lookupFor({ name: "Lex Prime Barrel", slug: "lex_prime_barrel" }),
    );
    const withBook = attachMarketData(rows[0], sellBook(40, 45, 50), null, []);
    return { ...applyStrategy(withBook, strategy, null), selected: true };
  }

  it("manual leaves every row unpriced instead of asking 1p for it", () => {
    const row = priced({ id: "manual" });
    expect(row.suggestion?.price).toBeNull();
    expect(effectivePrice(row)).toBeNull();
    expect(rowWarnings(row)).toContain("no-price");
    expect(unpricedSelectedRows([row])).toHaveLength(1);
    expect(buildPlanFromRows([row], 1000).plan.rows).toHaveLength(0);
  });

  it("target-margin with no cost entered leaves the row unpriced", () => {
    const row = priced({ id: "target-margin", costPlat: 0, marginPercent: 20 });
    expect(row.suggestion?.price).toBeNull();
    expect(unpricedSelectedRows([row])).toHaveLength(1);
    expect(planTotals([row]).rows).toBe(0);
  });

  it("a median strategy prices past a 1p seller and gates a row without a median", () => {
    const rows = buildQueueRows(
      [makeItem("Parallax Set")],
      EMPTY_CTX,
      lookupFor({ name: "Parallax Set", slug: "parallax_set" }),
    );
    const withBook = attachMarketData(rows[0], sellBook(1, 180, 190), null, []);
    const config = { id: "median-48h", offsetPlat: -1 } as const;
    const row = {
      ...applyStrategy(withBook, config, null, undefined, { median: 185, days: null }),
      selected: true,
    };
    expect(row.suggestion?.price).toBe(184);
    expect(buildPlanFromRows([row], 1000).plan.rows[0].platinum).toBe(184);

    const blind = { ...applyStrategy(withBook, config, null), selected: true };
    expect(blind.suggestion?.price).toBeNull();
    expect(unpricedSelectedRows([blind])).toHaveLength(1);
  });

  it("a typed manual price clears the gate", () => {
    const row = { ...priced({ id: "manual" }), manualPrice: 44 };
    expect(unpricedSelectedRows([row])).toHaveLength(0);
    expect(buildPlanFromRows([row], 1000).plan.rows[0].platinum).toBe(44);
  });

  it("re-arms the price gate for a strategy price whose order book went stale", () => {
    const row = priced({ id: "cheapest-minus-one" });
    expect(unpricedSelectedRows([row])).toHaveLength(0);

    const [stale] = dropStaleMarketData([row]);
    expect(unpricedSelectedRows([stale])).toHaveLength(1);
    expect(rowWarnings(stale)).toContain("no-listing-data");
    expect(unpricedSelectedRows([{ ...stale, manualPrice: 44 }])).toHaveLength(0);
  });

  it("ignores unselected and zero-quantity rows in the price gate", () => {
    const row = priced({ id: "manual" });
    expect(unpricedSelectedRows([{ ...row, selected: false }])).toHaveLength(0);
    expect(unpricedSelectedRows([setRowQuantity(row, 0)])).toHaveLength(0);
  });

  it("re-joins rows to a retried own-order fetch without losing market data", () => {
    const row = priced({ id: "match-cheapest" });
    expect(row.existingOrder).toBeNull();

    const [rejoined] = attachExistingOrders([row], [makeOrder()]);
    expect(rejoined.existingOrder).toEqual({
      id: "order-1",
      platinum: 30,
      quantity: 2,
      perTrade: 1,
    });
    expect(rejoined.sellBook).toBe(row.sellBook);
    expect(rejoined.market).toBe(row.market);
    expect(buildPlanFromRows([rejoined], 1000).plan.rows[0].mode).toBe("update");
  });

  it("records the pre-run own-order ids on the plan", () => {
    const row = priced({ id: "match-cheapest" });
    const { plan } = buildPlanFromRows([row], 1000, [makeOrder({ id: "pre-1" })]);
    expect(plan.knownOrderIds).toEqual(["pre-1"]);
    expect(buildPlanFromRows([row], 1000).plan.knownOrderIds).toBeUndefined();
  });
});

describe("relic subtype identity", () => {
  const RELIC_DB: Record<string, ItemDbEntry> = {};

  function relicRow(uniqueName: string): WorkbenchQueueRow {
    const item = makeItem("Axi A1 Relic", {
      internalName: uniqueName,
      inventoryGroup: "relics",
      amount: 3,
    });
    const rows = buildQueueRows(
      [item],
      buildSelectionSafetyContext({
        itemDb: RELIC_DB,
        settings: { spareDefault: 0, spares: {}, locks: [], setKeep: [] },
        mastery: null,
        pins: [],
      }),
      lookupFor({ name: "Axi A1 Relic", slug: "axi_a1_relic" }),
    );
    return rows[0];
  }

  it("reads the refinement off the uniqueName, not the refinement-free name", () => {
    expect(relicRow("/Lotus/Relics/AxiA1Radiant").subtype).toBe("radiant");
    expect(relicRow("/Lotus/Relics/AxiA1Intact").subtype).toBe("intact");
  });

  it("decodes DE colour suffixes through the relic database resolver", () => {
    const item = makeItem("Axi A1 Relic", {
      internalName: "/Lotus/Types/Game/Projections/T4VoidProjectionA1EPlatinum",
      inventoryGroup: "relics",
      amount: 1,
    });
    const resolve = (uniqueName: string): string | null =>
      uniqueName.endsWith("EPlatinum") ? "radiant" : null;
    const [row] = buildQueueRows(
      [item],
      EMPTY_CTX,
      lookupFor({ name: "Axi A1 Relic", slug: "axi_a1_relic" }),
      resolve,
    );
    expect(row.subtype).toBe("radiant");
    expect(relicSubtypeFor(item)).toBe("intact");
    const { plan } = buildPlanFromRows([{ ...row, selected: true, manualPrice: 5 }], 1, []);
    expect(plan.rows[0]?.subtype).toBe("radiant");
  });

  it("never repoints two refinements of one relic at the same sell order", () => {
    const orders = [
      makeOrder({
        id: "intact-order",
        itemName: "Axi A1 Relic",
        itemUrlName: "axi_a1_relic",
        subtype: "intact",
      }),
      makeOrder({
        id: "radiant-order",
        itemName: "Axi A1 Relic",
        itemUrlName: "axi_a1_relic",
        subtype: "radiant",
      }),
    ];
    const intact = attachMarketData(relicRow("/Lotus/Relics/AxiA1Intact"), null, null, orders);
    const radiant = attachMarketData(relicRow("/Lotus/Relics/AxiA1Radiant"), null, null, orders);
    expect(intact.existingOrder?.id).toBe("intact-order");
    expect(radiant.existingOrder?.id).toBe("radiant-order");
  });

  it("keeps a rank-matched non-relic row on the untyped order", () => {
    const rows = buildQueueRows(
      [makeItem("Serration", { inventoryGroup: "mods", rank: 0, amount: 2 })],
      EMPTY_CTX,
      lookupFor({ name: "Serration", slug: "serration" }),
    );
    const row = attachMarketData(rows[0], null, null, [
      makeOrder({ id: "mod-order", itemUrlName: "serration", modRank: 0, subtype: null }),
    ]);
    expect(row.existingOrder?.id).toBe("mod-order");
  });
});

describe("selection safety context inputs", () => {
  const FRAME = "/Lotus/Powersuits/Volt/VoltPrime";
  const CHASSIS = "/Lotus/Types/Recipes/WarframeRecipes/VoltPrimeChassisComponent";
  const DB: Record<string, ItemDbEntry> = {
    [FRAME]: {
      name: "Volt Prime",
      masterable: true,
      components: [{ name: "Chassis", uniqueName: CHASSIS, itemCount: 2 }],
    },
    [CHASSIS]: { name: "Chassis", isBuildComponent: true, componentOf: FRAME },
  };
  const SETTINGS = { spareDefault: 0, spares: {}, locks: [], setKeep: [] };

  it("supplies mastery and pins, so no rule is left degraded", () => {
    const context = buildSelectionSafetyContext({
      itemDb: DB,
      settings: SETTINGS,
      mastery: { items: [], stats: {} as never },
      pins: [],
    });
    expect(context.degradedRules).toEqual([]);
  });

  it("reserves the parts a pinned mastery goal still needs", () => {
    const context = buildSelectionSafetyContext({
      itemDb: DB,
      settings: SETTINGS,
      mastery: { items: [], stats: {} as never },
      pins: [FRAME],
    });
    const verdict = safeToList({ internalName: CHASSIS, uniqueName: CHASSIS, amount: 3 }, context);
    expect(verdict).toMatchObject({ total: 3, reserved: 2, safe: 1 });
  });

  it("degrades the recipe rule rather than reserving everything without mastery data", () => {
    const context = buildSelectionSafetyContext({
      itemDb: DB,
      settings: SETTINGS,
      mastery: null,
      pins: [],
    });
    expect(context.degradedRules).toContain("unmasteredRecipe");
    expect(safeToList({ internalName: CHASSIS, amount: 3 }, context).reserved).toBe(0);
  });

  it("reads ownership off currentlyOwned, never off the mastery status", () => {
    const AKFRAME = "/Lotus/Powersuits/Volt/VoltPrimeTwin";
    const db: Record<string, ItemDbEntry> = {
      ...DB,
      [AKFRAME]: {
        name: "Volt Prime Twin",
        masterable: true,
        components: [{ name: "Volt Prime", uniqueName: FRAME, itemCount: 1 }],
      },
    };
    const contextFor = (currentlyOwned: boolean) =>
      buildSelectionSafetyContext({
        itemDb: db,
        settings: SETTINGS,
        mastery: {
          items: [
            makeItem("Volt Prime", { internalName: FRAME, status: "mastered", currentlyOwned }),
          ],
          stats: {} as never,
        },
        pins: [],
      });
    expect(safeToList({ internalName: CHASSIS, amount: 4 }, contextFor(false)).reserved).toBe(2);
    expect(safeToList({ internalName: CHASSIS, amount: 4 }, contextFor(true)).reserved).toBe(0);
  });

  it("drops the unmastered-recipe reservation once the goal is mastered", () => {
    const unmastered = buildSelectionSafetyContext({
      itemDb: DB,
      settings: SETTINGS,
      mastery: { items: [], stats: {} as never },
      pins: [],
    });
    expect(safeToList({ internalName: CHASSIS, amount: 3 }, unmastered).reserved).toBe(2);

    const mastered = buildSelectionSafetyContext({
      itemDb: DB,
      settings: SETTINGS,
      mastery: {
        items: [makeItem("Volt Prime", { internalName: FRAME, status: "mastered" })],
        stats: {} as never,
      },
      pins: [],
    });
    expect(safeToList({ internalName: CHASSIS, amount: 3 }, mastered).reserved).toBe(0);
  });
});

describe("workbench queue filtering", () => {
  function queueRow(name: string, overrides: Partial<WorkbenchQueueRow> = {}): WorkbenchQueueRow {
    const slug = name.toLowerCase().replace(/\s+/g, "_");
    const [row] = buildQueueRows([makeItem(name)], EMPTY_CTX, lookupFor({ name, slug }));
    return { ...row, ...overrides };
  }

  function priced(name: string, platinum: number): WorkbenchQueueRow {
    return attachMarketData(queueRow(name), sellBook(platinum), null, []);
  }

  const names = (rows: readonly WorkbenchQueueRow[]): string[] => rows.map((row) => row.itemName);

  it("matches the name filter case-insensitively and ignores surrounding space", () => {
    const rows = [priced("Lex Prime Barrel", 30), priced("Boltor Prime Receiver", 40)];
    expect(names(filterQueueRows(rows, { text: "  lex prime " }))).toEqual(["Lex Prime Barrel"]);
    expect(names(filterQueueRows(rows, { text: "PRIME" }))).toHaveLength(2);
    expect(filterQueueRows(rows, { text: "" })).toHaveLength(2);
    expect(filterQueueRows(rows)).toHaveLength(2);
  });

  it("applies each plat bound on its own and both together, inclusively", () => {
    const rows = [priced("Cheap Part", 10), priced("Mid Part", 30), priced("Dear Part", 90)];
    expect(names(filterQueueRows(rows, { plat: { min: 30, max: null } }))).toEqual([
      "Mid Part",
      "Dear Part",
    ]);
    expect(names(filterQueueRows(rows, { plat: { min: null, max: 30 } }))).toEqual([
      "Cheap Part",
      "Mid Part",
    ]);
    expect(names(filterQueueRows(rows, { plat: { min: 20, max: 40 } }))).toEqual(["Mid Part"]);
    expect(filterQueueRows(rows, { plat: NO_PLAT_RANGE })).toHaveLength(3);
  });

  it("judges a row on its effective price before the cheapest listing", () => {
    const row = { ...priced("Lex Prime Barrel", 20), manualPrice: 60 };
    expect(filterQueueRows([row], { plat: { min: 50, max: null } })).toHaveLength(1);
    expect(filterQueueRows([row], { plat: { min: null, max: 30 } })).toHaveLength(0);
  });

  it("drops a row with no price only once a bound is set, and counts it", () => {
    const rows = [queueRow("Blank Part"), priced("Cheap Part", 20)];
    expect(names(filterQueueRows(rows, { plat: NO_PLAT_RANGE }))).toEqual([
      "Blank Part",
      "Cheap Part",
    ]);
    expect(names(filterQueueRows(rows, { plat: { min: 1, max: null } }))).toEqual(["Cheap Part"]);
    expect(names(filterQueueRows(rows, { plat: { min: null, max: 999 } }))).toEqual(["Cheap Part"]);

    expect(unpricedHiddenCount(rows, { plat: { min: 1, max: null } })).toBe(1);
    expect(unpricedHiddenCount(rows, { plat: NO_PLAT_RANGE })).toBe(0);
    expect(unpricedHiddenCount(rows, { text: "cheap", plat: { min: 1, max: null } })).toBe(0);
  });

  it("splits rows by whether they are already listed", () => {
    const listed = attachMarketData(queueRow("Lex Prime Barrel"), null, null, [makeOrder()]);
    const rows = [listed, queueRow("Boltor Prime Receiver")];
    expect(names(filterQueueRows(rows, { listed: "listed" }))).toEqual(["Lex Prime Barrel"]);
    expect(names(filterQueueRows(rows, { listed: "unlisted" }))).toEqual(["Boltor Prime Receiver"]);
    expect(filterQueueRows(rows, { listed: "all" })).toHaveLength(2);
  });

  it("combines the filters and leaves the selection alone", () => {
    const rows = [
      { ...priced("Lex Prime Barrel", 30), selected: true },
      { ...priced("Lex Prime Receiver", 90), selected: false },
      { ...priced("Boltor Prime Barrel", 30), selected: true },
    ];
    const filtered = filterQueueRows(rows, {
      text: "lex",
      plat: { min: null, max: 50 },
      listed: "unlisted",
    });
    expect(names(filtered)).toEqual(["Lex Prime Barrel"]);
    expect(rows.map((row) => row.selected)).toEqual([true, false, true]);
  });
});

describe("workbench market loading", () => {
  it("targets every selected row that has no order book, with no slice", () => {
    const rows = pricedRows(134);
    const targets = rowsNeedingMarketData([
      { ...rows[0], sellBook: sellBook(10) },
      { ...rows[1], selected: false },
      ...rows.slice(2),
    ]);
    expect(targets).toHaveLength(132);
    expect(targets.map((row) => row.rowId)).not.toContain("r0");
    expect(targets.map((row) => row.rowId)).not.toContain("r1");
  });

  it("works through every target and paces the requests it sends", async () => {
    const targets = pricedRows(134);
    let clock = 0;
    const waits: number[] = [];
    const fetched: string[] = [];
    const summary = await loadQueueMarketData(targets, {
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      fetchBook: async (row) => {
        fetched.push(row.rowId);
        clock += 50;
        return { sell: sellBook(10), buy: null };
      },
      onRow: () => {},
    });
    expect(fetched).toHaveLength(134);
    expect(summary).toEqual({ loaded: 134, failedRowIds: [], cancelled: false });
    // 400ms between request starts, less the 50ms each fetch already took.
    expect(waits).toEqual(Array.from({ length: 133 }, () => 350));
  });

  it("adds no gap when the request itself outlasted the interval", async () => {
    let clock = 0;
    const waits: number[] = [];
    await loadQueueMarketData(pricedRows(3), {
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      fetchBook: async () => {
        clock += 900;
        return { sell: sellBook(10), buy: null };
      },
      onRow: () => {},
    });
    expect(waits).toEqual([]);
  });

  it("stops between rows once cancelled", async () => {
    let cancelled = false;
    const fetched: string[] = [];
    const summary = await loadQueueMarketData(pricedRows(10), {
      minIntervalMs: 0,
      isCancelled: () => cancelled,
      fetchBook: async (row) => {
        fetched.push(row.rowId);
        if (fetched.length === 3) cancelled = true;
        return { sell: sellBook(10), buy: null };
      },
      onRow: () => {},
    });
    expect(fetched).toEqual(["r0", "r1", "r2"]);
    expect(summary.cancelled).toBe(true);
    expect(summary.loaded).toBe(3);
  });

  it("records rows whose fetch returned no book and still advances progress", async () => {
    const progress: string[] = [];
    const summary = await loadQueueMarketData(pricedRows(4), {
      minIntervalMs: 0,
      fetchBook: async (row) =>
        row.rowId === "r1" || row.rowId === "r3" ? null : { sell: sellBook(10), buy: null },
      onRow: (row) => progress.push(row.rowId),
    });
    expect(progress).toEqual(["r0", "r1", "r2", "r3"]);
    expect(summary.failedRowIds).toEqual(["r1", "r3"]);
    expect(summary.loaded).toBe(2);
  });
});
