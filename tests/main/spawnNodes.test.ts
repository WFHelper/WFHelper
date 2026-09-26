import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error -- plain build script module, no type declarations
import { REGION_FACTION_KEYS as CODEX_BUILD_FACTION_KEYS } from "../../scripts/codex-scans/factionRegions.mjs";
import { readPepExport } from "../../services/bundledGameData";
import { DEFAULT_GAME_LOCALE, setGameLocale } from "../../services/gameLocale";
import { REGION_FACTION_KEYS, getSpawnNodes, regionTileSet } from "../../services/spawnNodes";
import {
  CODEX_SCAN_REQUIREMENTS,
  CODEX_TILE_SET_PLANETS,
} from "../../src/data/codexScanRequirements";
import { findEnemyByType } from "../../src/lib/enemies/enemyInfo";
import { spawnNodesFor } from "../../src/lib/enemies/spawnNodes";

type Region = { levelOverride?: unknown; nodeType?: unknown; darkSectorData?: unknown };

const REGIONS = readPepExport("ExportRegions") as Record<string, Region>;

// Tilesets no codex entry names, so the codex data carries no planets for them;
// the wiki mission table places each on these.
const UNNAMED_TILE_SET_PLANETS: Readonly<Record<string, readonly string[]>> = {
  "H\u00f6llvania": ["H\u00f6llvania"],
  "The Index": ["Neptune"],
};

function node(nodeId: string) {
  const found = getSpawnNodes().find((row) => row.nodeId === nodeId);
  if (!found) throw new Error(`no spawn node ${nodeId}`);
  return found;
}

afterEach(() => {
  setGameLocale(DEFAULT_GAME_LOCALE);
});

describe("spawn node catalog", () => {
  it("places every node DE ships in a tileset or the skip list", () => {
    const unclassified = Object.entries(REGIONS)
      .filter(([nodeId, region]) => regionTileSet(nodeId, region.levelOverride) === undefined)
      .map(([nodeId]) => nodeId);

    expect(Object.keys(REGIONS).length).toBeGreaterThan(300);
    expect(unclassified).toEqual([]);
  });

  it("puts each node on a planet the wiki lists for its tileset", () => {
    // The wiki writes that region without the "Deimos" of DE's system name.
    const wikiPlanet = (planet: string) =>
      planet === "Dark Refractory, Deimos" ? "Dark Refractory" : planet;
    const planetsOf = (tileSet: string) =>
      CODEX_TILE_SET_PLANETS[tileSet] ?? UNNAMED_TILE_SET_PLANETS[tileSet];
    const misplaced = getSpawnNodes()
      .filter((row) => !planetsOf(row.tileSet)?.includes(wikiPlanet(row.planetEn)))
      .map((row) => `${row.nodeEn} (${row.planetEn}): ${row.tileSet}`);

    expect(
      Object.keys(UNNAMED_TILE_SET_PLANETS).filter((name) => name in CODEX_TILE_SET_PLANETS),
    ).toEqual([]);
    expect(misplaced).toEqual([]);
  });

  it("reads the rows the wiki shows for Swarm Mutalist MOA", () => {
    expect(node("ClanNode3")).toMatchObject({
      node: "Tikal",
      planet: "Earth",
      mission: "Excavation",
      minLevel: 6,
      maxLevel: 16,
      tileSet: "Grineer Forest",
      darkSector: true,
    });
    expect(node("ClanNode7")).toMatchObject({
      node: "Cholistan",
      planet: "Europa",
      tileSet: "Corpus Ice Planet",
      darkSector: true,
    });
    expect(node("SolNode162")).toMatchObject({
      node: "Isos",
      planet: "Eris",
      missionKey: "MT_CAPTURE",
      mission: "Capture",
      minLevel: 32,
      maxLevel: 36,
      tileSet: "Infested Ship",
      darkSector: false,
      factionKeys: ["infestation"],
    });
    expect(node("SolNode153")).toMatchObject({ node: "Brugia", mission: "Rescue" });
    expect(node("SolNode706")).toMatchObject({
      node: "Horend",
      planet: "Deimos",
      minLevel: 12,
      maxLevel: 14,
      tileSet: "Orokin Derelict",
    });
  });

  it("marks as dark sectors exactly the nodes DE gives dark sector data", () => {
    for (const [nodeId, region] of Object.entries(REGIONS)) {
      expect(region.darkSectorData !== undefined, nodeId).toBe(region.nodeType === 4);
    }
  });

  it("partitions factions like the codex build and keeps unpartitioned nodes out", () => {
    expect(REGION_FACTION_KEYS).toEqual(CODEX_BUILD_FACTION_KEYS);
    // A crossfire node spawns both factions.
    expect(node("SolNode103").factionKeys).toEqual(["infestation", "grineer"]);
    // Testudo sits in a mapped tileset but carries no faction.
    expect(regionTileSet("SolNode720", REGIONS.SolNode720?.levelOverride)).toBe(
      "Albrecht's Laboratories",
    );
    expect(getSpawnNodes().some((row) => row.nodeId === "SolNode720")).toBe(false);
  });

  it("names nodes in the game language and keeps English for matching", () => {
    setGameLocale("de");
    expect(node("ClanNode3")).toMatchObject({
      planet: "Erde",
      planetEn: "Earth",
      mission: "Ausgrabung",
      missionEn: "Excavation",
    });

    setGameLocale(DEFAULT_GAME_LOCALE);
    expect(node("ClanNode3")).toMatchObject({ planet: "Earth", mission: "Excavation" });
  });
});

describe("codex entries on the node catalog", () => {
  const CODEX_KEYS = Object.keys(CODEX_SCAN_REQUIREMENTS);

  const rows = (key: string) => spawnNodesFor(findEnemyByType(key), getSpawnNodes());
  const rowIds = (key: string) => rows(key).map((row) => row.nodeId);
  const sortedIds = (key: string) => rowIds(key).sort();

  function keyNamed(name: string, faction?: string): string {
    const keys = CODEX_KEYS.filter((key) => {
      const entry = CODEX_SCAN_REQUIREMENTS[key];
      return entry?.name === name && (!faction || entry.faction === faction);
    });
    const [key] = keys;
    if (keys.length !== 1 || !key) throw new Error(`${keys.length} codex entries named ${name}`);
    return key;
  }

  const stating = (mission: string) =>
    CODEX_KEYS.filter((key) => CODEX_SCAN_REQUIREMENTS[key]?.missions?.includes(mission));

  it("keeps every entry's table to a plausible size", () => {
    // Corpus Tech, stated on eight planets, is the widest: 65 of 108 Corpus nodes.
    const oversized = CODEX_KEYS.filter((key) => rows(key).length > 70);

    expect(oversized).toEqual([]);
  });

  it("lists nothing for a quest, raid or event no node hosts", () => {
    for (const name of [
      "Errant Specter",
      "Specter Particles",
      "Razorback",
      "Disruptor Drone",
      "Arcane Boiler",
      "Deimos Swarm Mutalist MOA",
      "Deimos Undying Flyer",
      "Zeplen",
    ]) {
      expect(rowIds(keyNamed(name)), name).toEqual([]);
    }
  });

  it("finds the arena nodes of Rathuum and the Index", () => {
    expect(stating("Rathuum")).toHaveLength(9);
    for (const key of stating("Rathuum")) {
      expect(rowIds(key), key).toEqual(["SolNode190", "SolNode199", "SolNode183"]);
    }
    expect(stating("The Index")).toHaveLength(16);
    for (const key of stating("The Index")) {
      expect(sortedIds(key), key).toEqual(["EventNode763"]);
    }
  });

  it("keeps each bounty entry's landscape node", () => {
    const landscapes = {
      "Cetus Bounty": "SolNode228",
      "Cetus Bounties": "SolNode228",
      "Fortuna Bounty": "SolNode129",
      "Orb Vallis Bounty": "SolNode129",
      "Profit-Taker Bounty": "SolNode129",
      "Necralisk Bounty": "SolNode229",
    };
    let checked = 0;
    for (const [mission, nodeId] of Object.entries(landscapes)) {
      for (const key of stating(mission)) {
        const faction = CODEX_SCAN_REQUIREMENTS[key]?.faction ?? "";
        if (!node(nodeId).factionKeys.includes(faction)) continue;
        checked++;
        if (CODEX_SCAN_REQUIREMENTS[key]?.missions?.length === 1) {
          expect(rowIds(key), key).toEqual([nodeId]);
        } else {
          expect(rowIds(key), key).toContain(nodeId);
        }
      }
    }
    expect(checked).toBe(34);
  });

  it("narrows Empyrean and Archwing to the nodes of that mode", () => {
    for (const key of stating("Empyrean")) {
      for (const row of rows(key)) expect(row.missionKey, key).toBe("MT_RAILJACK");
    }
    expect(rows(keyNamed("Axio Engineer"))).toMatchObject([
      { nodeId: "CrewBattleNode524", missionKey: "MT_RAILJACK", missionEn: "Volatile" },
    ]);
    expect(rowIds(keyNamed("Shield-Hellion Dargyn"))).toEqual(["SolNode907"]);
    expect(rowIds(keyNamed("Dargyn"))).toEqual([
      "SolNode903",
      "SolNode904",
      "SolNode906",
      "SolNode907",
    ]);
  });

  it("lists the Techrot and Scaldra nodes of Hollvania", () => {
    const techrot = ["SolNode850", "SolNode852", "SolNode854"];
    const scaldra = [
      "SolNode851",
      "SolNode853",
      "SolNode855",
      "SolNode856",
      "SolNode857",
      "SolNode858",
    ];
    expect(sortedIds(keyNamed("Techrot Babau"))).toEqual(techrot);
    expect(sortedIds(keyNamed("Scaldra Flayer"))).toEqual(scaldra);
    expect(rowIds(keyNamed("Scaldra Screamer"))).toEqual(["SolNode858"]);
    expect(rowIds(keyNamed("H-09 Efervon Tank", "scaldra"))).toEqual(["SolNode856"]);
    // Only Scaldra holds the H-09 assassination, so the Techrot twin lists none.
    expect(rowIds(keyNamed("H-09 Efervon Tank", "techrot"))).toEqual([]);

    const hollvania = CODEX_KEYS.filter((key) =>
      CODEX_SCAN_REQUIREMENTS[key]?.planets?.includes("H\u00f6llvania"),
    );
    expect(hollvania).toHaveLength(20);
    expect(hollvania.filter((key) => rows(key).length > 0)).toHaveLength(18);
  });
});
