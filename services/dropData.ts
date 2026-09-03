/** Flatten and cache WFCD drop tables for wiki search. */

import { createJsonCache } from "./jsonCache";
import { withScope } from "./logger";
import { correctedDropRarity } from "./relicRarity";

const log = withScope("dropData");

const INFO_URL = "https://drops.warframestat.us/data/info.json";
const ALL_URL = "https://drops.warframestat.us/data/all.json";

/** Which upstream table the row came from, so the UI can label its source.
 *  src/types/drops.ts mirrors this for the renderer. */
type DropKind =
  | "enemy"
  | "mission"
  | "bounty"
  | "relic"
  | "sortie"
  | "quest"
  | "syndicate"
  | "other";

export interface DropRow {
  /** Item that drops (e.g. "Vitus Essence"). */
  item: string;
  /** Where it drops (e.g. "Arbitrations, Rotation C"). */
  place: string;
  rarity: string;
  chance: number;
  kind: DropKind;
}

// Bumped when a row gains a field: an older cache has no kind, and the flatten
// is the only place that can derive one.
const CACHE_VERSION = 2;

interface CachePayload {
  version: number;
  hash: string;
  updatedAt: string;
  rows: DropRow[];
}

let rows: DropRow[] = [];
let loadedHash: string | null = null;
let refreshPromise: Promise<{ changed: boolean }> | null = null;

const cache = createJsonCache<CachePayload>("drop-data-cache.json", (raw) => {
  const parsed = raw as Partial<CachePayload>;
  if (parsed.version !== CACHE_VERSION) return null;
  if (!parsed.hash || !Array.isArray(parsed.rows)) return null;
  return {
    version: CACHE_VERSION,
    hash: parsed.hash,
    updatedAt: parsed.updatedAt || "",
    rows: parsed.rows,
  };
});

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return (await res.json()) as T;
}

// flattening

type Reward = {
  itemName?: string;
  item?: string;
  modName?: string;
  rarity?: string;
  chance?: number;
  rotation?: string;
  stage?: string;
  enemyName?: string;
  place?: string;
};

function rewardName(r: Reward): string | null {
  return r.itemName || r.item || r.modName || null;
}

function pushRow(
  out: DropRow[],
  item: string | null,
  place: string,
  r: Reward,
  kind: DropKind,
): void {
  if (!item || !place) return;
  const raw = typeof r.chance === "number" ? r.chance : Number(r.chance);
  const chance = Number.isFinite(raw) ? raw : 0;
  out.push({
    item,
    place,
    rarity: correctedDropRarity(place, chance, r.rarity || ""),
    chance,
    kind,
  });
}

/** Rewards may be a flat array or a {rotation: reward[]} map; emit either way. */
function pushRewardContainer(
  out: DropRow[],
  basePlace: string,
  rewards: Reward[] | Record<string, Reward[]>,
  kind: DropKind,
): void {
  const emit = (place: string, list: Reward[]): void => {
    for (const r of list) {
      let p = place;
      if (r.rotation) p += `, Rotation ${r.rotation}`;
      if (r.stage) p += ` (${r.stage})`;
      pushRow(out, rewardName(r), p, r, kind);
    }
  };
  if (Array.isArray(rewards)) {
    emit(basePlace, rewards);
  } else if (rewards && typeof rewards === "object") {
    for (const [rotation, list] of Object.entries(rewards)) {
      if (Array.isArray(list)) emit(`${basePlace}, Rotation ${rotation}`, list);
    }
  }
}

interface AllData {
  missionRewards?: Record<string, Record<string, { gameMode?: string; rewards?: unknown }>>;
  relics?: Array<{ tier?: string; relicName?: string; state?: string; rewards?: Reward[] }>;
  transientRewards?: Array<{ objectiveName?: string; rewards?: Reward[] }>;
  sortieRewards?: Reward[];
  keyRewards?: Array<{ keyName?: string; rewards?: Record<string, Reward[]> }>;
  modLocations?: Array<{ modName?: string; enemies?: Reward[] }>;
  blueprintLocations?: Array<{ itemName?: string; enemies?: Reward[] }>;
  enemyModTables?: Array<{ enemyName?: string; mods?: Reward[] }>;
  enemyBlueprintTables?: Array<{ enemyName?: string; items?: Reward[] }>;
  resourceByAvatar?: Array<{ source?: string; items?: Reward[] }>;
  sigilByAvatar?: Array<{ source?: string; items?: Reward[] }>;
  additionalItemByAvatar?: Array<{ source?: string; items?: Reward[] }>;
  syndicates?: Record<string, Reward[]>;
  [key: string]: unknown;
}

const BOUNTY_KEYS = [
  "cetusBountyRewards",
  "solarisBountyRewards",
  "deimosRewards",
  "zarimanRewards",
  "entratiLabRewards",
  "hexRewards",
] as const;

function flatten(data: AllData): DropRow[] {
  const out: DropRow[] = [];

  // place -> rewards (rotations)
  for (const [planet, nodes] of Object.entries(data.missionRewards || {})) {
    for (const [node, info] of Object.entries(nodes || {})) {
      const place = `${node} (${planet})`;
      pushRewardContainer(out, place, (info?.rewards as Reward[]) || [], "mission");
    }
  }
  for (const relic of data.relics || []) {
    if (relic.state && relic.state !== "Intact") continue; // dedupe refinements
    const place = `${relic.tier} ${relic.relicName} Relic`;
    pushRewardContainer(out, place, relic.rewards || [], "relic");
  }
  for (const t of data.transientRewards || []) {
    pushRewardContainer(out, t.objectiveName || "Mission", t.rewards || [], "mission");
  }
  for (const r of data.sortieRewards || []) pushRow(out, rewardName(r), "Sortie", r, "sortie");
  for (const k of data.keyRewards || []) {
    pushRewardContainer(out, k.keyName || "Quest", k.rewards || {}, "quest");
  }
  for (const key of BOUNTY_KEYS) {
    const list = data[key] as Array<{ bountyLevel?: string; rewards?: Record<string, Reward[]> }>;
    for (const b of list || [])
      pushRewardContainer(out, b.bountyLevel || "Bounty", b.rewards || {}, "bounty");
  }

  // item -> enemies
  for (const m of data.modLocations || []) {
    for (const e of m.enemies || []) pushRow(out, m.modName || null, e.enemyName || "", e, "enemy");
  }
  for (const b of data.blueprintLocations || []) {
    for (const e of b.enemies || [])
      pushRow(out, b.itemName || null, e.enemyName || "", e, "enemy");
  }

  // enemy -> items
  for (const e of data.enemyModTables || []) {
    for (const m of e.mods || []) pushRow(out, rewardName(m), e.enemyName || "", m, "enemy");
  }
  for (const e of data.enemyBlueprintTables || []) {
    for (const it of e.items || []) pushRow(out, rewardName(it), e.enemyName || "", it, "enemy");
  }
  // "byAvatar" tables are keyed by enemy too; a handful of prop sources ride
  // along and just resolve to no codex entry in the detail panel.
  for (const key of ["resourceByAvatar", "sigilByAvatar", "additionalItemByAvatar"] as const) {
    for (const s of data[key] || []) {
      for (const it of s.items || []) pushRow(out, rewardName(it), s.source || "", it, "enemy");
    }
  }

  // syndicates: already carry their own place
  for (const list of Object.values(data.syndicates || {})) {
    for (const r of list || []) pushRow(out, rewardName(r), r.place || "Syndicate", r, "syndicate");
  }

  // Upstream data has duplicate reward entries; collapse identical rows. An
  // enemy row wins a tie so the name stays clickable when a table lists it twice.
  const byKey = new Map<string, DropRow>();
  for (const row of out) {
    const key = `${row.item}|${row.place}|${row.rarity}|${row.chance}`;
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, row);
    else if (seen.kind !== "enemy" && row.kind === "enemy") byKey.set(key, row);
  }
  return [...byKey.values()];
}

// cache + load

export function loadFromDisk(): boolean {
  if (loadedHash) return true;
  const cached = cache.read();
  if (!cached) return false;
  rows = cached.rows;
  loadedHash = cached.hash;
  log.info(`Loaded ${rows.length} drop rows from cache (hash ${cached.hash.slice(0, 8)})`);
  return true;
}

export async function refreshFromUpstream(): Promise<{ changed: boolean }> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const info = await fetchJson<{ hash?: string }>(INFO_URL);
      const hash = info?.hash || "";
      if (hash && hash === loadedHash) {
        log.info("Drop data up to date");
        return { changed: false };
      }
      const all = await fetchJson<AllData>(ALL_URL);
      const next = flatten(all);
      rows = next;
      loadedHash = hash;
      cache.write({
        version: CACHE_VERSION,
        hash,
        updatedAt: new Date().toISOString(),
        rows: next,
      });
      log.info(`Drop data refreshed: ${next.length} rows (hash ${hash.slice(0, 8)})`);
      return { changed: true };
    } catch (err) {
      log.warn("Drop data refresh failed", err);
      return { changed: false };
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function ensureLoaded(): Promise<void> {
  if (loadedHash) return;
  if (loadFromDisk()) return;
  await refreshFromUpstream();
}

type DropSearchMode = "item" | "place";

interface DropSearchResult {
  rows: DropRow[];
  total: number;
}

/** Substring search by item (default) or place, ranked: prefix > word-start > contains. */
export function searchDrops(
  query: string,
  mode: DropSearchMode = "item",
  limit = 300,
): DropSearchResult {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  if (!q) return { rows: [], total: 0 };

  const scored: Array<{ row: DropRow; score: number }> = [];
  for (const row of rows) {
    const field = (mode === "place" ? row.place : row.item).toLowerCase();
    const idx = field.indexOf(q);
    if (idx < 0) continue;
    const score = idx === 0 ? 0 : /\s/.test(field[idx - 1] || "") ? 1 : 2;
    scored.push({ row, score });
  }

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      b.row.chance - a.row.chance ||
      a.row.item.localeCompare(b.row.item) ||
      a.row.place.localeCompare(b.row.place),
  );

  return { rows: scored.slice(0, limit).map((s) => s.row), total: scored.length };
}

export function flattenForTest(data: unknown): DropRow[] {
  return flatten(data as AllData);
}

export function setRowsForTest(testRows: DropRow[]): void {
  rows = testRows;
  loadedHash = "test";
}
