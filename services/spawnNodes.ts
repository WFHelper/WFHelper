// Star-chart nodes as enemy spawn locations for the enemy spawn panel. DE's region
// table names each node's planet, mission, faction and level range; its level path
// names the tileset.

import type { SpawnNode } from "../config/shared/spawnNodeTypes";
import { getGameLocale } from "./gameLocale";
import { withScope } from "./logger";
import {
  loadRegionTranslation,
  localizedDictValue,
  missionLabel,
  resolveDict,
  type RegionTranslation,
} from "./regionNames";

const log = withScope("spawnNodes");

/** The codex partition of scripts/codex-scans/factionRegions.mjs, which a test
 *  keeps equal. Tenno, Duviri and unaffiliated nodes have no codex faction. */
export const REGION_FACTION_KEYS: Readonly<Record<string, string>> = {
  FC_GRINEER: "grineer",
  FC_CORPUS: "corpus",
  FC_INFESTATION: "infestation",
  FC_OROKIN: "orokin",
  FC_SENTIENT: "sentient",
  FC_MITW: "themurmur",
  FC_TECHROT: "techrot",
  FC_SCALDRA: "scaldra",
};

const LEVEL_ROOT = "/Lotus/Levels/";

// Level path under LEVEL_ROOT to the wiki tileset name; the longest prefix wins.
// null marks levels that hold no enemy spawns the codex lists: hubs, relays,
// conclave, quest and event levels.
const LEVEL_TILE_SETS: ReadonlyArray<readonly [string, string | null]> = [
  ["Proc/Corpus/CorpusGasBoss", "Corpus Gas City"],
  ["Proc/Corpus/CorpusGasCity", "Corpus Gas City"],
  ["Proc/Corpus/CorpusIcePlanet", "Corpus Ice Planet"],
  ["Proc/Corpus/CorpusOutpost", "Corpus Outpost"],
  ["Proc/Corpus/CorpusShip", "Corpus Ship"],
  ["Proc/EntratiLab/EntratiLab", "Albrecht's Laboratories"],
  ["Proc/EntratiLab/EntratiVoidVault", "Albrecht's Laboratories"],
  ["Proc/EntratiLab/EntratiSecretLabNecralisk", null],
  ["Proc/Grineer/GrineerAsteroid", "Grineer Asteroid"],
  ["Proc/Grineer/GrineerForest", "Grineer Forest"],
  ["Proc/Grineer/GrineerFortress", "Grineer Asteroid Fortress"],
  ["Proc/Grineer/GrineerGalleon", "Grineer Galleon"],
  ["Proc/Grineer/GrineerOcean", "Grineer Sealab"],
  ["Proc/Grineer/GrineerSettlement", "Grineer Settlement"],
  ["Proc/Grineer/GrineerShipyards", "Grineer Shipyard"],
  ["Proc/Infestation/InfestedCorpusShip", "Infested Ship"],
  ["Proc/Infestation/InfestedMicroplanetLandscape", "Cambion Drift"],
  ["Proc/Orokin/OrokinMoon", "Orokin Moon"],
  ["Proc/Orokin/OrokinTower", "Orokin Tower"],
  ["Proc/Orokin/OrokinTowerDerelict", "Orokin Derelict"],
  ["Proc/Zariman/Zariman", "Zariman (Tileset)"],
  ["Proc/Zariman/ZarimanHub", null],
  ["Proc/CivilianHubs/EidolonLandscape", "Plains of Eidolon"],
  ["Proc/CivilianHubs/VenusLandscape", "Orb Vallis"],
  ["Proc/CivilianHubs/OstronTown", null],
  ["Proc/CivilianHubs/SolarisUnitedTown", null],
  ["Proc/Space/SpaceGrineer", "Free Space"],
  ["SpaceBattles/TR", "Corpus Ship (Archwing)"],
  ["Railjack/Proc/", "Free Space"],
  ["KelaArenas/OceanArena", "Grineer Sealab"],
  ["KelaArenas/ShipyardsArena", "Grineer Shipyard"],
  ["Proc/JadeShadows/JSStalkerCaveHub", "Stalker's Lair"],
  ["Proc/TauPrequel/", "Perita"],
  // The path names no tileset. DE's tileset field says Corpus Outpost, which the
  // wiki places on no Mars node; its node table says Grineer Settlement.
  ["Proc/LastWish/LastWishDefense", "Grineer Settlement"],
  ["Proc/Hub/", null],
  ["Proc/Duviri/", null],
  ["Proc/Vania/", "H\u00f6llvania"],
  ["1999/Railjack/", null],
  ["DarkSectors/", null],
  ["DevilTower/", null],
  ["FiveFates/", null],
  ["HarrowQuest/", null],
  ["Muse/Proc/", null],
  ["NokkoColony/Proc/", null],
  ["PVP/", null],
];

const LEVEL_PREFIXES = [...LEVEL_TILE_SETS].sort((a, b) => b[0].length - a[0].length);

/** Nodes DE ships without a level path, plus per-node overrides of the path map. */
const NODE_TILE_SETS = new Map<string, string | null>([
  ["SolNode701", "Infested Ship"],
  ["SolNode705", "Infested Ship"],
  ["CrewBattleNode560", "Free Space"],
  ["CrewBattleNode561", "Free Space"],
  // The visible Index node stands in for the three hidden risk tiers, which DE
  // names in capitals.
  ["EventNode763", "The Index"],
  ["SolNode761", null],
  ["SolNode762", null],
  ["SolNode763", null],
  ["JadeShadows2HUB", null],
]);

/** Wiki tileset of a node, null for a level that holds no codex spawns, and
 *  undefined for one neither table knows yet. */
export function regionTileSet(nodeId: string, levelOverride: unknown): string | null | undefined {
  if (NODE_TILE_SETS.has(nodeId)) return NODE_TILE_SETS.get(nodeId);
  if (typeof levelOverride !== "string" || !levelOverride.startsWith(LEVEL_ROOT)) return undefined;
  const level = levelOverride.slice(LEVEL_ROOT.length);
  return LEVEL_PREFIXES.find(([prefix]) => level.startsWith(prefix))?.[1];
}

function codexFactions(factions: readonly unknown[]): string[] {
  const keys: string[] = [];
  for (const faction of factions) {
    const key = typeof faction === "string" ? REGION_FACTION_KEYS[faction] : undefined;
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function buildSpawnNodes(translation: RegionTranslation): SpawnNode[] {
  const rows: SpawnNode[] = [];
  const unknownLevels: string[] = [];
  for (const [nodeId, region] of Object.entries(translation.regions)) {
    const tileSet = regionTileSet(nodeId, region.levelOverride);
    if (tileSet === undefined) unknownLevels.push(nodeId);
    if (!tileSet) continue;
    const factionKeys = codexFactions([region.faction, region.secondaryFaction]);
    const nodeEn = resolveDict(translation.dict, region.name);
    const planetEn = resolveDict(translation.dict, region.systemName);
    const { systemIndex, minEnemyLevel, maxEnemyLevel } = region;
    if (factionKeys.length === 0 || !nodeEn || !planetEn) continue;
    if (typeof systemIndex !== "number") continue;
    if (typeof minEnemyLevel !== "number" || typeof maxEnemyLevel !== "number") continue;
    rows.push({
      nodeId,
      node: localizedDictValue(region.name) ?? nodeEn,
      nodeEn,
      planet: localizedDictValue(region.systemName) ?? planetEn,
      planetEn,
      planetIndex: systemIndex,
      missionKey: typeof region.missionType === "string" ? region.missionType : "",
      mission: missionLabel(translation, {
        ...region,
        missionName: localizedDictValue(region.missionName) ?? region.missionName,
      }),
      missionEn: missionLabel(translation, region),
      factionKeys,
      minLevel: minEnemyLevel,
      maxLevel: maxEnemyLevel,
      tileSet,
      darkSector: region.darkSectorData !== undefined,
    });
  }
  if (unknownLevels.length > 0) {
    log.warn(`no tileset known for ${unknownLevels.length} nodes: ${unknownLevels.join(", ")}`);
  }
  return rows;
}

let cached: { locale: string; nodes: SpawnNode[] } | null = null;

/** The node catalog in the current game language, rebuilt when it changes. */
export function getSpawnNodes(): SpawnNode[] {
  const locale = getGameLocale();
  if (cached?.locale !== locale) {
    cached = { locale, nodes: buildSpawnNodes(loadRegionTranslation()) };
  }
  return cached.nodes;
}
