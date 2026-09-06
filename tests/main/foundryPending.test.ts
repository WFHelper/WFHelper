import { describe, expect, it } from "vitest";

import { aggregateComponentOwnership } from "../../config/shared/componentOwnership";
import { pendingRecipeCounts, withoutFoundryPending } from "../../config/shared/foundryPending";

const HILDRYN = "/Lotus/Types/Recipes/WarframeRecipes/HildrynPrimeBlueprint";
const FORMA = "/Lotus/Types/Recipes/Components/FormaBlueprint";
// consumeOnUse=false in DE's export: the copy survives every build.
const CELL_BP = "/Lotus/Types/Recipes/Components/OrokinCellResourceBlueprint";
const CELL = "/Lotus/Types/Items/MiscItems/OrokinCell";
const isReusable = (uniqueName: string): boolean => uniqueName === CELL_BP;

describe("pendingRecipeCounts", () => {
  it("counts one blueprint per pending build", () => {
    const counts = pendingRecipeCounts([
      { ItemType: FORMA },
      { ItemType: FORMA },
      { ItemType: HILDRYN },
    ]);

    expect(counts.get(FORMA)).toBe(2);
    expect(counts.get(HILDRYN)).toBe(1);
  });

  it("ignores junk entries and non-arrays", () => {
    expect(pendingRecipeCounts(null).size).toBe(0);
    expect(pendingRecipeCounts([null, {}, { ItemType: 7 }]).size).toBe(0);
  });
});

describe("withoutFoundryPending", () => {
  it("returns the input untouched when nothing is building", () => {
    const data = { Recipes: [{ ItemType: HILDRYN, ItemCount: 1 }] };
    expect(withoutFoundryPending(data)).toBe(data);
  });

  it("drops the blueprint when the only copy is in the foundry", () => {
    const result = withoutFoundryPending({
      Recipes: [{ ItemType: HILDRYN, ItemCount: 1 }],
      PendingRecipes: [{ ItemType: HILDRYN }],
    });

    expect(result.Recipes).toEqual([]);
  });

  it("keeps the spare copies of a stack", () => {
    const result = withoutFoundryPending({
      Recipes: [{ ItemType: FORMA, ItemCount: 10 }],
      PendingRecipes: [{ ItemType: FORMA }, { ItemType: FORMA }],
    });

    expect(result.Recipes).toEqual([{ ItemType: FORMA, ItemCount: 8 }]);
  });

  it("spends across split stacks of the same blueprint", () => {
    const result = withoutFoundryPending({
      Recipes: [
        { ItemType: FORMA, ItemCount: 1 },
        { ItemType: FORMA, ItemCount: 3 },
      ],
      PendingRecipes: [{ ItemType: FORMA }, { ItemType: FORMA }],
    });

    expect(result.Recipes).toEqual([{ ItemType: FORMA, ItemCount: 2 }]);
  });

  it("treats a missing ItemCount as one copy", () => {
    const result = withoutFoundryPending({
      Recipes: [{ ItemType: HILDRYN }],
      PendingRecipes: [{ ItemType: HILDRYN }],
    });

    expect(result.Recipes).toEqual([]);
  });

  it("leaves other slices and unrelated blueprints alone", () => {
    const data = {
      MiscItems: [{ ItemType: "/Lotus/Types/Items/Ferrite", ItemCount: 5 }],
      Recipes: [{ ItemType: FORMA, ItemCount: 2 }],
      PendingRecipes: [{ ItemType: HILDRYN }],
    };

    const result = withoutFoundryPending(data);

    expect(result.MiscItems).toBe(data.MiscItems);
    expect(result.Recipes).toEqual([{ ItemType: FORMA, ItemCount: 2 }]);
  });

  it("survives a missing Recipes slice", () => {
    const data = { PendingRecipes: [{ ItemType: HILDRYN }] };
    expect(withoutFoundryPending(data)).toBe(data);
  });

  it("keeps a reusable blueprint that is building right now", () => {
    const result = withoutFoundryPending(
      {
        Recipes: [{ ItemType: CELL_BP, ItemCount: 1 }],
        PendingRecipes: [{ ItemType: CELL_BP }],
      },
      isReusable,
    );

    expect(result.Recipes).toEqual([{ ItemType: CELL_BP, ItemCount: 1 }]);
  });

  it("still spends consumed blueprints while a reusable one builds", () => {
    const result = withoutFoundryPending(
      {
        Recipes: [
          { ItemType: CELL_BP, ItemCount: 1 },
          { ItemType: HILDRYN, ItemCount: 1 },
        ],
        PendingRecipes: [{ ItemType: CELL_BP }, { ItemType: HILDRYN }],
      },
      isReusable,
    );

    expect(result.Recipes).toEqual([{ ItemType: CELL_BP, ItemCount: 1 }]);
  });

  it("never touches the resources a pending build would consume", () => {
    const data = {
      MiscItems: [{ ItemType: CELL, ItemCount: 100 }],
      Recipes: [{ ItemType: CELL_BP, ItemCount: 1 }],
      PendingRecipes: [{ ItemType: CELL_BP }],
    };

    const usable = withoutFoundryPending(data, isReusable);
    const owned = aggregateComponentOwnership(usable);

    expect(owned.get(CELL)).toBe(100);
    expect(owned.get(CELL_BP)).toBe(1);
  });

  it("drops a reusable blueprint too when the exemption is not wired up", () => {
    const result = withoutFoundryPending({
      Recipes: [{ ItemType: CELL_BP, ItemCount: 1 }],
      PendingRecipes: [{ ItemType: CELL_BP }],
    });

    expect(result.Recipes).toEqual([]);
  });
});

describe("aggregateComponentOwnership with foundry builds", () => {
  it("no longer counts a blueprint the foundry already holds", () => {
    const data = {
      MiscItems: [],
      Recipes: [{ ItemType: HILDRYN, ItemCount: 1 }],
      PendingRecipes: [{ ItemType: HILDRYN }],
    };

    const usable = withoutFoundryPending(data);
    const owned = aggregateComponentOwnership(usable);

    expect(owned.has(HILDRYN)).toBe(false);
  });
});
