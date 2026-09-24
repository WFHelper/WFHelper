import { describe, expect, it } from "vitest";

import {
  findEnemyByType,
  tileSetSpawnPlanets,
  type EnemyInfo,
} from "../../../src/lib/enemies/enemyInfo";
import { enemySpawnGroups, TILE_SET_PLANETS_KEY } from "../../../src/lib/enemies/enemySpawnGroups";

// Plains turret: planets and a tileset, no missions.
const AKKALAK_TURRET = "/Lotus/Types/Enemies/Grineer/Eidolon/EidolonAutoTurretAgent";
// Two tilesets, no Planets list: the entry the derived row exists for.
const JUNO_OXIUM_OSPREY = "/Lotus/Types/Enemies/Corpus/CorpusShipRemastered/ShipOspreyOxiumAgent";
// Every wiki list filled at once.
const GHOUL_TARGET = "/Lotus/Types/Enemies/CaptureTargets/CaptureTargetGhoulAgent";
// The wiki states no location at all for it.
const CORRUPTED_BUTCHER = "/Lotus/Types/Enemies/Orokin/OrokinBladeSawman";

function entry(type: string): EnemyInfo {
  const found = findEnemyByType(type);
  if (!found) throw new Error(`missing codex entry ${type}`);
  return found;
}

function groupsFor(type: string): Array<[string, string]> {
  const info = entry(type);
  return enemySpawnGroups(info, tileSetSpawnPlanets(info)).map((group) => [
    group.labelKey,
    group.values.join(", "),
  ]);
}

describe("enemySpawnGroups", () => {
  it("keeps the wiki lists in reading order", () => {
    expect(groupsFor(GHOUL_TARGET)).toEqual([
      ["enemy.planets", "Earth, Mars"],
      ["enemy.tileSets", "Plains of Eidolon, Grineer Settlement"],
      ["enemy.missions", "Cetus Bounty, Disruption"],
    ]);
  });

  it("places the derived planets under its own label, after the wiki planets", () => {
    expect(groupsFor(JUNO_OXIUM_OSPREY)).toEqual([
      [TILE_SET_PLANETS_KEY, "Eris, Europa, Jupiter, Mars, Neptune, Phobos, Pluto, Venus, Zariman"],
      ["enemy.tileSets", "Corpus Ship, Zariman (Tileset)"],
    ]);
  });

  it("drops the lists the entry leaves empty", () => {
    expect(groupsFor(AKKALAK_TURRET)).toEqual([
      ["enemy.planets", "Earth"],
      ["enemy.tileSets", "Plains of Eidolon"],
    ]);
  });

  it("returns nothing for an entry with no location at all", () => {
    expect(groupsFor(CORRUPTED_BUTCHER)).toEqual([]);
    expect(enemySpawnGroups(null, ["Earth"])).toEqual([]);
  });
});
