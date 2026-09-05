import { describe, expect, it } from "vitest";

import { aggregateComponentOwnership } from "../../../config/shared/componentOwnership.js";
import { withoutFoundryPending } from "../../../config/shared/foundryPending.js";
import {
  aggregateNeeds,
  alignmentConflicts,
  dailyStandingCap,
  planSteps,
  syndicateStatus,
  type SyndicateGoalPlan,
} from "../../../src/lib/syndicates/rankup.js";
import type { SyndicateMeta } from "../../../config/shared/syndicateTypes.js";
import type { RawInventoryData } from "../../../src/types/inventory.js";

const GALLIUM = "/Lotus/Types/Items/MiscItems/Gallium";
const FORMA = "/Lotus/Types/Items/MiscItems/Forma";
const ALLOY = "/Lotus/Types/Items/MiscItems/AlloyPlate";
const MUTAGEN_BP = "/Lotus/Types/Recipes/DeimosRecipes/Pets/InfestedCritterMutagenCBlueprint";

function item(itemType: string, count: number, name: string) {
  return { itemType, count, name };
}

/** Shaped like the aligned six: negative ranks, an initiation and a 0 gap. */
const ARBITERS: SyndicateMeta = {
  tag: "ArbitersSyndicate",
  name: "Arbiters of Hexis",
  wikiPage: "Arbiters of Hexis",
  kind: "normal",
  dailyBin: "NORMAL",
  dailyField: "DailyAffiliation",
  alignments: { RedVeilSyndicate: -1, CephalonSudaSyndicate: 0.5 },
  initiation: { credits: 10000, items: [item(ALLOY, 500, "Alloy Plate")] },
  titles: [
    {
      level: -1,
      name: "Deceiver",
      minStanding: -27000,
      maxStanding: -5000,
      sacrifice: { credits: 50000, items: [item(FORMA, 1, "Forma")] },
    },
    {
      level: 1,
      name: "Principled",
      minStanding: 5000,
      maxStanding: 27000,
      sacrifice: { credits: 30000, items: [item(GALLIUM, 2, "Gallium")] },
    },
    {
      level: 2,
      name: "Authentic",
      minStanding: 27000,
      maxStanding: 71000,
      sacrifice: { credits: 50000, items: [item(FORMA, 1, "Forma")] },
    },
    {
      level: 3,
      name: "Lawful",
      minStanding: 71000,
      maxStanding: 141000,
      sacrifice: { credits: 100000, items: [item(GALLIUM, 1, "Gallium")] },
    },
  ],
};

const RED_VEIL: SyndicateMeta = {
  ...ARBITERS,
  tag: "RedVeilSyndicate",
  name: "Red Veil",
  wikiPage: "Red Veil",
  alignments: { ArbitersSyndicate: -1 },
};

/** Own pool, no initiation, and a blueprint sacrifice that lives in Recipes. */
const ENTRATI: SyndicateMeta = {
  tag: "EntratiSyndicate",
  name: "Entrati",
  wikiPage: "Entrati",
  kind: "openWorld",
  dailyBin: "ENTRATI",
  dailyField: "DailyAffiliationEntrati",
  titles: [
    {
      level: 1,
      name: "Stranger",
      minStanding: 5000,
      maxStanding: 27000,
      sacrifice: { credits: 0, items: [item(GALLIUM, 4, "Gallium")] },
    },
    {
      level: 2,
      name: "Acquaintance",
      minStanding: 27000,
      maxStanding: 71000,
      sacrifice: { credits: 0, items: [item(MUTAGEN_BP, 1, "Arioli Mutagen Blueprint")] },
    },
  ],
};

/** No sacrifice at any rank, the Ventkids shape. */
const VENTKIDS: SyndicateMeta = {
  tag: "VentKidsSyndicate",
  name: "Ventkids",
  wikiPage: "Ventkids",
  kind: "openWorld",
  dailyBin: "VENTKIDS",
  dailyField: "DailyAffiliationVentkids",
  titles: [
    { level: 1, name: "Glinty", minStanding: 5000, maxStanding: 27000 },
    { level: 2, name: "Whozit", minStanding: 27000, maxStanding: 71000 },
  ],
};

const INVENTORY: RawInventoryData = {
  PlayerLevel: 20,
  RegularCredits: 120000,
  DailyAffiliation: 4000,
  DailyAffiliationEntrati: 26000,
  DailyAffiliationVentkids: 0,
  Affiliations: [
    { Tag: "ArbitersSyndicate", Standing: 30000, Title: 2, Initiated: true },
    { Tag: "RedVeilSyndicate", Standing: -20000, Title: -1 },
    { Tag: "EntratiSyndicate", Standing: 1000 },
  ],
  MiscItems: [
    { ItemType: GALLIUM, ItemCount: 3 },
    { ItemType: ALLOY, ItemCount: 100 },
    { ItemType: GALLIUM, ItemCount: 1 },
  ],
  Recipes: [{ ItemType: MUTAGEN_BP, ItemCount: 1 }],
};

const plan = (meta: SyndicateMeta, targetLevel: number): SyndicateGoalPlan => ({
  meta,
  targetLevel,
  steps: planSteps(INVENTORY, meta, targetLevel),
});

/** The map the view hands the planner, built the way src/stores/data.ts wires
 *  hideFoundryClaims into the componentOwnership store. */
function ownership(inv: RawInventoryData, hideFoundryClaims = true): Map<string, number> {
  const usable = hideFoundryClaims ? withoutFoundryPending(inv) : inv;
  return aggregateComponentOwnership(usable);
}

const OWNED = ownership(INVENTORY);

describe("syndicateStatus", () => {
  it("reads level, standing and the shared daily pool", () => {
    const status = syndicateStatus(INVENTORY, ARBITERS);
    expect(status).toMatchObject({
      level: 2,
      title: "Authentic",
      standing: 30000,
      nextLevel: 3,
      standingToNext: 41000,
      initiated: true,
      dailyRemaining: 4000,
    });
  });

  it("treats a missing affiliation as rank 0 and not initiated", () => {
    const status = syndicateStatus(INVENTORY, VENTKIDS);
    expect(status).toMatchObject({ level: 0, title: "", standing: 0, nextLevel: 1 });
    expect(status.initiated).toBe(false);
    expect(status.standingToNext).toBe(5000);
  });

  it("measures a negative rank against the untitled rank 0", () => {
    const status = syndicateStatus(INVENTORY, RED_VEIL);
    expect(status.level).toBe(-1);
    expect(status.nextLevel).toBe(0);
    expect(status.standingToNext).toBe(15000);
    expect(status).toMatchObject({ tierStart: -27000, tierEnd: -5000 });
  });

  it("spans rank 0 from the end of rank -1 to the start of rank 1", () => {
    const neutral: RawInventoryData = {
      Affiliations: [{ Tag: "ArbitersSyndicate", Standing: 2000, Title: 0 }],
    };
    const status = syndicateStatus(neutral, ARBITERS);
    expect(status).toMatchObject({ level: 0, nextLevel: 1, standingToNext: 3000 });
    expect(status).toMatchObject({ tierStart: -5000, tierEnd: 5000 });
    expect(syndicateStatus(INVENTORY, VENTKIDS)).toMatchObject({ tierStart: 0, tierEnd: 5000 });
  });

  it("reports no next rank at the top", () => {
    const capped: RawInventoryData = {
      Affiliations: [{ Tag: "VentKidsSyndicate", Standing: 71000, Title: 2 }],
    };
    const status = syndicateStatus(capped, VENTKIDS);
    expect(status.nextLevel).toBeNull();
    expect(status.standingToNext).toBe(0);
    expect(status.dailyRemaining).toBeNull();
  });

  it("falls back to rank 0 without an inventory", () => {
    expect(syndicateStatus(null, ARBITERS)).toMatchObject({ level: 0, standing: 0 });
  });
});

describe("planSteps", () => {
  it("charges each tier once, measuring the first step from live standing", () => {
    const steps = planSteps(INVENTORY, ARBITERS, 3);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      level: 3,
      title: "Lawful",
      standingNeeded: 41000,
      credits: 100000,
      initiation: false,
    });
  });

  it("climbs out of a negative rank through rank 0, paying initiation once", () => {
    const steps = planSteps(INVENTORY, RED_VEIL, 2);
    expect(steps.map((step) => step.level)).toEqual([0, 1, 2]);
    // Leaving rank -1 costs what that title lists; rank 0 has no name of its own.
    expect(steps[0]).toMatchObject({
      title: "",
      standingNeeded: 15000,
      credits: 50000,
      items: [item(FORMA, 1, "Forma")],
      initiation: false,
    });
    // The joining cost merges into the rank 1 sacrifice.
    expect(steps[1]).toMatchObject({ level: 1, standingNeeded: 10000, credits: 40000 });
    expect(steps[1].items).toEqual([item(ALLOY, 500, "Alloy Plate"), item(GALLIUM, 2, "Gallium")]);
    expect(steps[1].initiation).toBe(true);
    expect(steps[2]).toMatchObject({ level: 2, standingNeeded: 22000, initiation: false });
  });

  it("stops at the top rank when the target overshoots", () => {
    expect(planSteps(INVENTORY, VENTKIDS, 9).map((step) => step.level)).toEqual([1, 2]);
  });

  it("returns no steps for a target at or below the current rank", () => {
    expect(planSteps(INVENTORY, ARBITERS, 2)).toEqual([]);
    expect(planSteps(INVENTORY, ARBITERS, -1)).toEqual([]);
  });

  it("leaves the title empty for a rank the table has no entry for", () => {
    // A data gap, not rank 0: the view must key its Neutral label on the level.
    const gap: SyndicateMeta = {
      ...VENTKIDS,
      titles: [
        ...VENTKIDS.titles,
        { level: 4, name: "Grandmaster", minStanding: 132000, maxStanding: 220000 },
      ],
    };
    const steps = planSteps(INVENTORY, gap, 4);

    expect(steps.map((step) => step.level)).toEqual([1, 2, 3, 4]);
    expect(steps[2]).toMatchObject({ level: 3, title: "" });
    expect(steps[3].title).toBe("Grandmaster");
  });

  it("keeps standing-only syndicates free", () => {
    const steps = planSteps(INVENTORY, VENTKIDS, 2);
    expect(steps.map((step) => step.credits)).toEqual([0, 0]);
    expect(steps.every((step) => step.items.length === 0)).toBe(true);
  });
});

describe("dailyStandingCap", () => {
  it("adds 500 per mastery rank", () => {
    expect(dailyStandingCap(INVENTORY)).toBe(26000);
    expect(dailyStandingCap({})).toBe(16000);
  });
});

describe("aggregateNeeds", () => {
  it("sums an item two syndicates both want", () => {
    const needs = aggregateNeeds([plan(ARBITERS, 3), plan(ENTRATI, 1)], INVENTORY, OWNED);
    const gallium = needs.items.find((entry) => entry.itemType === GALLIUM);
    expect(gallium).toMatchObject({ needed: 5, owned: 4, missing: 1 });
  });

  it("sorts by missing count and reports an owned blueprint as covered", () => {
    const needs = aggregateNeeds([plan(ARBITERS, 3), plan(ENTRATI, 2)], INVENTORY, OWNED);
    expect(needs.items.map((entry) => entry.itemType)).toEqual([GALLIUM, MUTAGEN_BP]);
    expect(needs.items[0].missing).toBe(1);
    expect(needs.items[1]).toMatchObject({ needed: 1, owned: 1, missing: 0 });
  });

  it("compares credits against the account balance", () => {
    const needs = aggregateNeeds([plan(ARBITERS, 3)], INVENTORY, OWNED);
    expect(needs.credits).toEqual({ needed: 100000, owned: 120000, missing: 0 });
  });

  it("merges the aligned syndicates into one shared standing pool", () => {
    const needs = aggregateNeeds([plan(ARBITERS, 3), plan(RED_VEIL, 1)], INVENTORY, OWNED);
    expect(needs.standing).toHaveLength(1);
    // 41000 for Arbiters rank 3, 15000 + 10000 for Red Veil through rank 0 to 1.
    expect(needs.standing[0]).toMatchObject({
      bin: "NORMAL",
      tags: ["ArbitersSyndicate", "RedVeilSyndicate"],
      needed: 66000,
      remainingToday: 4000,
      dailyCap: 26000,
      daysEstimate: 3,
    });
  });

  it("keeps open-world pools separate and counts a covered day as zero", () => {
    const needs = aggregateNeeds([plan(ARBITERS, 3), plan(ENTRATI, 1)], INVENTORY, OWNED);
    const bins = Object.fromEntries(needs.standing.map((pool) => [pool.bin, pool]));
    expect(Object.keys(bins).sort()).toEqual(["ENTRATI", "NORMAL"]);
    expect(bins.ENTRATI).toMatchObject({ needed: 4000, remainingToday: 26000, daysEstimate: 0 });
    expect(bins.NORMAL.daysEstimate).toBe(2);
  });

  it("treats an unreported pool as already spent", () => {
    const noPools: RawInventoryData = { PlayerLevel: 0, Affiliations: [] };
    const needs = aggregateNeeds(
      [{ meta: VENTKIDS, targetLevel: 1, steps: planSteps(noPools, VENTKIDS, 1) }],
      noPools,
      ownership(noPools),
    );
    expect(needs.standing[0]).toMatchObject({
      remainingToday: null,
      dailyCap: 16000,
      daysEstimate: 1,
    });
  });

  it("returns nothing for no goals", () => {
    const needs = aggregateNeeds([], INVENTORY, OWNED);
    expect(needs.items).toEqual([]);
    expect(needs.standing).toEqual([]);
    expect(needs.credits.needed).toBe(0);
  });
});

describe("aggregateNeeds ownership source", () => {
  /** The blueprint is still in Recipes but the foundry is already building it. */
  const PENDING: RawInventoryData = {
    ...INVENTORY,
    PendingRecipes: [{ ItemType: MUTAGEN_BP }],
  };

  it("drops a sacrifice blueprint the foundry already consumed", () => {
    const needs = aggregateNeeds([plan(ENTRATI, 2)], PENDING, ownership(PENDING));
    const blueprint = needs.items.find((entry) => entry.itemType === MUTAGEN_BP);
    expect(blueprint).toMatchObject({ needed: 1, owned: 0, missing: 1 });
  });

  it("keeps it owned while foundry claims stay visible", () => {
    const needs = aggregateNeeds([plan(ENTRATI, 2)], PENDING, ownership(PENDING, false));
    const blueprint = needs.items.find((entry) => entry.itemType === MUTAGEN_BP);
    expect(blueprint).toMatchObject({ needed: 1, owned: 1, missing: 0 });
  });

  it("counts an entry without ItemCount as one", () => {
    const single: RawInventoryData = { ...INVENTORY, MiscItems: [{ ItemType: GALLIUM }] };
    const needs = aggregateNeeds([plan(ENTRATI, 1)], single, ownership(single));
    expect(needs.items[0]).toMatchObject({ itemType: GALLIUM, needed: 4, owned: 1, missing: 3 });
  });
});

describe("alignmentConflicts", () => {
  it("reports each opposed pair once", () => {
    expect(alignmentConflicts([ARBITERS, RED_VEIL])).toEqual([
      { a: "ArbitersSyndicate", b: "RedVeilSyndicate", factor: -1 },
    ]);
  });

  it("ignores allies and syndicates that are not selected", () => {
    expect(alignmentConflicts([ARBITERS])).toEqual([]);
    expect(alignmentConflicts([ARBITERS, ENTRATI, VENTKIDS])).toEqual([]);
  });
});
