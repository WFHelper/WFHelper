import {
  CODEX_EXTRA_INFO,
  CODEX_FACTION_PLANETS,
  CODEX_SCAN_REQUIREMENTS,
  CODEX_TILE_SET_PLANETS,
} from "../../data/codexScanRequirements.js";
import { normalizeEnemyName } from "./enemyName.js";

/** A codex entry flattened for display: wiki rows carry spawn context, DE-export
 *  extras carry only a name, icon and faction. */
export interface EnemyInfo {
  /** Codex internal path, which is also the key the scan join uses. */
  key: string;
  name: string;
  faction: string | null;
  /** Wiki filename or full mirror URL; enemyImageUrl resolves both. */
  image: string | null;
  scans: number | null;
  planets: string[];
  tileSets: string[];
  missions: string[];
  type: string | null;
  description: string | null;
  /** Wiki page to open, name when the entry states none. May carry a #fragment. */
  link: string;
  baseLevel: number | null;
}

/** CodexPanel appends this to the type of an Eximus row, which is not its own
 *  wiki entry, so the lookup falls back to the base enemy. */
const LEADER_SUFFIX = "#leader";

function fromRequirement(key: string): EnemyInfo | null {
  const entry = CODEX_SCAN_REQUIREMENTS[key];
  if (!entry) return null;
  return {
    key,
    name: entry.name,
    faction: entry.faction ?? null,
    image: entry.image ?? null,
    scans: entry.scans ?? null,
    planets: entry.planets ?? [],
    tileSets: entry.tileSets ?? [],
    missions: entry.missions ?? [],
    type: entry.type ?? null,
    description: entry.description ?? null,
    link: entry.link ?? entry.name,
    baseLevel: entry.baseLevel ?? null,
  };
}

function fromExtra(key: string): EnemyInfo | null {
  const entry = CODEX_EXTRA_INFO[key];
  if (!entry?.name) return null;
  return {
    key,
    name: entry.name,
    faction: entry.faction ?? null,
    image: entry.icon ?? null,
    scans: entry.scans ?? null,
    planets: [],
    tileSets: [],
    missions: [],
    type: null,
    description: null,
    link: entry.name,
    baseLevel: null,
  };
}

type NameIndex = Map<string, string | null>;

const NON_ENEMY_FACTIONS: ReadonlySet<string> = new Set(["lore", "objects"]);

// null marks a name two entries claim; the wiki row wins over an export extra,
// so only a collision inside one table is unusable.
function buildNameIndex(enemiesOnly: boolean): NameIndex {
  const index: NameIndex = new Map();
  for (const [key, entry] of Object.entries(CODEX_SCAN_REQUIREMENTS)) {
    const name = normalizeEnemyName(entry.name);
    index.set(name, index.has(name) ? null : key);
  }
  for (const [key, entry] of Object.entries(CODEX_EXTRA_INFO)) {
    if (!entry.name || (enemiesOnly && NON_ENEMY_FACTIONS.has(entry.faction))) continue;
    const name = normalizeEnemyName(entry.name);
    if (!index.has(name)) index.set(name, key);
  }
  return index;
}

let byName: NameIndex | null = null;
let enemyByName: NameIndex | null = null;

function infoForKey(key: string | null | undefined): EnemyInfo | null {
  if (!key) return null;
  return fromRequirement(key) ?? fromExtra(key);
}

/** Codex path lookup; an Eximus row resolves to the enemy it belongs to. */
export function findEnemyByType(type: string): EnemyInfo | null {
  const base = type.endsWith(LEADER_SUFFIX) ? type.slice(0, -LEADER_SUFFIX.length) : type;
  const info = fromRequirement(base) ?? fromExtra(base);
  if (info && type.endsWith(LEADER_SUFFIX)) {
    info.scans =
      CODEX_SCAN_REQUIREMENTS[base]?.eximusScans ?? CODEX_EXTRA_INFO[base]?.eximusScans ?? null;
  }
  return info;
}

/** Display-name lookup for callers that only have the drop table's spelling. */
export function findEnemyByName(name: string): EnemyInfo | null {
  byName ??= buildNameIndex(false);
  return infoForKey(byName.get(normalizeEnemyName(name)));
}

/** Shorter than this a partial name matches half the codex, so it stays unresolved. */
const MIN_PARTIAL_LENGTH = 3;

function soleMatch(index: NameIndex, matches: (name: string) => boolean): EnemyInfo | null {
  let found: string | null = null;
  for (const [name, key] of index) {
    if (!matches(name)) continue;
    if (key === null || (found !== null && found !== key)) return null;
    found = key;
  }
  return infoForKey(found);
}

/** Lookup for a name the user typed rather than copied: the exact enemy first,
 *  then a sole prefix, then a sole substring. Several candidates resolve to
 *  nothing, so a search never claims an enemy it only guessed. An exact lore
 *  fragment or object name (every planet is one) resolves to nothing too. */
export function findEnemyByPartialName(name: string): EnemyInfo | null {
  byName ??= buildNameIndex(false);
  enemyByName ??= buildNameIndex(true);
  const index = enemyByName;
  const query = normalizeEnemyName(name);
  if (index.has(query)) return infoForKey(index.get(query));
  if (byName.has(query) || query.length < MIN_PARTIAL_LENGTH) return null;
  return (
    soleMatch(index, (entry) => entry.startsWith(query)) ??
    soleMatch(index, (entry) => entry.includes(query))
  );
}

/** Planets the enemy's faction holds on the star chart, as an inferred stand-in
 *  for entries the wiki states no spawn context for. Empty when it states any,
 *  so the exact wiki lists always win. */
export function factionSpawnPlanets(info: EnemyInfo | null): string[] {
  if (!info?.faction) return [];
  if (info.planets.length > 0 || info.tileSets.length > 0 || info.missions.length > 0) return [];
  return CODEX_FACTION_PLANETS[info.faction] ?? [];
}

/** Planets the entry's tilesets sit on, for the entries the wiki gives a tileset
 *  but no planet list. Empty when the entry states its own planets, so the exact
 *  wiki list always wins. */
export function tileSetSpawnPlanets(info: EnemyInfo | null): string[] {
  if (!info || info.planets.length > 0) return [];
  const planets = new Set<string>();
  for (const tileSet of info.tileSets) {
    for (const planet of CODEX_TILE_SET_PLANETS[tileSet] ?? []) planets.add(planet);
  }
  return [...planets].sort((a, b) => a.localeCompare(b));
}
