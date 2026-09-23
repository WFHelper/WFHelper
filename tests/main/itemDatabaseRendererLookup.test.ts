import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setGameLocale } from "../../services/gameLocale";
import * as itemDb from "../../services/itemDatabase";

const SERRATION = "/Lotus/Upgrades/Mods/Rifle/WeaponDamageAmountMod";

beforeAll(() => {
  setGameLocale("en");
  itemDb.buildDatabase();
});

afterAll(() => {
  setGameLocale("en");
});

describe("renderer item lookup", () => {
  it("hands every window the same projection until something changes", () => {
    expect(itemDb.getRendererLookup()).toBe(itemDb.getRendererLookup());
  });

  it("is rebuilt for a game language change and again on the way back", () => {
    const english = itemDb.getRendererLookup();
    setGameLocale("de");
    const german = itemDb.getRendererLookup();
    expect(german).not.toBe(english);
    expect(german[SERRATION].displayName).toBe("Einkerbung");

    setGameLocale("en");
    const back = itemDb.getRendererLookup();
    expect(back).not.toBe(german);
    expect(back[SERRATION].displayName).toBeUndefined();
  });

  it("is rebuilt with the database", () => {
    const before = itemDb.getRendererLookup();
    itemDb.buildDatabase();
    const after = itemDb.getRendererLookup();
    expect(after).not.toBe(before);
    expect(Object.keys(after)).toEqual(Object.keys(before));
  });

  // The component panel lists every source behind "View all N sources".
  it("keeps every drop row of a component", () => {
    const components = Object.values(itemDb.getRendererLookup()).flatMap((e) => e.components);
    expect(components.some((c) => c.drops.length > 20)).toBe(true);
  });

});
