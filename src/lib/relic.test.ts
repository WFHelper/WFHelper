import { describe, expect, it } from "vitest";

import { computeSquadEV, parseOwnedRelics } from "./relic.js";
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

