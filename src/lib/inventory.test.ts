import { describe, expect, it } from "vitest";

import { parseFoundry, parseInventory, parseResources } from "./inventory.js";
import type { ItemDbEntry, RawInventoryData } from "../types/inventory.js";

describe("inventory parsing", () => {
  it("parses inventory categories and hides exalted/special entries", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Types/Player/VoltPrime": {
        name: "Volt Prime",
        isPrime: true,
        masteryReq: 0,
        tradable: true,
      },
      "/Lotus/Types/Weapons/SomaPrime": {
        name: "Soma Prime",
        isPrime: true,
        masteryReq: 7,
        tradable: true,
      },
      "/Lotus/Types/OperatorAmplifiers/AmpOne": {
        name: "Amp One",
        productCategory: "OperatorAmps",
      },
    };

    const data: RawInventoryData = {
      Suits: [{ ItemType: "/Lotus/Types/Player/VoltPrime", XP: 12_000 }],
      LongGuns: [{ ItemType: "/Lotus/Types/Weapons/SomaPrime", XP: 300_000 }],
      OperatorAmps: [{ ItemType: "/Lotus/Types/OperatorAmplifiers/AmpOne", XP: 0 }],
      Melee: [{ ItemType: "/Lotus/Types/ExaltedWeapons/ExaltedBlade", XP: 18_000 }],
    };

    const items = parseInventory(data, db);
    expect(items.length).toBe(3);
    expect(items.some((item) => item.internalName.includes("ExaltedWeapons"))).toBe(
      false,
    );

    const volt = items.find((item) => item.name === "Volt Prime");
    expect(volt?.category).toBe("warframes");
    expect(volt?.rank).toBe(2);

    const soma = items.find((item) => item.name === "Soma Prime");
    expect(soma?.rank).toBe(30);
    expect(soma?.tradable).toBe(true);

    const amp = items.find((item) => item.name === "Amp One");
    expect(amp?.category).toBe("amps");
  });

  it("parses foundry build completion dates and recipe counts", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Recipes/BuildA": { name: "Build A" },
      "/Lotus/Recipes/BuildB": { name: "Build B" },
      "/Lotus/Recipes/RecipeA": { name: "Recipe A" },
      "/Lotus/Recipes/RecipeB": { name: "Recipe B" },
    };
    const data: RawInventoryData = {
      PendingRecipes: [
        {
          ItemType: "/Lotus/Recipes/BuildA",
          CompletionDate: { $date: { $numberLong: "1710000000000" } },
        },
        {
          ItemType: "/Lotus/Recipes/BuildB",
          CompletionDate: "not-a-date",
        },
      ],
      Recipes: [
        { ItemType: "/Lotus/Recipes/RecipeA", ItemCount: 2 },
        { ItemType: "/Lotus/Recipes/RecipeB" },
      ],
    };

    const foundry = parseFoundry(data, db);
    expect(foundry.building).toHaveLength(2);
    expect(foundry.building[0].endDate?.getTime()).toBe(1_710_000_000_000);
    expect(foundry.building[1].endDate).toBeNull();
    expect(foundry.recipes[0].count).toBe(2);
    expect(foundry.recipes[1].count).toBe(1);
  });

  it("parses resources and sorts by count descending", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Types/Items/AlloyPlate": { name: "Alloy Plate" },
      "/Lotus/Types/Items/OrokinCell": { name: "Orokin Cell" },
      "/Lotus/Types/Items/Ferrite": { name: "Ferrite" },
    };
    const data: RawInventoryData = {
      MiscItems: [
        { ItemType: "/Lotus/Types/Items/OrokinCell", ItemCount: 3 },
        { ItemType: "/Lotus/Types/Items/AlloyPlate", ItemCount: 40_000 },
        { ItemType: "/Lotus/Types/Items/Ferrite", ItemCount: 1_000 },
      ],
    };

    const resources = parseResources(data, db);
    expect(resources.map((r) => r.name)).toEqual([
      "Alloy Plate",
      "Ferrite",
      "Orokin Cell",
    ]);
  });
});

