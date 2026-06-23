import { describe, expect, it } from "vitest";

import { _parseTradeDialog } from "../../services/eeLogMonitor";

// Warframe logs each trade item on its own line; stacked items as "Name x N".
function saleBuffer(offerLines: string[]): string[] {
  return [
    "Are you sure you want to accept this trade?",
    "You are offering:",
    ...offerLines,
    "and will receive from BuyerName the following:",
    "Platinum x 45, leftItem=/Menu/Confirm_Item_Ok",
  ];
}

describe("_parseTradeDialog quantity handling", () => {
  it("parses a stacked item 'Name x N' as count N", () => {
    const parsed = _parseTradeDialog(saleBuffer(["Arcane Pistoleer x 3"]));
    expect(parsed?.type).toBe("sale");
    expect(parsed?.partner).toBe("BuyerName");
    expect(parsed?.platChange).toBe(45);
    const item = parsed?.items.find((i) => i.displayName === "Arcane Pistoleer");
    expect(item?.count).toBe(3);
    expect(item?.direction).toBe("given");
  });

  it("counts non-stacking duplicate lines", () => {
    const parsed = _parseTradeDialog(
      saleBuffer(["Arcane Pistoleer", "Arcane Pistoleer", "Arcane Pistoleer"]),
    );
    expect(parsed?.items.find((i) => i.displayName === "Arcane Pistoleer")?.count).toBe(3);
  });

  it("handles mixed stacked + duplicate lines for the same item", () => {
    const parsed = _parseTradeDialog(saleBuffer(["Vitus Essence x 2", "Vitus Essence"]));
    expect(parsed?.items.find((i) => i.displayName === "Vitus Essence")?.count).toBe(3);
  });

  it("treats received platinum as plat, not an item", () => {
    const parsed = _parseTradeDialog(saleBuffer(["Arcane Pistoleer x 3"]));
    expect(parsed?.items.some((i) => /platinum/i.test(i.displayName))).toBe(false);
  });
});
