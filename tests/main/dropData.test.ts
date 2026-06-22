import { describe, expect, it } from "vitest";

import { flattenForTest, searchDrops, setRowsForTest, type DropRow } from "../../services/dropData";

describe("dropData.flatten", () => {
  const data = {
    missionRewards: {
      Mercury: {
        Apollodorus: { gameMode: "Survival", rewards: { C: [{ itemName: "Vitus", rarity: "Rare", chance: 7 }] } },
      },
    },
    relics: [
      { tier: "Axi", relicName: "A1", state: "Intact", rewards: [{ itemName: "Nikana Prime Blueprint", rarity: "Rare", chance: 2 }] },
      { tier: "Axi", relicName: "A1", state: "Radiant", rewards: [{ itemName: "Nikana Prime Blueprint", rarity: "Rare", chance: 10 }] },
    ],
    modLocations: [
      { modName: "Serration", enemies: [{ enemyName: "Grineer Lancer", rarity: "Common", chance: 11.06 }] },
    ],
    enemyModTables: [
      { enemyName: "Screamer", mods: [{ modName: "Vitality", rarity: "Uncommon", chance: 12.5 }] },
    ],
    resourceByAvatar: [
      { source: "Motherboard Cluster", items: [{ item: "Techrot Motherboard", rarity: "Common", chance: 100 }] },
    ],
    syndicates: {
      "Kahl's Garrison": [
        { item: "Styanax Systems Blueprint", rarity: "Common", chance: 100, place: "Kahl's Garrison, Encampment" },
      ],
    },
  };

  const rows = flattenForTest(data);
  const find = (item: string): DropRow | undefined => rows.find((r) => r.item === item);

  it("flattens mission rewards with rotation in the place", () => {
    expect(find("Vitus")).toEqual({ item: "Vitus", place: "Apollodorus (Mercury), Rotation C", rarity: "Rare", chance: 7 });
  });

  it("keeps only the Intact relic state", () => {
    const nikana = rows.filter((r) => r.item === "Nikana Prime Blueprint");
    expect(nikana).toHaveLength(1);
    expect(nikana[0].place).toBe("Axi A1 Relic");
    expect(nikana[0].chance).toBe(2);
  });

  it("maps item→enemy (modLocations) and enemy→item (enemyModTables)", () => {
    expect(find("Serration")?.place).toBe("Grineer Lancer");
    expect(find("Vitality")?.place).toBe("Screamer");
  });

  it("handles resourceByAvatar (item field) and pre-placed syndicates", () => {
    expect(find("Techrot Motherboard")?.place).toBe("Motherboard Cluster");
    expect(find("Styanax Systems Blueprint")?.place).toBe("Kahl's Garrison, Encampment");
  });
});

describe("dropData.searchDrops", () => {
  setRowsForTest([
    { item: "Vitus Essence", place: "Arbitrations, Rotation C", rarity: "Uncommon", chance: 10 },
    { item: "Vitus Essence", place: "Arbitration Shield Drone", rarity: "Common", chance: 6 },
    { item: "Survivalist Vitus", place: "Elsewhere", rarity: "Rare", chance: 1 },
  ]);

  it("ranks prefix matches above mid-word and returns total", () => {
    const res = searchDrops("vitus", "item");
    expect(res.total).toBe(3);
    expect(res.rows[0].item).toBe("Vitus Essence"); // prefix beats "Survivalist Vitus"
  });

  it("searches by place when mode is place", () => {
    const res = searchDrops("arbitration", "place");
    expect(res.total).toBe(2);
  });

  it("returns nothing for an empty query", () => {
    expect(searchDrops("  ", "item")).toEqual({ rows: [], total: 0 });
  });
});
