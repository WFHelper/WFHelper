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
  mergeQueueRows,
  effectivePrice,
  eligibleSelectionKeys,
  planTotals,
  relicSubtypeFor,
  resolveQueueSlug,
  rowNeedsOverride,
  rowSafetyKey,
  rowWarnings,
  selectionKeyFor,
  setRowQuantity,
  unpricedSelectedRows,
  type WorkbenchQueueRow,
} from "../../../../src/lib/tradeWorkbench/queueModel.js";
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
    // Equipment at rank 0 keeps a last copy: total 2, safe 1.
    const items = [makeItem("Boltor", { inventoryGroup: "equipment", amount: 2 })];
    const rows = buildQueueRows(items, EMPTY_CTX, lookupFor({ name: "Boltor", slug: "boltor" }));
    expect(rows[0].verdict).toMatchObject({ total: 2, reserved: 1, safe: 1 });
    expect(rows[0].quantity).toBe(1);
    // Per-item safety settings key off the DE path, not the display name.
    expect(rowSafetyKey(rows[0])).toBe(rows[0].item.internalName);
    expect(bindingReasonKeys(rows[0].verdict)).toEqual(["inventory.safety.reason.lastCopy"]);

    let row = setRowQuantity(rows[0], 2);
    expect(rowNeedsOverride(row)).toBe(true);
    expect(rowWarnings(row)).toContain("override-needed");

    row = acknowledgeRowOverride(row, 123);
    expect(row.overrideAcknowledged).toBe(true);
    expect(row.overrideAcknowledgedAt).toBe(123);

    // Quantity never exceeds what the account holds.
    expect(setRowQuantity(row, 99).quantity).toBe(2);

    // What the modal does when the safety settings change under a built queue:
    // re-running the row's own quantity against a smaller verdict clamps it, so
    // the caller needs no clamp of its own.
    const sold = setRowQuantity(
      { ...row, verdict: { ...row.verdict, total: 1, safe: 1, reserved: 0 } },
      row.quantity,
    );
    expect(sold.quantity).toBe(1);
    expect(sold.overrideAcknowledged).toBe(false);
  });

  it("raising the quantity past a prior acknowledgement re-requires consent", () => {
    // Spare default 2 on 5 copies: safe 3, so 4 and 5 are both override land.
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
    // Dropping back inside the safe count clears the override entirely.
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
    // Three listings undercut our 30p listing, so damping lets the drop pass.
    let row = attachMarketData(rows[0], sellBook(28, 28, 29, 31), null, [makeOrder()]);
    expect(row.existingOrder).toEqual({ id: "order-1", platinum: 30, quantity: 2 });
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
    const rows: WorkbenchQueueRow[] = [];
    for (let i = 0; i < 21; i++) {
      const built = buildQueueRows(
        [makeItem(`Item ${i}`)],
        EMPTY_CTX,
        lookupFor({ name: `Item ${i}`, slug: `item_${i}` }),
      );
      rows.push({ ...built[0], rowId: `r${i}`, selected: true, manualPrice: 5 });
    }
    const { plan, overCap } = buildPlanFromRows(rows, 1);
    expect(overCap).toBe(true);
    expect(plan.rows).toHaveLength(21);
    expect(planTotals(rows).rows).toBe(21);
  });

  it("captures the safety snapshot from the live context, not the stale queue", () => {
    const items = [makeItem("Lex Prime Barrel")];
    const rows = buildQueueRows(
      items,
      EMPTY_CTX,
      lookupFor({ name: "Lex Prime Barrel", slug: "lex_prime_barrel" }),
    );
    expect(rows[0].verdict.safe).toBe(5);

    // The user locks the item after the queue was built.
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
    // Seen live (9bdc324f): one leaked non-string name crashed every market
    // join. This runs from the reactive statement that owns selection mode, so
    // one bad row would take the whole queue with it.
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

    // Same amount survives a rebuild; the acknowledgement still covers it.
    const same = mergeQueueRows(
      [acknowledged],
      buildQueueRows(items, EMPTY_CTX, lookupFor({ name: "Boltor", slug: "boltor" })),
    );
    expect(same[0].quantity).toBe(2);
    expect(same[0].overrideAcknowledged).toBe(true);

    // A shrunken account cannot keep the consent given for two copies.
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

  it("a typed manual price clears the gate", () => {
    const row = { ...priced({ id: "manual" }), manualPrice: 44 };
    expect(unpricedSelectedRows([row])).toHaveLength(0);
    expect(buildPlanFromRows([row], 1000).plan.rows[0].platinum).toBe(44);
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
    expect(rejoined.existingOrder).toEqual({ id: "order-1", platinum: 30, quantity: 2 });
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
