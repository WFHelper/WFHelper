import { describe, expect, it } from "vitest";

import {
  computeGroupDucatEv,
  computeSquadDucatEV,
  computeSquadEV,
  parseOwnedRelics,
} from "./relic.js";
import type { RawInventoryData } from "../types/inventory.js";
import type { RelicDatabase } from "../types/relics.js";

describe("relic helpers", () => {
  it("computes expected value for solo and squad openings", () => {
    const rewards = [{ chance: 50 }, { chance: 50 }];
    const prices = [10, 20];

    const solo = computeSquadEV(rewards, prices, 1);
    const squad2 = computeSquadEV(rewards, prices, 2);

    expect(solo).toBeCloseTo(15, 6);
    expect(squad2).toBeCloseTo(17.5, 6);
    expect(squad2).toBeGreaterThan(solo);
  });

  it("computes ducat EV with the same squad max-pick model", () => {
    const rewards = [{ chance: 50 }, { chance: 50 }];
    const ducats = [15, 100];

    const solo = computeSquadDucatEV(rewards, ducats, 1);
    const squad4 = computeSquadDucatEV(rewards, ducats, 4);

    expect(solo).toBeCloseTo(57.5, 6);
    expect(squad4).toBeCloseTo(94.6875, 6);
    expect(squad4).toBeGreaterThan(solo);
  });

  it("picks the best quality ducat EV in best mode", () => {
    const relicGroup = {
      key: "Neo Z9",
      name: "Neo Z9",
      tier: "Neo",
      code: "Z9",
      imageUrl: null,
      qualities: {
        intact: {
          uniqueName: "/Lotus/Relics/NeoZ9Intact",
          rewards: [
            { name: "Part A", rarity: "Rare", chance: 50, urlName: null, ducats: 15 },
            { name: "Part B", rarity: "Common", chance: 50, urlName: null, ducats: 45 },
          ],
        },
        radiant: {
          uniqueName: "/Lotus/Relics/NeoZ9Radiant",
          rewards: [
            { name: "Part A", rarity: "Rare", chance: 50, urlName: null, ducats: 100 },
            { name: "Part B", rarity: "Common", chance: 50, urlName: null, ducats: 15 },
          ],
        },
      },
    } satisfies RelicDatabase["groups"][string];

    const intactEv = computeGroupDucatEv(relicGroup, 1, "intact");
    const radiantEv = computeGroupDucatEv(relicGroup, 1, "radiant");
    const bestEv = computeGroupDucatEv(relicGroup, 1, "best");

    expect(intactEv).toBeCloseTo(30, 6);
    expect(radiantEv).toBeCloseTo(57.5, 6);
    expect(bestEv).toBeCloseTo(57.5, 6);
  });

  it("returns null ducat EV when no reward has ducat data", () => {
    const relicGroup = {
      key: "Axi V5",
      name: "Axi V5",
      tier: "Axi",
      code: "V5",
      imageUrl: null,
      qualities: {
        radiant: {
          uniqueName: "/Lotus/Relics/AxiV5Radiant",
          rewards: [
            { name: "Part A", rarity: "Rare", chance: 50, urlName: "part_a", ducats: null },
            { name: "Part B", rarity: "Common", chance: 50, urlName: "part_b", ducats: null },
          ],
        },
      },
    } satisfies RelicDatabase["groups"][string];

    expect(computeGroupDucatEv(relicGroup, 4, "best")).toBeNull();
  });

  it("uses LevelKeys as primary source for owned relic counts", () => {
    const db: RelicDatabase = {
      groups: {
        "Lith A1": {
          key: "Lith A1",
          name: "Lith A1",
          tier: "Lith",
          code: "A1",
          imageUrl: null,
          qualities: {},
        },
      },
      byUniqueName: {
        "/Lotus/Relics/LithA1Intact": { groupKey: "Lith A1", quality: "intact" },
        "/Lotus/Relics/LithA1Radiant": { groupKey: "Lith A1", quality: "radiant" },
      },
    };
    const data: RawInventoryData = {
      LevelKeys: [{ ItemType: "/Lotus/Relics/LithA1Intact", ItemCount: 2 }],
      MiscItems: [{ ItemType: "/Lotus/Relics/LithA1Radiant", ItemCount: 9 }],
    };

    const owned = parseOwnedRelics(data, db);
    expect(owned["Lith A1"].intact).toBe(2);
    expect(owned["Lith A1"].radiant).toBe(0);
  });

  it("falls back to other arrays when LevelKeys are unavailable", () => {
    const db: RelicDatabase = {
      groups: {
        "Axi Y2": {
          key: "Axi Y2",
          name: "Axi Y2",
          tier: "Axi",
          code: "Y2",
          imageUrl: null,
          qualities: {},
        },
      },
      byUniqueName: {
        "/Lotus/Relics/AxiY2Radiant": { groupKey: "Axi Y2", quality: "radiant" },
        "/Lotus/Relics/AxiY2Intact": { groupKey: "Axi Y2", quality: "intact" },
      },
    };
    const data: RawInventoryData = {
      MiscItems: [
        { ItemType: "/Lotus/Relics/AxiY2Radiant", ItemCount: 3 },
        { ItemType: "/Lotus/Relics/AxiY2Intact" },
      ],
    };

    const owned = parseOwnedRelics(data, db);
    expect(owned["Axi Y2"].radiant).toBe(3);
    expect(owned["Axi Y2"].intact).toBe(1);
  });
});
