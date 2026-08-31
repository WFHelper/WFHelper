import { describe, expect, it } from "vitest";

import { buildSafetyContext } from "../../../../src/lib/inventory/safetyRules.js";
import {
  acknowledgeRowOverride,
  applyStrategy,
  attachMarketData,
  bindingReasonKeys,
  buildPlanFromRows,
  buildQueueRows,
  captureSafetySnapshot,
  effectivePrice,
  planTotals,
  relicSubtypeFor,
  resolveQueueSlug,
  rowNeedsOverride,
  rowSafetyKey,
  rowWarnings,
  setRowQuantity,
  type WorkbenchQueueRow,
} from "../../../../src/lib/tradeWorkbench/queueModel.js";
import type { PricingListing } from "../../../../src/lib/tradeWorkbench/pricingStrategies.js";
import type { ParsedItem } from "../../../../src/types/inventory.js";
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
