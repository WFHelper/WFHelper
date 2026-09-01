import { describe, expect, it } from "vitest";

import {
  tradeItemKind,
  tradeItemLabel,
  type TradeItemKind,
} from "../../../../src/lib/stats/tradeAnalytics.js";
import type { TradeItem } from "../../../../src/types/ipc.js";

function item(displayName: string, internalName = ""): TradeItem {
  return { internalName, displayName, count: 1, direction: "given" };
}

describe("tradeItemLabel", () => {
  it("splits a three-stat riven into weapon and roll name", () => {
    expect(tradeItemLabel(item("Sobek Visi-toxican"))).toEqual({
      primary: "Sobek Riven",
      secondary: "Visi-toxican",
    });
    expect(tradeItemLabel(item("Boar Acri-saticron"))).toEqual({
      primary: "Boar Riven",
      secondary: "Acri-saticron",
    });
  });

  it("recognises the hyphen-less roll a one or two stat riven gets", () => {
    expect(tradeItemLabel(item("Sobek Critacan"))).toEqual({
      primary: "Sobek Riven",
      secondary: "Critacan",
    });
  });

  it("keeps a multi-word weapon on the weapon side", () => {
    expect(tradeItemLabel(item("Kuva Bramma Croni-tempitis"))).toEqual({
      primary: "Kuva Bramma Riven",
      secondary: "Croni-tempitis",
    });
  });

  it("trusts the dialog's rank tag even when the roll name is unknown", () => {
    expect(tradeItemLabel(item("Rubico Visio-Critatis (RIVEN RANK 8)"))).toEqual({
      primary: "Rubico Riven",
      secondary: "Visio-Critatis",
    });
  });

  it("leaves a veiled riven under its own listing name", () => {
    expect(tradeItemLabel(item("Rifle Riven Mod"))).toEqual({
      primary: "Rifle Riven Mod",
      secondary: null,
    });
  });

  it("turns a raw import id into a readable name", () => {
    expect(tradeItemLabel(item("/AF_Special/Imprint/Bibou"))).toEqual({
      primary: "Bibou",
      secondary: null,
    });
  });

  it("falls back to the uniqueName when there is no display name", () => {
    expect(tradeItemLabel(item("", "/Lotus/Types/Items/MiscItems/Tellurium")).primary).toBe(
      "Tellurium",
    );
    expect(tradeItemLabel(item(""))).toEqual({ primary: "", secondary: null });
  });

  it("leaves an ordinary item alone", () => {
    expect(tradeItemLabel(item("Ash Prime Chassis"))).toEqual({
      primary: "Ash Prime Chassis",
      secondary: null,
    });
  });

  it("does not read a plain weapon name as a riven", () => {
    for (const name of ["Sobek", "Serration", "Kuva Bramma", "Nikana Prime", "Ceramic Dagger"]) {
      expect(tradeItemLabel(item(name)).secondary).toBeNull();
    }
  });
});

describe("tradeItemKind", () => {
  const cases: Array<[string, TradeItemKind]> = [
    ["Sobek Visi-toxican", "riven"],
    ["Rifle Riven Mod", "riven"],
    ["Ash Prime Set", "set"],
    ["Ash Prime Chassis", "prime"],
    ["Ash Prime", "prime"],
    ["Ash Prime Blueprint", "prime"],
    ["Lith G1 Relic", "relic"],
    ["Axi A2", "relic"],
    ["Arcane Energize", "arcane"],
    ["Arcane Energize (RANK 5)", "arcane"],
    ["Primed Flow (RANK 10)", "mod"],
    ["Sobek", "other"],
  ];

  it.each(cases)("classifies %s as %s", (name, kind) => {
    expect(tradeItemKind(item(name))).toBe(kind);
  });

  it("uses the item database only when the name says nothing", () => {
    const byDb = (row: TradeItem): string => (row.displayName === "Serration" ? "Mods" : "Misc");
    expect(tradeItemKind(item("Serration"), byDb)).toBe("mod");
    expect(tradeItemKind(item("Nano Spores"), byDb)).toBe("resource");
    // A whole weapon has a category, but it is not a kind of goods.
    expect(tradeItemKind(item("Sobek"), () => "Melee")).toBe("other");
    // The name rule wins: a prime part never becomes a resource.
    expect(tradeItemKind(item("Ash Prime Chassis"), () => "Misc")).toBe("prime");
  });
});
