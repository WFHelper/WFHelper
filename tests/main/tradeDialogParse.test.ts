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

// Repro lines from a corrupted v1.1.3 trade log (Stats view screenshot).
describe("_parseTradeDialog corruption hardening", () => {
  it("strips a trailing platform glyph (U+E000) from the partner name", () => {
    const parsed = _parseTradeDialog([
      "Are you sure you want to accept this trade?",
      "You are offering:",
      "Arcane Pistoleer",
      "and will receive from Ainikki\uE000 the following:",
      "Platinum x 45, leftItem=/Menu/Confirm_Item_Ok",
    ]);
    expect(parsed?.partner).toBe("Ainikki");
  });

  it("strips the DBWIN latin1-mojibake form of a platform glyph from the partner", () => {
    const parsed = _parseTradeDialog([
      "Are you sure you want to accept this trade?",
      "You are offering:",
      "Arcane Pistoleer",
      "and will receive from Ainikki\u00EE\u0080\u0080 the following:",
      "Platinum x 45, leftItem=/Menu/Confirm_Item_Ok",
    ]);
    expect(parsed?.partner).toBe("Ainikki");
  });

  it("drops glyph-only lines instead of recording them as items", () => {
    const parsed = _parseTradeDialog(
      saleBuffer(["Zid-an Asheir", "\uE000\uE001\uE002\uE003", "\uE000\uE000"]),
    );
    expect(parsed?.items.map((i) => i.displayName)).toEqual(["Zid-an Asheir"]);
  });

  it("strips platform glyphs embedded in an item name", () => {
    const parsed = _parseTradeDialog(saleBuffer(["Zid-an Asheir\uE000\uE001"]));
    expect(parsed?.items.map((i) => i.displayName)).toEqual(["Zid-an Asheir"]);
  });

  it("does not capture Dialog key=value tails into the item name", () => {
    const parsed = _parseTradeDialog(
      saleBuffer(["Zid-an Asheir, title= leftItem=/Menu/Confirm_Item_Ok"]),
    );
    expect(parsed?.items.map((i) => i.displayName)).toEqual(["Zid-an Asheir"]);
  });

  it("rejects raw EE.log framework lines leaked into the buffer", () => {
    const parsed = _parseTradeDialog(
      saleBuffer([
        "Zid-an Asheir",
        "11828.904 Script [Info]: Dialog.lua: Dialog::",
        "11829.001 Sys [Info]: whatever",
      ]),
    );
    expect(parsed?.items.map((i) => i.displayName)).toEqual(["Zid-an Asheir"]);
  });

  it("stops item parsing at a bare title= arg line", () => {
    const parsed = _parseTradeDialog(
      saleBuffer(["Zid-an Asheir", "title=", "leftItem=/Menu/Confirm_Item_Ok"]),
    );
    expect(parsed?.items.map((i) => i.displayName)).toEqual(["Zid-an Asheir"]);
  });
});
