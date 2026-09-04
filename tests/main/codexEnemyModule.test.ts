import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain build script module, no type declarations
import { buildFactionPlanets } from "../../scripts/codex-scans/factionRegions.mjs";
// @ts-expect-error -- plain build script module, no type declarations
import { parseEntries } from "../../scripts/codex-scans/parseEnemyModule.mjs";
// @ts-expect-error -- plain build script module, no type declarations
import * as tileSetPlanets from "../../scripts/codex-scans/tileSetPlanets.mjs";

interface ParsedEntry {
  internal: string;
  name: string;
  scans: number;
  faction: string;
  image: string | null;
  planets: string[] | null;
  tileSets: string[] | null;
  missions: string[] | null;
  type: string | null;
  description: string | null;
  link: string | null;
  baseLevel: number | null;
}

const parse = (lua: string): ParsedEntry[] => parseEntries(lua, "grineer") as ParsedEntry[];

const MODULE = `return {
	["Cannon Battery (Grineer)"] = {
		General = {
			Description = "Inflicts moderate damage at a fast rate",
			Faction = "Grineer",
			Image = "Blank.png",
			InternalName = "/Lotus/Types/Enemies/Grineer/CannonBatteryAgent",
			Introduced = "29.10",
			Link = "Turret#Grineer",
			Missions = { "Empyrean" },
			Name = "Cannon Battery",
			Planets = { "Earth Proxima", "Saturn Proxima", "Veil Proxima" },
			Scans = 10,
			TileSets = { "Free Space" },
			Type = "Turret",
			Weapons = { "" },
		},
		Stats = { Health = 8000, Shield = 0, Armor = 200, Affinity = 100, BaseLevel = 4 }
	},
	["Sparse Lancer"] = {
		General = {
			Faction = "Grineer",
			InternalName = "/Lotus/Types/Enemies/Grineer/SparseLancerAgent",
			Name = "Sparse Lancer",
			Scans = 20,
			Weapons = { "" },
		},
		Stats = { Health = 100 }
	},
	["No Scan Count"] = {
		General = {
			InternalName = "/Lotus/Types/Enemies/Grineer/NoScanAgent",
			Name = "No Scan Count",
		},
		Stats = { Health = 10 }
	},
}`;

describe("parseEnemyModule", () => {
  const entries = parse(MODULE);

  it("skips entries with no stated scan requirement", () => {
    expect(entries.map((entry) => entry.name)).toEqual(["Cannon Battery", "Sparse Lancer"]);
  });

  it("plucks the spawn context alongside the scan requirement", () => {
    expect(entries[0]).toEqual({
      internal: "/Lotus/Types/Enemies/Grineer/CannonBatteryAgent",
      name: "Cannon Battery",
      scans: 10,
      faction: "grineer",
      image: "Blank.png",
      planets: ["Earth Proxima", "Saturn Proxima", "Veil Proxima"],
      tileSets: ["Free Space"],
      missions: ["Empyrean"],
      type: "Turret",
      description: "Inflicts moderate damage at a fast rate",
      link: "Turret#Grineer",
      baseLevel: 4,
    });
  });

  it("leaves omitted fields null instead of inventing them", () => {
    expect(entries[1]).toMatchObject({
      name: "Sparse Lancer",
      planets: null,
      tileSets: null,
      missions: null,
      type: null,
      description: null,
      link: null,
      baseLevel: null,
      image: null,
    });
  });

  it("drops the empty strings the wiki uses as a placeholder list", () => {
    const lua = `return { ["X"] = { General = {
			InternalName = "/X", Name = "X", Scans = 3, Weapons = { "" }, Missions = { "" },
		} } }`;
    expect(parse(lua)[0].missions).toBeNull();
  });
});

const DICT = {
  "/Lotus/Language/Locations/Ceres": "Ceres",
  "/Lotus/Language/Locations/Earth": "Earth",
  "/Lotus/Language/Locations/Earth_SPACE": "Earth Proxima",
  "/Lotus/Language/Locations/Void": "Void",
};

const REGIONS = {
  SolNode1: { systemName: "/Lotus/Language/Locations/Ceres", nodeType: 0, faction: "FC_GRINEER" },
  SolNode2: { systemName: "/Lotus/Language/Locations/Earth", nodeType: 0, faction: "FC_GRINEER" },
  SolNode3: { systemName: "/Lotus/Language/Locations/Ceres", nodeType: 0, faction: "FC_GRINEER" },
  SolNode4: {
    systemName: "/Lotus/Language/Locations/Earth_SPACE",
    nodeType: 0,
    faction: "FC_GRINEER",
  },
  SolNode5: { systemName: "/Lotus/Language/Locations/Void", nodeType: 0, faction: "FC_OROKIN" },
  // Dark Sector: a real Infested mission, but nodeType 4 would put Infested on
  // nearly every planet, so it must not reach the hint.
  ClanNode0: { systemName: "/Lotus/Language/Locations/Earth", nodeType: 4, faction: "FC_INFESTED" },
  // Junction and relay: no faction at all.
  Junction0: { systemName: "/Lotus/Language/Locations/Earth", nodeType: 7 },
  // Tenno and Duviri have no codex partition.
  SolNode6: { systemName: "/Lotus/Language/Locations/Earth", nodeType: 0, faction: "FC_TENNO" },
  // A dict path with no translation is unusable as a label.
  SolNode7: { systemName: "/Lotus/Language/Locations/Unknown", nodeType: 0, faction: "FC_CORPUS" },
  SolNode8: { nodeType: 0, faction: "FC_CORPUS" },
};

describe("buildFactionPlanets", () => {
  const planets = buildFactionPlanets(REGIONS, DICT) as Record<string, string[]>;

  it("maps DE faction codes onto codex partition keys", () => {
    expect(Object.keys(planets).sort()).toEqual(["grineer", "orokin"]);
    expect(planets.orokin).toEqual(["Void"]);
  });

  it("dedupes and sorts, keeping Proxima systems separate", () => {
    expect(planets.grineer).toEqual(["Ceres", "Earth", "Earth Proxima"]);
  });

  it("tolerates an empty export", () => {
    expect(buildFactionPlanets(undefined, DICT)).toEqual({});
  });
});

type PlanetsByTileSet = Record<string, string[]>;

// MissionDetails writes one node per line, so the fixture keeps that shape.
const MISSIONS = `local MissionData = {
	["MissionTypes"] = { Defense = { Name = "Defense", Tileset = "not a node" } },
 	["MissionDetails"] = {
		{ Name = "Cinxia", Planet = "Ceres", Type = "Interception", Tileset = "Grineer Galleon", InternalName = "SolNode30" },
		{ Name = "Bode", Planet = "Ceres", Type = "Capture", Tileset = "Grineer Galleon", InternalName = "SolNode31" },
		{ Name = "Cambria", Planet = "Earth", Type = "Spy", Tileset = "Grineer Galleon", InternalName = "SolNode32" },
		{ Name = "Pago", Planet = "Kuva Fortress", Type = "Spy", Tileset = "Grineer Asteroid Fortress", InternalName = "SolNode747" },
		{ Name = "The Circuit", Planet = "Duviri", Type = "Free Roam", Tileset = "Duviri", InternalName = "SolNode238" },
		{ Name = "Teshub", Planet = "Void", Type = "Exterminate", Tileset = "Orokin Tower", InternalName = "SolNode95" },
		{ Name = "Pontis Tower", Planet = "Uranus Proxima", Type = "Hub", Tileset = "Orokin Tower", InternalName = "JadeShadows2HUB" },
		{ Name = "Larunda Relay", Planet = "Mercury", Type = "Relay", Tileset = "Relay", InternalName = "MercuryHUB" },
		{ Name = "Phorid Alert", Planet = "Invasion", Type = "Assassination", Tileset = "Grineer Asteroid", InternalName = "" },
		{ Name = "Sanctuary Onslaught", Planet = "Sanctuary Onslaught", Type = "Sanctuary Onslaught", Tileset = "", InternalName = "SolNode801" },
	},
}`;

describe("buildTileSetPlanets", () => {
  const byTileSet = tileSetPlanets.buildTileSetPlanets(MISSIONS) as PlanetsByTileSet;

  it("dedupes and sorts the planets each tileset's nodes sit on", () => {
    expect(byTileSet["Grineer Galleon"]).toEqual(["Ceres", "Earth"]);
  });

  it("keeps hubs, relays and off-chart nodes out of the map", () => {
    expect(byTileSet["Orokin Tower"]).toEqual(["Void"]);
    expect(byTileSet.Relay).toBeUndefined();
    expect(byTileSet["Grineer Asteroid"]).toBeUndefined();
    expect(Object.keys(byTileSet)).not.toContain("");
  });

  it("reads only the node list, not the mission-type table", () => {
    expect(byTileSet["not a node"]).toBeUndefined();
    expect(tileSetPlanets.buildTileSetPlanets("return {}")).toEqual({});
    expect(tileSetPlanets.buildTileSetPlanets(null)).toEqual({});
  });
});

describe("selectTileSetPlanets", () => {
  const select = (names: string[]) =>
    tileSetPlanets.selectTileSetPlanets(tileSetPlanets.buildTileSetPlanets(MISSIONS), names) as {
      planets: PlanetsByTileSet;
      unmapped: string[];
    };

  it("resolves the names the enemy modules spell differently", () => {
    const { planets } = select(["Kuva Fortress", "The Undercroft"]);
    expect(planets).toEqual({ "Kuva Fortress": ["Kuva Fortress"], "The Undercroft": ["Duviri"] });
  });

  it("reports a tileset no node covers instead of dropping it", () => {
    const { planets, unmapped } = select(["Murex", "Orokin Tower"]);
    expect(unmapped).toEqual(["Murex"]);
    expect(Object.keys(planets)).toEqual(["Orokin Tower"]);
  });

  it("dedupes and sorts the requested names", () => {
    const { planets } = select(["Orokin Tower", "Grineer Galleon", "Orokin Tower"]);
    expect(Object.keys(planets)).toEqual(["Grineer Galleon", "Orokin Tower"]);
  });
});
