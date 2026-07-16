import { describe, expect, it } from "vitest";

import { buildCraftingTree } from "../../../src/lib/craftingTree.js";
import type { ItemDbEntry } from "../../../src/types/inventory.js";

function item(name: string, recipe?: ItemDbEntry["recipe"]): ItemDbEntry {
  return {
    name,
    uniqueName: `/items/${name}`,
    category: "Weapon",
    productCategory: "Pistols",
    imageUrl: null,
    isPrime: false,
    masteryReq: 0,
    vaulted: false,
    tradable: false,
    keywords: [],
    components: [],
    ...(recipe ? { recipe } : {}),
  };
}

describe("crafting tree", () => {
  it("merges duplicate recipe ingredients into one counted child", () => {
    const db: Record<string, ItemDbEntry> = {
      "/items/Akbolto": item("Akbolto", {
        blueprintUniqueName: "/blueprints/Akbolto",
        buildPrice: 20_000,
        buildTime: 43_200,
        num: 1,
        ingredients: [
          { uniqueName: "/items/Bolto", count: 1 },
          { uniqueName: "/items/Bolto", count: 1 },
          { uniqueName: "/resources/OrokinCell", count: 1 },
        ],
      }),
      "/items/Bolto": item("Bolto"),
      "/resources/OrokinCell": item("Orokin Cell"),
      "/blueprints/Akbolto": item("Akbolto Blueprint"),
    };

    const tree = buildCraftingTree("/items/Akbolto", db, new Map());

    const boltoChildren = tree?.children.filter((child) => child.uniqueName === "/items/Bolto");
    expect(boltoChildren).toHaveLength(1);
    expect(boltoChildren?.[0].count).toBe(2);
  });

  it("needs one blueprint total when the recipe blueprint is reusable", () => {
    const db: Record<string, ItemDbEntry> = {
      "/items/AkTwin": item("AkTwin", {
        blueprintUniqueName: "/blueprints/AkTwin",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: "/items/Solo", count: 2 }],
      }),
      "/items/Solo": item("Solo", {
        blueprintUniqueName: "/blueprints/Solo",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        reusableBlueprint: true,
        ingredients: [{ uniqueName: "/resources/OrokinCell", count: 1 }],
      }),
      "/resources/OrokinCell": item("Orokin Cell"),
      "/blueprints/AkTwin": item("AkTwin Blueprint"),
      "/blueprints/Solo": item("Solo Blueprint"),
    };

    const tree = buildCraftingTree("/items/AkTwin", db, new Map([["/blueprints/Solo", 1]]));
    const solo = tree?.children.find((child) => child.uniqueName === "/items/Solo");
    const soloBp = solo?.children.find((child) => child.uniqueName === "/blueprints/Solo");

    expect(solo?.count).toBe(2);
    expect(soloBp?.count).toBe(1);
    expect(soloBp?.missing).toBe(0);
    expect(soloBp?.isBlueprintItem).toBe(true);

    const akBp = tree?.children.find((child) => child.uniqueName === "/blueprints/AkTwin");
    expect(akBp?.count).toBe(1);
  });

  it("stops recursive recipe cycles at the repeated ingredient", () => {
    const db: Record<string, ItemDbEntry> = {
      "/items/A": item("A", {
        blueprintUniqueName: "/blueprints/A",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: "/items/B", count: 1 }],
      }),
      "/items/B": item("B", {
        blueprintUniqueName: "/blueprints/B",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: "/items/A", count: 1 }],
      }),
      "/blueprints/A": item("A Blueprint"),
      "/blueprints/B": item("B Blueprint"),
    };

    const tree = buildCraftingTree("/items/A", db, new Map());
    const repeatedA = tree?.children
      .find((child) => child.uniqueName === "/items/B")
      ?.children.find((child) => child.uniqueName === "/items/A");

    expect(repeatedA?.recipe).toBeNull();
    expect(repeatedA?.children).toHaveLength(0);
  });
});
