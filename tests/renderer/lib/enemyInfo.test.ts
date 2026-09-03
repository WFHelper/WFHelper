import { describe, expect, it } from "vitest";

import {
  findEnemyByName,
  findEnemyByType,
  normalizeEnemyName,
} from "../../../src/lib/enemies/enemyInfo";

const BUTCHER = "/Lotus/Types/Enemies/Grineer/AIWeek/BladeSawman";
// Carries every spawn field the wiki module can state, including a #fragment link.
const AKKALAK_TURRET = "/Lotus/Types/Enemies/Grineer/Eidolon/EidolonAutoTurretAgent";

describe("enemyInfo", () => {
  it("matches a drop-table name case- and space-insensitively", () => {
    expect(findEnemyByName("  bUtChEr ")?.key).toBe(BUTCHER);
    expect(normalizeEnemyName("  Corrupted Butcher ")).toBe("corrupted butcher");
  });

  it("returns null for a name no codex entry claims", () => {
    expect(findEnemyByName("Techrot Motherboard Cluster")).toBeNull();
    expect(findEnemyByName("")).toBeNull();
  });

  it("carries the wiki spawn context through", () => {
    expect(findEnemyByType(AKKALAK_TURRET)).toMatchObject({
      name: "Akkalak Turret",
      faction: "grineer",
      planets: ["Earth"],
      tileSets: ["Plains of Eidolon"],
      type: "Turret",
      link: "Turret#Akkalak",
      baseLevel: 1,
      scans: 20,
    });
  });

  it("resolves an Eximus row to the enemy it belongs to", () => {
    expect(findEnemyByType(`${BUTCHER}#leader`)?.key).toBe(BUTCHER);
  });

  it("falls back to the name when the entry states no wiki link", () => {
    expect(findEnemyByType(BUTCHER)).toMatchObject({
      name: "Butcher",
      link: "Butcher",
      planets: [],
    });
  });

  it("still resolves export-only extras that carry no spawn data", () => {
    const conservation = findEnemyByName("Rogue Condroc");
    expect(conservation).toMatchObject({ planets: [], tileSets: [], missions: [] });
    expect(conservation?.name).toBe("Rogue Condroc");
  });
});
