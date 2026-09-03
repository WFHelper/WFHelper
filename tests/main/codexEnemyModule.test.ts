import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain build script module, no type declarations
import { buildFactionPlanets } from "../../scripts/codex-scans/factionRegions.mjs";
// @ts-expect-error -- plain build script module, no type declarations
import { parseEntries } from "../../scripts/codex-scans/parseEnemyModule.mjs";

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
