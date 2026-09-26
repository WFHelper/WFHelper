import { describe, expect, it } from "vitest";

import type { SpawnNode } from "../../../config/shared/spawnNodeTypes";
import { findEnemyByType, type EnemyInfo } from "../../../src/lib/enemies/enemyInfo";
import { spawnNodesFor } from "../../../src/lib/enemies/spawnNodes";

const SWARM_MUTALIST_MOA =
  "/Lotus/Types/Enemies/Infested/AiWeek/InfestedMoas/NaniteCloudBipedAgent";

type NodeSpec = Pick<SpawnNode, "nodeId" | "planetEn" | "planetIndex" | "missionEn"> &
  Partial<SpawnNode>;

function spawnNode(spec: NodeSpec): SpawnNode {
  return {
    node: spec.nodeId,
    nodeEn: spec.nodeId,
    planet: spec.planetEn,
    missionKey: "MT_TEST",
    mission: spec.missionEn,
    factionKeys: ["infestation"],
    minLevel: 1,
    maxLevel: 5,
    tileSet: "Infested Ship",
    darkSector: false,
    ...spec,
  };
}

// Node ids double as English names so a result reads as a list of nodes.
const CATALOG: SpawnNode[] = [
  spawnNode({
    nodeId: "Horend",
    planetEn: "Deimos",
    planetIndex: 16,
    missionEn: "Capture",
    minLevel: 12,
    tileSet: "Orokin Derelict",
  }),
  spawnNode({
    nodeId: "Isos",
    planetEn: "Eris",
    planetIndex: 10,
    missionEn: "Capture",
    minLevel: 32,
  }),
  spawnNode({
    nodeId: "Brugia",
    planetEn: "Eris",
    planetIndex: 10,
    missionEn: "Rescue",
    minLevel: 32,
  }),
  spawnNode({
    nodeId: "Saxis",
    planetEn: "Eris",
    planetIndex: 10,
    missionEn: "Exterminate",
    minLevel: 30,
  }),
  spawnNode({
    nodeId: "Cholistan",
    planetEn: "Europa",
    planetIndex: 12,
    missionEn: "Excavation",
    minLevel: 23,
    tileSet: "Corpus Ice Planet",
    darkSector: true,
  }),
  spawnNode({
    nodeId: "Tikal",
    planetEn: "Earth",
    planetIndex: 2,
    missionEn: "Excavation",
    minLevel: 6,
    tileSet: "Grineer Forest",
    darkSector: true,
  }),
  spawnNode({
    nodeId: "M Prime",
    planetEn: "Mercury",
    planetIndex: 0,
    missionEn: "Exterminate",
    tileSet: "Grineer Asteroid",
    factionKeys: ["infestation", "grineer"],
  }),
  spawnNode({
    nodeId: "Everest",
    planetEn: "Earth",
    planetIndex: 2,
    missionEn: "Excavation",
    tileSet: "Grineer Forest",
    factionKeys: ["grineer"],
  }),
  spawnNode({
    nodeId: "Mot",
    planetEn: "Void",
    planetIndex: 14,
    missionEn: "Survival",
    tileSet: "Orokin Tower",
    factionKeys: ["orokin"],
  }),
  spawnNode({
    nodeId: "Taveuni",
    planetEn: "Kuva Fortress",
    planetIndex: 18,
    missionEn: "Survival",
    tileSet: "Grineer Asteroid Fortress",
    factionKeys: ["grineer"],
  }),
  spawnNode({
    nodeId: "Kasio's Rest",
    planetEn: "Saturn Proxima",
    planetIndex: 5,
    missionKey: "MT_RAILJACK",
    missionEn: "Skirmish",
    tileSet: "Free Space",
    factionKeys: ["grineer"],
    minLevel: 20,
  }),
  spawnNode({
    nodeId: "Vodyanoi",
    planetEn: "Sedna",
    planetIndex: 11,
    missionEn: "Arena",
    tileSet: "Grineer Sealab",
    factionKeys: ["grineer"],
    minLevel: 85,
  }),
  spawnNode({
    nodeId: "Tethys",
    planetEn: "Saturn",
    planetIndex: 5,
    missionEn: "Assassination",
    tileSet: "Grineer Galleon",
    factionKeys: ["grineer"],
    minLevel: 30,
  }),
  spawnNode({
    nodeId: "Tuvul Commons",
    planetEn: "Zariman",
    planetIndex: 21,
    missionEn: "Void Cascade",
    tileSet: "Zariman (Tileset)",
    factionKeys: ["grineer"],
  }),
];

function enemy(spec: Partial<EnemyInfo>): EnemyInfo {
  return {
    key: "/Lotus/Types/Enemies/Test",
    name: "Test",
    faction: "grineer",
    image: null,
    scans: null,
    planets: [],
    tileSets: [],
    missions: [],
    type: null,
    description: null,
    link: "Test",
    baseLevel: null,
    ...spec,
  };
}

const ids = (info: EnemyInfo | null): string[] =>
  spawnNodesFor(info, CATALOG).map((row) => row.nodeId);

describe("spawnNodesFor", () => {
  it("lists the wiki's nodes for Swarm Mutalist MOA in star chart order", () => {
    const info = findEnemyByType(SWARM_MUTALIST_MOA);

    expect(info?.planets).toContain("Eris");
    expect(ids(info)).toEqual([
      "M Prime",
      "Tikal",
      "Saxis",
      "Brugia",
      "Isos",
      "Cholistan",
      "Horend",
    ]);
  });

  it("requires every stated list to match, each through any of its names", () => {
    expect(
      ids(enemy({ faction: "infestation", planets: ["Eris"], missions: ["Capture"] })),
    ).toEqual(["Isos"]);
    expect(
      ids(enemy({ faction: "infestation", tileSets: ["Infested Ship", "Orokin Derelict"] })),
    ).toEqual(["Saxis", "Brugia", "Isos", "Horend"]);
  });

  it("reads the codex spellings the star chart writes differently", () => {
    expect(ids(enemy({ tileSets: ["Kuva Fortress"] }))).toEqual(["Taveuni"]);
    expect(ids(enemy({ planets: ["Zariman Ten Zero"] }))).toEqual(["Tuvul Commons"]);
    expect(ids(enemy({ faction: "infestation", missions: ["Dark Sector Excavation"] }))).toEqual([
      "Tikal",
      "Cholistan",
    ]);
    expect(ids(enemy({ planets: ["Sedna"], missions: ["Rathuum"] }))).toEqual(["Vodyanoi"]);
  });

  it("matches a mission list entry that names a node", () => {
    expect(ids(enemy({ planets: ["Saturn"], missions: ["Tethys"] }))).toEqual(["Tethys"]);
    expect(ids(enemy({ missions: ["Tethys (Node)"] }))).toEqual(["Tethys"]);
  });

  it("ignores a name no node carries beside one that does", () => {
    expect(
      ids(
        enemy({
          faction: "infestation",
          planets: ["Eris", "The Descendia"],
          missions: ["Capture", "Stolen Dreams"],
        }),
      ),
    ).toEqual(["Isos"]);
    // A Proxima shares its planet's index and sorts after the planet itself.
    expect(ids(enemy({ tileSets: ["Free Space", "Grineer Galleon", "Murex"] }))).toEqual([
      "Tethys",
      "Kasio's Rest",
    ]);
  });

  it("narrows a game mode to the missions listed beside it", () => {
    expect(ids(enemy({ planets: ["Saturn Proxima"], missions: ["Empyrean"] }))).toEqual([
      "Kasio's Rest",
    ]);
    expect(ids(enemy({ missions: ["Empyrean", "Skirmish"] }))).toEqual(["Kasio's Rest"]);
    expect(ids(enemy({ missions: ["Empyrean", "Assassination"] }))).toEqual([]);
  });

  it("lists nothing when the star chart knows none of the stated missions", () => {
    expect(ids(enemy({ planets: ["Sedna"], missions: ["The Law of Retribution"] }))).toEqual([]);
    expect(
      ids(enemy({ tileSets: ["Grineer Galleon"], missions: ["Stolen Dreams", "Granum Void"] })),
    ).toEqual([]);
  });

  it("lists nothing for an entry that names no known place or no faction", () => {
    expect(ids(enemy({}))).toEqual([]);
    expect(ids(enemy({ planets: ["The Descendia"], missions: ["Cetus Bounty"] }))).toEqual([]);
    expect(ids(enemy({ faction: null, planets: ["Eris"] }))).toEqual([]);
    expect(ids(enemy({ faction: "narmer", planets: ["Eris"] }))).toEqual([]);
    expect(ids(null)).toEqual([]);
  });
});
