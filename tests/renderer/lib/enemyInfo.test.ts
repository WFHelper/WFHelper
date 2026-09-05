import { describe, expect, it } from "vitest";

import {
  factionSpawnPlanets,
  findEnemyByName,
  findEnemyByType,
  tileSetSpawnPlanets,
} from "../../../src/lib/enemies/enemyInfo";
import { normalizeEnemyName } from "../../../src/lib/enemies/enemyName";

const BUTCHER = "/Lotus/Types/Enemies/Grineer/AIWeek/BladeSawman";
// Carries every spawn field the wiki module can state, including a #fragment link.
const AKKALAK_TURRET = "/Lotus/Types/Enemies/Grineer/Eidolon/EidolonAutoTurretAgent";
// The wiki states no location at all for it, which is what sent a user asking.
const CORRUPTED_BUTCHER = "/Lotus/Types/Enemies/Orokin/OrokinBladeSawman";
// Two tilesets, no Planets list: the case the tileset fallback exists for.
const JUNO_OXIUM_OSPREY = "/Lotus/Types/Enemies/Corpus/CorpusShipRemastered/ShipOspreyOxiumAgent";
// One of its two tilesets is Murex, which no star-chart node covers.
const AEROLYST = "/Lotus/Types/Enemies/Sentients/Aerolyst/SentientAerolystAgent";

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

describe("factionSpawnPlanets", () => {
  it("stays out of the way when the wiki states any spawn context", () => {
    expect(factionSpawnPlanets(findEnemyByType(AKKALAK_TURRET))).toEqual([]);
  });

  it("names the faction's star-chart planets when the wiki states none", () => {
    expect(factionSpawnPlanets(findEnemyByType(CORRUPTED_BUTCHER))).toEqual([
      "Dark Refractory, Deimos",
      "Duviri",
      "Lua",
      "Void",
    ]);
    expect(factionSpawnPlanets(findEnemyByType(BUTCHER))).toContain("Ceres");
  });

  it("returns nothing for a faction the star chart never tags", () => {
    expect(factionSpawnPlanets(findEnemyByName("Rogue Condroc"))).toEqual([]);
    expect(factionSpawnPlanets(null)).toEqual([]);
  });
});

describe("tileSetSpawnPlanets", () => {
  it("unions the planets of every tileset the entry names", () => {
    expect(tileSetSpawnPlanets(findEnemyByType(JUNO_OXIUM_OSPREY))).toEqual([
      "Eris",
      "Europa",
      "Jupiter",
      "Mars",
      "Neptune",
      "Phobos",
      "Pluto",
      "Venus",
      "Zariman",
    ]);
  });

  it("skips a tileset no star-chart node covers", () => {
    expect(tileSetSpawnPlanets(findEnemyByType(AEROLYST))).toEqual(["Earth"]);
  });

  it("stays out of the way when the entry states its own planets", () => {
    expect(tileSetSpawnPlanets(findEnemyByType(AKKALAK_TURRET))).toEqual([]);
  });

  it("returns nothing for an entry with no tilesets at all", () => {
    expect(tileSetSpawnPlanets(findEnemyByType(CORRUPTED_BUTCHER))).toEqual([]);
    expect(tileSetSpawnPlanets(findEnemyByName("Rogue Condroc"))).toEqual([]);
    expect(tileSetSpawnPlanets(null)).toEqual([]);
  });
});
