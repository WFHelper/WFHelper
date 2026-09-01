import { describe, expect, it } from "vitest";

import { aggregateComponentOwnership } from "../../../config/shared/componentOwnership.js";
import { withoutFoundryPending } from "../../../config/shared/foundryPending.js";
import {
  buildMasteryPlan,
  sortPlannedItems,
  type PlannedItem,
  type PlannerPin,
} from "../../../src/lib/masteryPlanner.js";
import type { ItemDbEntry } from "../../../src/types/inventory.js";

const FERRITE = "/Lotus/Types/Items/MiscItems/Ferrite";
const PLASTIDS = "/Lotus/Types/Items/MiscItems/Plastids";

function entry(name: string, recipe?: ItemDbEntry["recipe"]): ItemDbEntry {
  return { name, imageUrl: null, ...(recipe ? { recipe } : {}) };
}

function pin(uniqueName: string, name: string, masteryXpRemaining = 0): PlannerPin {
  return { uniqueName, name, imageUrl: null, masteryXpRemaining };
}

function totalFor(
  plan: ReturnType<typeof buildMasteryPlan>,
  uniqueName: string,
): { needed: number; owned: number; missing: number } {
  const row = plan.totals.find((entryRow) => entryRow.uniqueName === uniqueName);
  if (!row) throw new Error(`no total for ${uniqueName}`);
  return { needed: row.needed, owned: row.owned, missing: row.missing };
}

describe("mastery planner aggregation", () => {
  it("sums one resource across two pins and measures it against the pool once", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 15_000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 3000 }],
      }),
      "/Lotus/Weapons/Beta": entry("Beta", {
        buildPrice: 5000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 2000 }],
      }),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha"), pin("/Lotus/Weapons/Beta", "Beta")],
      db,
      new Map([[FERRITE, 4000]]),
    );

    expect(plan.totals).toHaveLength(1);
    expect(totalFor(plan, FERRITE)).toEqual({ needed: 5000, owned: 4000, missing: 1000 });
    expect(plan.totalCredits).toBe(20_000);

    // The pool is handed out in plan order, so the rows add up to the total
    // instead of showing two covered bars above one short total.
    const rowFor = (index: number) =>
      plan.items[index].resources.find((row) => row.uniqueName === FERRITE);
    expect(rowFor(0)).toMatchObject({ needed: 3000, owned: 3000, missing: 0 });
    expect(rowFor(1)).toMatchObject({ needed: 2000, owned: 1000, missing: 1000 });
    const rowsOwned = plan.items.reduce(
      (sum, item) => sum + (item.resources.find((row) => row.uniqueName === FERRITE)?.owned ?? 0),
      0,
    );
    expect(rowsOwned).toBe(totalFor(plan, FERRITE).owned);
  });

  it("never lets one pile cover more than a pin actually needs", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 100 }],
      }),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha")],
      db,
      new Map([[FERRITE, 900]]),
    );

    // The row shows the share this pin uses; the total still reports the pile.
    expect(plan.items[0].resources[0]).toMatchObject({ needed: 100, owned: 100, missing: 0 });
    expect(totalFor(plan, FERRITE)).toEqual({ needed: 100, owned: 900, missing: 0 });
  });

  it("keeps distinct resources apart while merging the shared one", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [
          { uniqueName: FERRITE, count: 100 },
          { uniqueName: PLASTIDS, count: 50 },
        ],
      }),
      "/Lotus/Weapons/Beta": entry("Beta", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 25 }],
      }),
      [FERRITE]: entry("Ferrite"),
      [PLASTIDS]: entry("Plastids"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha"), pin("/Lotus/Weapons/Beta", "Beta")],
      db,
      new Map([[PLASTIDS, 80]]),
    );

    expect(totalFor(plan, FERRITE)).toEqual({ needed: 125, owned: 0, missing: 125 });
    expect(totalFor(plan, PLASTIDS)).toEqual({ needed: 50, owned: 80, missing: 0 });
  });

  it("allocates one owned part to a single pin instead of both", () => {
    const shared = "/Lotus/Types/Recipes/Components/FormaBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: shared, count: 1 }],
      }),
      "/Lotus/Weapons/Beta": entry("Beta", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: shared, count: 1 }],
      }),
      [shared]: entry("Forma Blueprint", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 150 }],
      }),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha"), pin("/Lotus/Weapons/Beta", "Beta")],
      db,
      new Map([[shared, 1]]),
    );

    expect(plan.items[0].resources).toHaveLength(0);
    expect(totalFor(plan, FERRITE)).toEqual({ needed: 150, owned: 0, missing: 150 });
  });
});

describe("mastery planner ownership rules", () => {
  it("does not count a blueprint the foundry already consumed", () => {
    const blueprint = "/Lotus/Types/Recipes/Weapons/AlphaBarrelBlueprint";
    const raw = {
      Recipes: [{ ItemType: blueprint, ItemCount: 1 }],
      PendingRecipes: [{ ItemType: blueprint }],
      MiscItems: [{ ItemType: FERRITE, ItemCount: 900 }],
    };
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: blueprint, count: 1 }],
      }),
      [blueprint]: entry("Alpha Barrel"),
      [FERRITE]: entry("Ferrite"),
    };

    const withPending = aggregateComponentOwnership(raw.MiscItems, raw.Recipes);
    const usable = withoutFoundryPending(raw);
    const afterPending = aggregateComponentOwnership(usable.MiscItems, usable.Recipes);

    const before = buildMasteryPlan([pin("/Lotus/Weapons/Alpha", "Alpha")], db, withPending);
    const after = buildMasteryPlan([pin("/Lotus/Weapons/Alpha", "Alpha")], db, afterPending);

    expect(before.items[0].components[0].owned).toBe(1);
    expect(before.items[0].craftableNow).toBe(true);
    expect(after.items[0].components[0].owned).toBe(0);
    expect(after.items[0].components[0].missing).toBe(1);
    expect(after.items[0].craftableNow).toBe(false);
  });

  it("counts a set component the inventory spells as a blueprint", () => {
    const setName = "/Lotus/Types/Recipes/Weapons/AlphaBarrelComponent";
    const held = "/Lotus/Types/Recipes/Weapons/AlphaBarrelBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: setName, count: 1 }],
      }),
      [setName]: entry("Alpha Barrel"),
    };

    const plan = buildMasteryPlan([pin("/Lotus/Weapons/Alpha", "Alpha")], db, new Map([[held, 1]]));

    expect(plan.items[0].components[0].owned).toBe(1);
    expect(plan.items[0].craftableNow).toBe(true);
    expect(plan.items[0].completeness).toBe(1);
  });

  it("reports no plan for a pin the item database cannot build", () => {
    const plan = buildMasteryPlan(
      [pin("/Lotus/Weapons/Ghost", "Ghost")],
      { "/Lotus/Weapons/Ghost": entry("Ghost") },
      new Map(),
    );

    expect(plan.items[0].hasRecipe).toBe(false);
    expect(plan.items[0].craftableNow).toBe(false);
    expect(plan.craftableCount).toBe(0);
  });
});

describe("mastery planner recipe walking", () => {
  it("rolls a sub-recipe down to its own leaf resources", () => {
    const chassis = "/Lotus/Types/Recipes/Warframes/AlphaChassisBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Powersuits/Alpha": entry("Alpha", {
        buildPrice: 25_000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: chassis, count: 1 }],
      }),
      [chassis]: entry("Alpha Chassis", {
        buildPrice: 15_000,
        buildTime: 0,
        num: 1,
        ingredients: [
          { uniqueName: FERRITE, count: 900 },
          { uniqueName: PLASTIDS, count: 220 },
        ],
      }),
      [FERRITE]: entry("Ferrite"),
      [PLASTIDS]: entry("Plastids"),
    };

    const plan = buildMasteryPlan([pin("/Lotus/Powersuits/Alpha", "Alpha")], db, new Map());

    expect(totalFor(plan, FERRITE).needed).toBe(900);
    expect(totalFor(plan, PLASTIDS).needed).toBe(220);
    expect(plan.totalCredits).toBe(40_000);
    // The chassis stays a component chip and never doubles as a material row.
    expect(plan.totals.some((row) => row.uniqueName === chassis)).toBe(false);
    expect(plan.items[0].components[0].uniqueName).toBe(chassis);
  });

  it("stops recursing into a sub-recipe that is already owned", () => {
    const chassis = "/Lotus/Types/Recipes/Warframes/AlphaChassisBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Powersuits/Alpha": entry("Alpha", {
        buildPrice: 25_000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: chassis, count: 1 }],
      }),
      [chassis]: entry("Alpha Chassis", {
        buildPrice: 15_000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 900 }],
      }),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Powersuits/Alpha", "Alpha")],
      db,
      new Map([[chassis, 1]]),
    );

    expect(plan.totals).toHaveLength(0);
    expect(plan.totalCredits).toBe(25_000);
    expect(plan.items[0].craftableNow).toBe(true);
  });

  it("divides required runs by the recipe yield", () => {
    const widget = "/Lotus/Types/Recipes/Components/WidgetBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: widget, count: 4 }],
      }),
      [widget]: entry("Widget", {
        buildPrice: 1000,
        buildTime: 0,
        num: 2,
        ingredients: [{ uniqueName: FERRITE, count: 100 }],
      }),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan([pin("/Lotus/Weapons/Alpha", "Alpha")], db, new Map());

    // Four widgets are two runs of a yield-2 recipe, not four.
    expect(totalFor(plan, FERRITE).needed).toBe(200);
    expect(plan.totalCredits).toBe(2000);
  });

  it("scales the yield down by the copies already owned", () => {
    const widget = "/Lotus/Types/Recipes/Components/WidgetBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: widget, count: 4 }],
      }),
      [widget]: entry("Widget", {
        buildPrice: 1000,
        buildTime: 0,
        num: 2,
        ingredients: [{ uniqueName: FERRITE, count: 100 }],
      }),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha")],
      db,
      new Map([[widget, 2]]),
    );

    expect(totalFor(plan, FERRITE).needed).toBe(100);
    expect(plan.totalCredits).toBe(1000);
  });

  it("needs one reusable blueprint no matter how many runs a part takes", () => {
    // A name the alias rule cannot fold into the part, or the tree drops the
    // blueprint child as the same owned pile.
    const widget = "/Lotus/Types/Recipes/Components/Gizmo";
    const widgetBp = "/Lotus/Types/Recipes/Components/GizmoConstructionBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: widget, count: 3 }],
      }),
      [widget]: entry("Gizmo", {
        blueprintUniqueName: widgetBp,
        reusableBlueprint: true,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 10 }],
      }),
      [widgetBp]: entry("Gizmo Blueprint"),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha")],
      db,
      new Map([[widget, 1]]),
    );

    expect(totalFor(plan, FERRITE).needed).toBe(20);
    // Two runs, but a reusable blueprint is still only wanted once.
    expect(totalFor(plan, widgetBp).needed).toBe(1);
  });

  it("needs one consumed blueprint per run of the part", () => {
    const widget = "/Lotus/Types/Recipes/Components/Gizmo";
    const widgetBp = "/Lotus/Types/Recipes/Components/GizmoConstructionBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: widget, count: 3 }],
      }),
      [widget]: entry("Gizmo", {
        blueprintUniqueName: widgetBp,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 10 }],
      }),
      [widgetBp]: entry("Gizmo Blueprint"),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan([pin("/Lotus/Weapons/Alpha", "Alpha")], db, new Map());

    expect(totalFor(plan, widgetBp).needed).toBe(3);
    expect(totalFor(plan, FERRITE).needed).toBe(30);
  });
});

describe("mastery planner sorting", () => {
  function plannedItem(overrides: Partial<PlannedItem> & { name: string }): PlannedItem {
    return {
      uniqueName: `/Lotus/${overrides.name}`,
      imageUrl: null,
      masteryXpRemaining: 0,
      hasRecipe: true,
      components: [],
      resources: [],
      credits: 0,
      completeness: 0,
      craftableNow: false,
      ...overrides,
    };
  }

  const label = (item: PlannedItem): string => item.displayName || item.name;

  it("floats craftable items above every other sort key", () => {
    const items = [
      plannedItem({ name: "Zeta", masteryXpRemaining: 6000, completeness: 0.2 }),
      plannedItem({ name: "Alpha", masteryXpRemaining: 100, craftableNow: true }),
    ];

    expect(sortPlannedItems(items, "mastery_xp", label).map((item) => item.name)).toEqual([
      "Alpha",
      "Zeta",
    ]);
    expect(sortPlannedItems(items, "completeness", label).map((item) => item.name)).toEqual([
      "Alpha",
      "Zeta",
    ]);
  });

  it("orders by mastery gain, completeness and name inside a group", () => {
    const items = [
      plannedItem({ name: "Beta", masteryXpRemaining: 3000, completeness: 0.1 }),
      plannedItem({ name: "Alpha", masteryXpRemaining: 9000, completeness: 0.9 }),
      plannedItem({ name: "Gamma", masteryXpRemaining: 3000, completeness: 0.5 }),
    ];

    expect(sortPlannedItems(items, "mastery_xp", label).map((item) => item.name)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    expect(sortPlannedItems(items, "completeness", label).map((item) => item.name)).toEqual([
      "Alpha",
      "Gamma",
      "Beta",
    ]);
    expect(sortPlannedItems(items, "name", label).map((item) => item.name)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
  });
});
