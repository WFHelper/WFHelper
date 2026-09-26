import type { SpawnNode } from "../../../config/shared/spawnNodeTypes.js";
import type { EnemyInfo } from "./enemyInfo.js";

/** Rows the node table shows before its "show all" toggle. */
export const SPAWN_NODE_PREVIEW = 12;

// Codex spellings the star chart writes differently, keyed lowercase.
const PLANET_ALIASES = new Map([
  ["zariman ten zero", "zariman"],
  ["perita", "dark refractory, deimos"],
]);
const TILE_SET_ALIASES = new Map([["kuva fortress", "grineer asteroid fortress"]]);

const plainKey = (value: string): string => value.trim().toLowerCase();

const planetKey = (value: string): string => {
  const key = plainKey(value);
  return PLANET_ALIASES.get(key) ?? key;
};

const tileSetKey = (value: string): string => {
  const key = plainKey(value);
  return TILE_SET_ALIASES.get(key) ?? key;
};

/** Mission lists mix mission types ("Dark Sector Excavation", "Orphix (Mission)")
 *  with node names ("War (Node)") and the British "Defence". */
const missionKey = (value: string): string =>
  plainKey(value)
    .replace(/^dark sector\s+/, "")
    .replace(/\s*\((?:mission|node|dark sector)\)$/, "")
    .replace(/defence/g, "defense");

// Codex mission wording no star-chart name matches, keyed by missionKey. A target
// is a mission key, a DE mission enum or a node id; only mission keys are
// lowercase, so the three share one set without colliding.
const MISSION_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ["rathuum", ["arena"]],
  ["the index", ["EventNode763"]],
  ["stage defense", ["SolNode858"]],
  ["cetus bounty", ["SolNode228"]],
  ["cetus bounties", ["SolNode228"]],
  ["fortuna bounty", ["SolNode129"]],
  ["orb vallis bounty", ["SolNode129"]],
  ["profit-taker bounty", ["SolNode129"]],
  ["necralisk bounty", ["SolNode229"]],
]);

// Game modes, targeted like the aliases. The codex lists a mode beside the
// missions played in it ("Empyrean", "Volatile"), so a mode narrows the other
// names instead of adding every node it holds.
const MISSION_MODES: ReadonlyMap<string, readonly string[]> = new Map([
  ["empyrean", ["MT_RAILJACK"]],
  [
    "archwing",
    [
      "SolNode902",
      "SolNode903",
      "SolNode904",
      "SolNode905",
      "SolNode906",
      "SolNode907",
      "SolNode908",
      "SettlementNode10",
    ],
  ],
]);

const nodeMissionKeys = (node: SpawnNode): string[] => [
  missionKey(node.missionEn),
  missionKey(node.nodeEn),
  node.missionKey,
  node.nodeId,
];

const namedBy = (node: SpawnNode, keys: ReadonlySet<string>): boolean =>
  nodeMissionKeys(node).some((key) => keys.has(key));

/** The listed keys the star chart knows, or null when it knows none of them. */
function knownKeys(
  keys: readonly string[],
  known: ReadonlySet<string>,
): ReadonlySet<string> | null {
  const found = new Set(keys.filter((key) => known.has(key)));
  return found.size > 0 ? found : null;
}

function byStarChart(a: SpawnNode, b: SpawnNode): number {
  return (
    a.planetIndex - b.planetIndex ||
    a.planetEn.localeCompare(b.planetEn) ||
    a.minLevel - b.minLevel ||
    a.nodeEn.localeCompare(b.nodeEn)
  );
}

/** Star-chart nodes of the enemy's faction that fit every spawn list it states.
 *  A planet or tileset no node carries is ignored. A mission list that names no
 *  node or mission type at all (a quest, raid or event) empties the table, as
 *  does an entry that names no known place. */
export function spawnNodesFor(info: EnemyInfo | null, catalog: readonly SpawnNode[]): SpawnNode[] {
  const faction = info?.faction;
  if (!info || !faction) return [];
  const planets = knownKeys(
    info.planets.map(planetKey),
    new Set(catalog.map((node) => plainKey(node.planetEn))),
  );
  const tileSets = knownKeys(
    info.tileSets.map(tileSetKey),
    new Set(catalog.map((node) => plainKey(node.tileSet))),
  );
  const knownMissions = new Set(catalog.flatMap(nodeMissionKeys));
  const missionKeys = info.missions.map(missionKey);
  const modes = knownKeys(
    missionKeys.flatMap((key) => MISSION_MODES.get(key) ?? []),
    knownMissions,
  );
  const missions = knownKeys(
    missionKeys
      .filter((key) => !MISSION_MODES.has(key))
      .flatMap((key) => MISSION_ALIASES.get(key) ?? [key]),
    knownMissions,
  );
  if (missionKeys.length > 0 && !modes && !missions) return [];
  if (!planets && !tileSets && !modes && !missions) return [];
  return catalog
    .filter(
      (node) =>
        node.factionKeys.includes(faction) &&
        (!planets || planets.has(plainKey(node.planetEn))) &&
        (!tileSets || tileSets.has(plainKey(node.tileSet))) &&
        (!modes || namedBy(node, modes)) &&
        (!missions || namedBy(node, missions)),
    )
    .sort(byStarChart);
}
