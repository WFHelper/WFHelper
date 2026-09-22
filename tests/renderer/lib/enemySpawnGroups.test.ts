import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  findEnemyByType,
  tileSetSpawnPlanets,
  type EnemyInfo,
} from "../../../src/lib/enemies/enemyInfo";
import { enemySpawnGroups, TILE_SET_PLANETS_KEY } from "../../../src/lib/enemies/enemySpawnGroups";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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

describe("one spawn renderer", () => {
  // vitest cannot compile `.svelte`, so the guard is that both callers delegate:
  // a second copy of the group markup is what this feature was split to avoid.
  const source = (relativePath: string): string =>
    readFileSync(resolve(ROOT, relativePath), "utf8");
  const modal = source("src/modals/EnemyDetailModal.svelte");
  const wiki = source("src/views/WikiView.svelte");
  const list = source("src/components/enemies/EnemySpawnList.svelte");

  it("renders the spawn groups from the shared component in both places", () => {
    expect(modal).toContain("<EnemySpawnList");
    expect(wiki).toContain("<EnemySpawnList");
    expect(list).toContain("enemySpawnGroups");
  });

  it("leaves the label keys and the faction chips to that component", () => {
    for (const consumer of [modal, wiki]) {
      expect(consumer).not.toContain("enemy.planets");
      expect(consumer).not.toContain("enemy.tileSets");
      expect(consumer).not.toContain("enemy.missions");
      expect(consumer).not.toContain("data-enemy-faction-planets");
    }
  });

  it("keeps the modal selectors the codex specs drive", () => {
    expect(list).toContain("data-enemy-tileset-planets");
    expect(list).toContain("data-enemy-faction-planets");
  });
});
