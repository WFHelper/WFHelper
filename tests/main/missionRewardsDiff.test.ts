import { describe, expect, it } from "vitest";

import { diffInventorySnapshots, snapshotInventory } from "../../services/missionRewardsDiff";

const RELIC = "/Lotus/Types/Game/Projections/T1VoidProjectionTestBronze";
const PLASTIDS = "/Lotus/Types/Items/MiscItems/Plastids";
const MOD = "/Lotus/Upgrades/Mods/Test/TestMod";
const SCULPTURE = "/Lotus/Types/Items/FusionTreasures/TestSculpture";
const BLUEPRINT = "/Lotus/Types/Recipes/Weapons/TestRifleBlueprint";
const RIFLE = "/Lotus/Weapons/Test/TestRifle";

function inventory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    RegularCredits: 1_000,
    FusionPoints: 50,
    MiscItems: [
      { ItemType: PLASTIDS, ItemCount: 10 },
      { ItemType: RELIC, ItemCount: 2 },
    ],
    RawUpgrades: [{ ItemType: MOD, ItemCount: 1 }],
    Recipes: [],
    LongGuns: [{ ItemType: RIFLE, ItemId: { $oid: "a1" } }],
    ...overrides,
  };
}

function diff(before: unknown, after: unknown) {
  const a = snapshotInventory(before);
  const b = snapshotInventory(after);
  if (!a || !b) throw new Error("fixture did not snapshot");
  return diffInventorySnapshots(a, b);
}

describe("snapshotInventory", () => {
  it("rejects values that are not an inventory object", () => {
    expect(snapshotInventory(null)).toBeNull();
    expect(snapshotInventory([])).toBeNull();
    expect(snapshotInventory("inventory")).toBeNull();
  });

  it("sums every ItemType + ItemCount entry per uniqueName and ignores malformed ones", () => {
    const snapshot = snapshotInventory({
      MiscItems: [
        { ItemType: PLASTIDS, ItemCount: 4 },
        { ItemType: PLASTIDS, ItemCount: 3 },
        { ItemType: "", ItemCount: 9 },
        { ItemCount: 9 },
        { ItemType: RELIC, ItemCount: Number.NaN },
        null,
      ],
      CrewShipRawSalvage: [{ ItemType: RELIC, ItemCount: 1 }],
      RegularCredits: "lots",
    });
    expect(snapshot?.stacks.get(PLASTIDS)).toBe(7);
    expect(snapshot?.stacks.get(RELIC)).toBe(1);
    expect(snapshot?.credits).toBe(0);
  });

  it("keys unique items by ItemId in either the $oid or the plain string form", () => {
    const snapshot = snapshotInventory({
      Suits: [{ ItemType: "/Lotus/Powersuits/Test/Test", ItemId: "s1" }],
      LongGuns: [{ ItemType: RIFLE, ItemId: { $oid: "a1" } }, { ItemType: RIFLE }],
    });
    expect([...(snapshot?.uniqueIds ?? [])]).toEqual([
      ["s1", "/Lotus/Powersuits/Test/Test"],
      ["a1", RIFLE],
    ]);
  });
});

describe("diffInventorySnapshots", () => {
  it("reports positive stack deltas, new stacks, credits and endo", () => {
    const after = inventory({
      RegularCredits: 26_500,
      FusionPoints: 350,
      MiscItems: [
        { ItemType: PLASTIDS, ItemCount: 14 },
        { ItemType: RELIC, ItemCount: 3 },
      ],
      FusionTreasures: [{ ItemType: SCULPTURE, ItemCount: 1, Sockets: 0 }],
      Recipes: [{ ItemType: BLUEPRINT, ItemCount: 1 }],
    });
    expect(diff(inventory(), after)).toEqual({
      items: [
        { uniqueName: RELIC, count: 1 },
        { uniqueName: SCULPTURE, count: 1 },
        { uniqueName: PLASTIDS, count: 4 },
        { uniqueName: BLUEPRINT, count: 1 },
      ],
      credits: 25_500,
      endo: 300,
    });
  });

  it("ignores anything spent or consumed, including credits and endo", () => {
    const after = inventory({
      RegularCredits: 10,
      FusionPoints: 0,
      MiscItems: [{ ItemType: PLASTIDS, ItemCount: 2 }],
      RawUpgrades: [],
      LongGuns: [],
    });
    expect(diff(inventory(), after)).toEqual({ items: [], credits: 0, endo: 0 });
  });

  it("counts a unique item once per new ItemId, never an existing one", () => {
    const after = inventory({
      LongGuns: [
        { ItemType: RIFLE, ItemId: { $oid: "a1" } },
        { ItemType: RIFLE, ItemId: { $oid: "a2" } },
        { ItemType: RIFLE, ItemId: { $oid: "a3" } },
      ],
    });
    expect(diff(inventory(), after).items).toEqual([{ uniqueName: RIFLE, count: 2 }]);
  });

  it("merges a stack gain and a new unique entry of the same uniqueName", () => {
    const after = inventory({
      RawUpgrades: [{ ItemType: MOD, ItemCount: 2 }],
      Upgrades: [{ ItemType: MOD, ItemId: { $oid: "u1" }, UpgradeFingerprint: "{}" }],
    });
    expect(diff(inventory(), after).items).toEqual([{ uniqueName: MOD, count: 2 }]);
  });

  it("leaves out builds, research and trade offers that only started", () => {
    const after = inventory({
      PendingRecipes: [{ ItemType: BLUEPRINT, ItemId: { $oid: "p1" } }],
      PersonalTechProjects: [{ ItemType: "/Lotus/Types/Research/Test", ItemId: { $oid: "r1" } }],
      PendingTrades: [{ ItemType: RIFLE, ItemId: { $oid: "t1" } }],
    });
    expect(diff(inventory(), after).items).toEqual([]);
  });

  it("sums counts across socket states so filling a sculpture is not a gain", () => {
    const before = inventory({
      FusionTreasures: [{ ItemType: SCULPTURE, ItemCount: 2, Sockets: 0 }],
    });
    const after = inventory({
      FusionTreasures: [
        { ItemType: SCULPTURE, ItemCount: 1, Sockets: 0 },
        { ItemType: SCULPTURE, ItemCount: 1, Sockets: 3 },
      ],
    });
    expect(diff(before, after).items).toEqual([]);
  });
});
