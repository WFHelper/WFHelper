import { describe, expect, it } from "vitest";

import {
  formatTradeItems,
  resolveRepOffer,
  summarizeMatches,
  summarizeTrade,
} from "../../config/shared/tradeMatch";
import { tradeNotificationBody } from "../../config/shared/notifications";
import type { TradeMatchPayload } from "../../config/shared/tradeMatch";
import type { TradeEvent } from "../../config/shared/statsTypes";

function trade(overrides: Partial<TradeEvent> = {}): TradeEvent {
  return {
    id: "trade-1",
    date: "2026-07-30T10:00:00.000Z",
    type: "sale",
    platChange: 45,
    partner: "Buyer",
    items: [
      {
        internalName: "",
        displayName: "Ash Prime Chassis",
        count: 1,
        direction: "given",
        wfmSlug: "ash_prime_chassis",
        wfmThumb: "/items/ash.png",
      },
      { internalName: "", displayName: "Platinum", count: 45, direction: "received" },
    ],
    ...overrides,
  };
}

function match(itemName: string, platinum: number): TradeMatchPayload {
  return {
    kind: "order",
    orderId: itemName,
    itemName,
    itemUrlName: null,
    itemThumb: null,
    quantity: 1,
    platinum,
    partner: "Buyer",
    type: "sale",
  };
}

describe("summarizeMatches", () => {
  it("retains the match identity while describing the actual trade", () => {
    expect(summarizeMatches([match("Boar Prime Stock", 30)], trade())).toMatchObject({
      orderId: "Boar Prime Stock",
      itemName: "Ash Prime Chassis",
      platinum: 45,
    });
  });

  it("includes unmatched items instead of listing order names", () => {
    const summary = summarizeMatches(
      [match("Braton Prime Set", 80)],
      trade({
        platChange: 80,
        items: [
          { internalName: "", displayName: "Braton Prime Barrel", count: 1, direction: "given" },
          { internalName: "", displayName: "Braton Prime Stock", count: 2, direction: "given" },
          { internalName: "", displayName: "Unmatched", count: 1, direction: "given" },
        ],
      }),
    );

    expect(summary?.itemName).toBe("2 x Braton Prime Stock, Braton Prime Barrel, and Unmatched");
    expect(summary?.quantity).toBe(1);
    expect(summary?.orderId).toBe("Braton Prime Set");
    expect(summary?.platinum).toBe(80);
  });

  it("returns null when nothing closed", () => {
    expect(summarizeMatches([], trade())).toBeNull();
  });
});

describe("resolveRepOffer", () => {
  const enabled = { enabled: true, hotkey: "F9" };

  it("offers rep for a closed WFM sale", () => {
    expect(resolveRepOffer(match("Ash Prime Chassis", 45), "closed", enabled)).toEqual({
      partner: "Buyer",
      hotkey: "F9",
    });
  });

  it("still offers rep when the matched listing failed to close", () => {
    expect(resolveRepOffer(match("Ash Prime Chassis", 45), "close-failed", enabled)).not.toBeNull();
  });

  it("offers rep for a closed riven contract sale", () => {
    const contract = { ...match("Karak Visican", 200), kind: "contract" as const };
    expect(resolveRepOffer(contract, "closed", enabled)?.partner).toBe("Buyer");
  });

  it("offers rep for a purchase that closed a buy order", () => {
    const purchase = { ...match("Serration", 20), type: "purchase" as const };
    expect(resolveRepOffer(purchase, "closed", enabled)).toEqual({
      partner: "Buyer",
      hotkey: "F9",
    });
    expect(resolveRepOffer(purchase, "close-failed", enabled)).not.toBeNull();
  });

  // Buying on warframe.market closes no listing of ours, so this case has no order id.
  it("offers rep for a purchase that matched no order once the orders were checked", () => {
    const purchase = { ...match("Serration", 20), type: "purchase" as const, orderId: "" };
    expect(resolveRepOffer(purchase, "no-match", enabled)).toEqual({
      partner: "Buyer",
      hotkey: "F9",
    });
  });

  it("refuses an unmatched purchase that warframe.market never saw", () => {
    const purchase = { ...match("Serration", 20), type: "purchase" as const, orderId: "" };
    // "detected" is auto-close off or signed out: no orders were ever consulted.
    expect(resolveRepOffer(purchase, "detected", enabled)).toBeNull();
    // "match-failed" is the lookup throwing, so nothing was compared either.
    expect(resolveRepOffer(purchase, "match-failed", enabled)).toBeNull();
    expect(resolveRepOffer({ ...purchase, platinum: 0 }, "no-match", enabled)).toBeNull();
    const barter = { ...purchase, type: "trade" as const };
    expect(resolveRepOffer(barter, "no-match", enabled)).toBeNull();
  });

  it("never offers rep for sales that matched no WFM listing", () => {
    const unmatched = { ...match("Ash Prime Chassis", 45), orderId: "" };
    expect(resolveRepOffer(unmatched, "no-match", enabled)).toBeNull();
    expect(resolveRepOffer(unmatched, "detected", enabled)).toBeNull();
    expect(resolveRepOffer(match("Ash Prime Chassis", 45), "no-match", enabled)).toBeNull();
    expect(resolveRepOffer(match("Ash Prime Chassis", 45), "detected", enabled)).toBeNull();
  });

  it("respects the setting toggle, missing hotkey, and missing partner", () => {
    expect(resolveRepOffer(match("X", 1), "closed", { enabled: false, hotkey: "F9" })).toBeNull();
    expect(resolveRepOffer(match("X", 1), "closed", { enabled: true, hotkey: "  " })).toBeNull();
    const anonymous = { ...match("X", 1), partner: "" };
    expect(resolveRepOffer(anonymous, "closed", enabled)).toBeNull();
  });
});

describe("summarizeTrade", () => {
  it("describes a sale by what was given away", () => {
    expect(summarizeTrade(trade())).toEqual({
      kind: "order",
      orderId: "",
      itemName: "Ash Prime Chassis",
      itemUrlName: "ash_prime_chassis",
      itemThumb: "/items/ash.png",
      quantity: 1,
      platinum: 45,
      partner: "Buyer",
      type: "sale",
    });
  });

  it("lists all items in their original order when quantities are equal", () => {
    const summary = summarizeTrade(
      trade({
        items: [
          { internalName: "", displayName: "Braton Prime Barrel", count: 1, direction: "given" },
          { internalName: "", displayName: "Braton Prime Stock", count: 1, direction: "given" },
          { internalName: "", displayName: "Braton Prime Blueprint", count: 1, direction: "given" },
        ],
      }),
    );

    expect(summary.itemName).toBe(
      "Braton Prime Barrel, Braton Prime Stock, and Braton Prime Blueprint",
    );
  });

  it("groups repeated names and stacks, sorted by total quantity", () => {
    const items = [
      { internalName: "", displayName: "Shield", count: 1, direction: "given" as const },
      { internalName: "", displayName: "Fish", count: 2, direction: "given" as const },
      { internalName: "", displayName: "Sword", count: 2, direction: "given" as const },
      { internalName: "", displayName: "fish", count: 1, direction: "received" as const },
      { internalName: "", displayName: "Platinum", count: 45, direction: "received" as const },
    ];
    const summary = summarizeTrade(trade({ items }));
    expect(summary.itemName).toBe("3 x Fish, 2 x Sword, and Shield");
    expect(summary.quantity).toBe(1);
    expect(formatTradeItems(items)).toBe(summary.itemName);
    expect(tradeNotificationBody(summary)).toBe("3 x Fish, 2 x Sword, and Shield 45p with Buyer");
  });

  it("groups a single repeated item without applying the quantity twice", () => {
    const items = [
      { internalName: "", displayName: "Fish", count: 2, direction: "given" as const },
      { internalName: "", displayName: "Fish", count: 1, direction: "given" as const },
    ];
    const summary = summarizeTrade(trade({ items }));
    expect(summary).toMatchObject({ itemName: "Fish", quantity: 3 });
    expect(tradeNotificationBody(summary)).toBe("3 x Fish 45p with Buyer");
    expect(formatTradeItems(items)).toBe("3 x Fish");
  });

  it("describes a purchase by what was received", () => {
    const summary = summarizeTrade(
      trade({
        type: "purchase",
        items: [
          { internalName: "", displayName: "Platinum", count: 20, direction: "given" },
          { internalName: "", displayName: "Serration", count: 1, direction: "received" },
        ],
      }),
    );

    expect(summary.itemName).toBe("Serration");
    expect(summary.type).toBe("purchase");
  });

  it("includes non-platinum items from both sides of a sale", () => {
    const summary = summarizeTrade(
      trade({
        items: [
          { internalName: "", displayName: "Fish", count: 1, direction: "given" },
          { internalName: "", displayName: "Shield", count: 2, direction: "received" },
          { internalName: "", displayName: "Platinum", count: 45, direction: "received" },
        ],
      }),
    );

    expect(summary.itemName).toBe("2 x Shield and Fish");
    expect(summary.quantity).toBe(1);
  });

  it("describes both sides of a barter without treating it as a purchase", () => {
    const summary = summarizeTrade(
      trade({
        type: "trade",
        platChange: 0,
        items: [
          { internalName: "", displayName: "Serration", count: 1, direction: "given" },
          { internalName: "", displayName: "Split Chamber", count: 1, direction: "received" },
        ],
      }),
    );

    expect(summary.itemName).toBe("Serration and Split Chamber");
    expect(summary.platinum).toBe(0);
    expect(summary.type).toBe("trade");
  });

  it("still renders when nothing matched the traded side", () => {
    const summary = summarizeTrade(trade({ items: [], partner: undefined }));

    expect(summary.itemName).toBe("Trade");
    expect(summary.partner).toBe("");
  });
});
