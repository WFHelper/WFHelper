import { describe, expect, it } from "vitest";

import {
  buildRelicSearchKeywordIndex,
  computeGroupDucatEv,
  computeSquadEV,
  parseOwnedRelics,
  relicGroupMatchesSearch,
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

    const solo = computeSquadEV(rewards, ducats, 1);
    const squad4 = computeSquadEV(rewards, ducats, 4);

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

  it("matches relic search query against reward names and part aliases", () => {
    const relicGroup = {
      key: "Axi N1",
      name: "Axi N1",
      tier: "Axi",
      code: "N1",
      imageUrl: null,
      qualities: {
        intact: {
          uniqueName: "/Lotus/Relics/AxiN1Intact",
          rewards: [
            {
              name: "Nova Prime Chassis Blueprint",
              rarity: "Rare",
              chance: 2,
              urlName: "nova_prime_chassis",
              ducats: 100,
            },
            {
              name: "Lex Prime Receiver",
              rarity: "Uncommon",
              chance: 25,
              urlName: "lex_prime_receiver",
              ducats: 45,
            },
          ],
        },
      },
    } satisfies RelicDatabase["groups"][string];

    expect(relicGroupMatchesSearch(relicGroup, "nova")).toBe(true);
    expect(relicGroupMatchesSearch(relicGroup, "nova chassis")).toBe(true);
    expect(relicGroupMatchesSearch(relicGroup, "nova_prime_chassis")).toBe(true);
    expect(relicGroupMatchesSearch(relicGroup, "volt chassis")).toBe(false);
  });

  it("indexes relic rewards as searchable keywords by uniqueName", () => {
    const db: RelicDatabase = {
      groups: {
        "Axi N1": {
          key: "Axi N1",
          name: "Axi N1",
          tier: "Axi",
          code: "N1",
          imageUrl: null,
          qualities: {
            intact: {
              uniqueName: "/Lotus/Relics/AxiN1Intact",
              rewards: [
                {
                  name: "Nova Prime Chassis Blueprint",
                  rarity: "Rare",
                  chance: 2,
                  urlName: "nova_prime_chassis",
                  ducats: 100,
                },
              ],
            },
            radiant: {
              uniqueName: "/Lotus/Relics/AxiN1Radiant",
              rewards: [
                {
                  name: "Nova Prime Chassis Blueprint",
                  rarity: "Rare",
                  chance: 10,
                  urlName: "nova_prime_chassis",
                  ducats: 100,
                },
              ],
            },
          },
        },
      },
      byUniqueName: {
        "/Lotus/Relics/AxiN1Intact": { groupKey: "Axi N1", quality: "intact" },
        "/Lotus/Relics/AxiN1Radiant": { groupKey: "Axi N1", quality: "radiant" },
      },
    };

    const index = buildRelicSearchKeywordIndex(db);

    expect(index["/Lotus/Relics/AxiN1Intact"]).toContain("nova prime chassis blueprint");
    expect(index["/Lotus/Relics/AxiN1Intact"]).toContain("nova chassis");
    expect(index["/Lotus/Relics/AxiN1Radiant"]).toContain("nova chassis");
  });

  it("merges LevelKeys and supplemental sources without double counting", () => {
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
    expect(owned["Lith A1"].radiant).toBe(9);
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

  it("avoids duplicate counting when relic appears in LevelKeys and MiscItems", () => {
    const db: RelicDatabase = {
      groups: {
        "Neo B7": {
          key: "Neo B7",
          name: "Neo B7",
          tier: "Neo",
          code: "B7",
          imageUrl: null,
          qualities: {},
        },
      },
      byUniqueName: {
        "/Lotus/Relics/NeoB7Intact": { groupKey: "Neo B7", quality: "intact" },
      },
    };

    const data: RawInventoryData = {
      LevelKeys: [{ ItemType: "/Lotus/Relics/NeoB7Intact", ItemCount: 5 }],
      MiscItems: [{ ItemType: "/Lotus/Relics/NeoB7Intact", ItemCount: 5 }],
    };

    const owned = parseOwnedRelics(data, db);
    expect(owned["Neo B7"].intact).toBe(5);
  });

  it("computeSquadEV returns 0 when all prices are null", () => {
    const rewards = [{ chance: 50 }, { chance: 50 }];
    const prices = [null, null];
    expect(computeSquadEV(rewards, prices, 4)).toBe(0);
  });

  it("computeSquadEV handles N=4 squad with mixed null prices", () => {
    const rewards = [{ chance: 25 }, { chance: 25 }, { chance: 25 }, { chance: 25 }];
    const prices = [null, 10, null, 50];
    const ev = computeSquadEV(rewards, prices, 4);
    expect(ev).toBeGreaterThan(0);
    expect(ev).toBeLessThanOrEqual(50);
  });

  it("parseOwnedRelics returns empty for null inputs", () => {
    expect(parseOwnedRelics(null, null)).toEqual({});
    expect(parseOwnedRelics(null, { groups: {}, byUniqueName: {} })).toEqual({});
  });

  it("parseOwnedRelics handles empty inventory", () => {
    const db: RelicDatabase = {
      groups: {
        "Lith X1": {
          key: "Lith X1",
          name: "Lith X1",
          tier: "Lith",
          code: "X1",
          imageUrl: null,
          qualities: {},
        },
      },
      byUniqueName: {
        "/Lotus/Relics/LithX1Intact": { groupKey: "Lith X1", quality: "intact" },
      },
    };
    const data: RawInventoryData = {};
    expect(parseOwnedRelics(data, db)).toEqual({});
  });
});
