import { CODEX_EXTRA_INFO, CODEX_SCAN_REQUIREMENTS } from "../../data/codexScanRequirements.js";

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

export function normalizeEnemyName(name: string): string {
  return name.trim().toLowerCase();
}

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

// null marks a name two entries claim; the wiki row wins over an export extra,
// so only a collision inside one table is unusable.
let byName: Map<string, string | null> | null = null;

function nameIndex(): Map<string, string | null> {
  if (byName) return byName;
  const index = new Map<string, string | null>();
  for (const [key, entry] of Object.entries(CODEX_SCAN_REQUIREMENTS)) {
    const name = normalizeEnemyName(entry.name);
    index.set(name, index.has(name) ? null : key);
  }
  for (const [key, entry] of Object.entries(CODEX_EXTRA_INFO)) {
    if (!entry.name) continue;
    const name = normalizeEnemyName(entry.name);
    if (!index.has(name)) index.set(name, key);
  }
  byName = index;
  return index;
}

/** Codex path lookup; an Eximus row resolves to the enemy it belongs to. */
export function findEnemyByType(type: string): EnemyInfo | null {
  const base = type.endsWith(LEADER_SUFFIX) ? type.slice(0, -LEADER_SUFFIX.length) : type;
  return fromRequirement(base) ?? fromExtra(base);
}

/** Display-name lookup for callers that only have the drop table's spelling. */
export function findEnemyByName(name: string): EnemyInfo | null {
  const key = nameIndex().get(normalizeEnemyName(name));
  if (!key) return null;
  return fromRequirement(key) ?? fromExtra(key);
}
