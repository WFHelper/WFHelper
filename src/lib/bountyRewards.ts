import { log } from "./log.js";
import { BOUNTY_FALLBACK_ICON_URLS } from "./assetUrls.js";
import { fetchWithTimeout } from "../../config/shared/fetchWithTimeout.js";
import { stripQuantityPrefix } from "../../config/shared/quantityPrefix.js";
import type { ItemDbEntry } from "../types/inventory.js";

const DROPS_BASE_URL = "https://drops.warframestat.us/data";
const BOUNTY_FETCH_TIMEOUT_MS = 15_000;

interface RawBountyReward {
  itemName: string;
  chance: number;
  rarity: string;
  stage: string;
}

interface RawBountyLevel {
  bountyLevel: string;
  rewards: Record<string, RawBountyReward[]>;
}

interface BountyRewardItem {
  itemName: string;
  chance: number;
  rarity: string;
}

interface BountyStageRewards {
  label: string;
  sortOrder: number;
  items: BountyRewardItem[];
}

// Credit and Endo names use local fallback icons before itemDb lookup.
function resolveRewardIconPath(
  itemName: string,
  nameToEntry?: Map<string, NameLookupEntry>,
): string | undefined {
  if (!itemName) return undefined;

  const stripped = stripQuantityPrefix(itemName).trim();
  const lowerStripped = stripped.toLowerCase();

  // Category overrides (by name pattern)
  if (/\bcredits?\b/i.test(stripped)) return BOUNTY_FALLBACK_ICON_URLS.credits;
  if (/\bendo\b/i.test(stripped)) return BOUNTY_FALLBACK_ICON_URLS.endo;

  if (nameToEntry) {
    const entry = nameToEntry.get(lowerStripped) ?? nameToEntry.get(itemName.toLowerCase());
    if (entry?.category === "Mod") return BOUNTY_FALLBACK_ICON_URLS.mod;
    if (entry?.imageUrl) return entry.imageUrl;
  }

  return undefined;
}

/** Map syndicateKey -> drops.warframestat.us file/rootKey (they share the same name) */
const SYNDICATE_FILE: Record<string, string> = {
  CetusSyndicate: "cetusBountyRewards",
  SolarisSyndicate: "solarisBountyRewards",
  EntratiSyndicate: "deimosRewards",
  ZarimanSyndicate: "zarimanRewards",
  HexSyndicate: "hexRewards",
  EntratiLabSyndicate: "entratiLabRewards",
};

/** Display-name aliases that map to the same internal key */
const SYNDICATE_ALIASES: Record<string, string> = {
  Ostrons: "CetusSyndicate",
  "Solaris United": "SolarisSyndicate",
  Entrati: "EntratiSyndicate",
  "The Holdfasts": "ZarimanSyndicate",
  "The Hex": "HexSyndicate",
  Cavia: "EntratiLabSyndicate",
};

/** World-state groups name a syndicate by tag or by display name, and both spell
 *  the same bounty; callers key their own tables off the tag this returns. */
export function canonicalSyndicateKey(syndicate: string): string {
  return SYNDICATE_ALIASES[syndicate] ?? syndicate;
}

function resolveDropsFile(syndicateKey: string): string | undefined {
  return SYNDICATE_FILE[canonicalSyndicateKey(syndicateKey)];
}

const RARITY_ORDER: Record<string, number> = {
  Legendary: 0,
  Rare: 1,
  Uncommon: 2,
  Common: 3,
};

// Promise-level cache: drops file name -> parsed bounty level data
const fileCache = new Map<string, Promise<RawBountyLevel[]>>();
// Result-level cache: "syndicateKey:minLevel-maxLevel:stageCount" -> stage rewards
const jobCache = new Map<string, Promise<BountyStageRewards[]>>();

// Cached name->entry map built from itemDb (includes category + imageUrl)
interface NameLookupEntry {
  imageUrl?: string;
  category?: string;
}
let _nameToEntryMap: Map<string, NameLookupEntry> | undefined;
let _lastItemDbRef: Record<string, ItemDbEntry> | undefined;

function getNameToEntryMap(
  itemDb?: Record<string, ItemDbEntry>,
): Map<string, NameLookupEntry> | undefined {
  if (!itemDb) return undefined;
  if (itemDb === _lastItemDbRef && _nameToEntryMap) return _nameToEntryMap;
  const m = new Map<string, NameLookupEntry>();
  for (const entry of Object.values(itemDb)) {
    if (entry.name) {
      const key = entry.name.toLowerCase();
      const existing = m.get(key);
      const imageUrl =
        entry.imageUrl && typeof entry.imageUrl === "string" ? entry.imageUrl : undefined;
      const category = entry.category ?? undefined;
      if (existing) {
        // Keep the best imageUrl - don't overwrite a good URL with nothing
        if (!existing.imageUrl && imageUrl) existing.imageUrl = imageUrl;
        if (!existing.category && category) existing.category = category;
      } else {
        const lookup: NameLookupEntry = {};
        if (imageUrl) lookup.imageUrl = imageUrl;
        if (category) lookup.category = category;
        m.set(key, lookup);
      }
    }
  }
  _lastItemDbRef = itemDb;
  _nameToEntryMap = m;
  return m;
}

async function fetchDropsFile(file: string, rootKey: string): Promise<RawBountyLevel[]> {
  const url = `${DROPS_BASE_URL}/${file}.json`;
  const resp = await fetchWithTimeout(url, BOUNTY_FETCH_TIMEOUT_MS);
  if (!resp.ok) {
    log.warn(`[BountyRewards] Failed to fetch ${url}: ${resp.status}`);
    if (resp.status === 429 || resp.status >= 500) {
      throw new Error(`Bounty rewards request failed: HTTP ${resp.status}`);
    }
    return [];
  }
  const json = (await resp.json()) as Record<string, unknown>;
  const data = json[rootKey];
  if (!Array.isArray(data)) {
    log.warn(`[BountyRewards] Unexpected structure in ${file}.json, key "${rootKey}" not found`);
    return [];
  }
  return data as RawBountyLevel[];
}

function getDropsData(file: string): Promise<RawBountyLevel[]> {
  const cached = fileCache.get(file);
  if (cached) return cached;

  const request = fetchDropsFile(file, file);
  fileCache.set(file, request);
  void request.catch(() => {
    if (fileCache.get(file) === request) fileCache.delete(file);
  });
  return request;
}

// Drop tables use the raw stage labels regardless of the bounty's actual length.
type DropTable = "FIRST" | "MID" | "PREFINAL" | "FINAL";

function classifyRawStage(stage: string): DropTable {
  if (/^Stage\s+1$/i.test(stage)) return "FIRST";
  if (/Final Stage/i.test(stage)) return "FINAL";
  if (/Stage\s+4\s+of\s+5/i.test(stage)) return "PREFINAL";
  return "MID";
}

/** Build the stage->drop-table mapping based on actual bounty stage count. */
function stageSequence(stageCount: number): { label: string; table: DropTable }[] {
  if (stageCount <= 1) return [{ label: "Bounty", table: "FINAL" }];
  if (stageCount === 2)
    return [
      { label: "Stage 1", table: "FIRST" },
      { label: "Stage 2", table: "FINAL" },
    ];
  if (stageCount === 3)
    return [
      { label: "Stage 1", table: "FIRST" },
      { label: "Stage 2", table: "MID" },
      { label: "Stage 3", table: "FINAL" },
    ];
  if (stageCount === 4)
    return [
      { label: "Stage 1", table: "FIRST" },
      { label: "Stage 2", table: "MID" },
      { label: "Stage 3", table: "MID" },
      { label: "Stage 4", table: "FINAL" },
    ];
  // 5+ stages: first, middle stages, prefinal, final
  const seq: { label: string; table: DropTable }[] = [{ label: "Stage 1", table: "FIRST" }];
  for (let i = 2; i < stageCount - 1; i++) {
    seq.push({ label: `Stage ${i}`, table: "MID" });
  }
  seq.push({ label: `Stage ${stageCount - 1}`, table: "PREFINAL" });
  seq.push({ label: `Stage ${stageCount}`, table: "FINAL" });
  return seq;
}

function matchBountyLevel(
  entries: RawBountyLevel[],
  enemyLevels: [number, number],
): RawBountyLevel | undefined {
  const [min, max] = enemyLevels;
  const isEvent = (bl: string) => /ghoul|plague star/i.test(bl);

  const matches = entries.filter((e) => {
    const m = e.bountyLevel.match(/Level\s+(\d+)\s*-\s*(\d+)/);
    if (!m) return false;
    return Number(m[1]) === min && Number(m[2]) === max;
  });

  return matches.find((e) => !isEvent(e.bountyLevel)) || matches[0];
}

function buildStageRewards(
  level: RawBountyLevel,
  stageCount: number,
  rotation?: string,
): BountyStageRewards[] {
  // Group rewards by drop table type (FIRST/MID/PREFINAL/FINAL)
  const tableMap = new Map<DropTable, Map<string, BountyRewardItem>>();

  // If a rotation is specified and has rewards, use only that rotation; otherwise merge all
  const rotKeys =
    rotation && Array.isArray(level.rewards[rotation]) && level.rewards[rotation].length > 0
      ? [rotation]
      : Object.keys(level.rewards);

  for (const key of rotKeys) {
    const rotRewards = level.rewards[key];
    if (!Array.isArray(rotRewards)) continue;
    for (const r of rotRewards) {
      const dt = classifyRawStage(r.stage);
      if (!tableMap.has(dt)) tableMap.set(dt, new Map());
      const items = tableMap.get(dt)!;

      const existing = items.get(r.itemName);
      if (!existing || r.chance > existing.chance) {
        // Icons are resolved at render time via resolveRewardIcon(itemName,
        // itemDb) - not baked here (this result is cached and has no itemDb).
        items.set(r.itemName, {
          itemName: r.itemName,
          chance: r.chance,
          rarity: r.rarity,
        });
      }
    }
  }

  // Map actual stages to drop tables based on stageCount
  const sequence = stageSequence(stageCount);
  const result: BountyStageRewards[] = [];

  for (let i = 0; i < sequence.length; i++) {
    const { label, table } = sequence[i];
    const itemMap = tableMap.get(table);
    if (!itemMap || itemMap.size === 0) continue;

    const items = [...itemMap.values()].sort((a, b) => {
      const ra = RARITY_ORDER[a.rarity] ?? 99;
      const rb = RARITY_ORDER[b.rarity] ?? 99;
      if (ra !== rb) return ra - rb;
      return b.chance - a.chance;
    });
    result.push({ label, sortOrder: i, items });
  }

  return result;
}

// Seed-cycle bounties use tierIndex because Hex labels do not match in-game levels.
// Promise caching prevents Svelte await blocks from refetching on every render.
export function getBountyRewards(
  syndicateKey: string,
  enemyLevels: [number, number],
  stageCount: number,
  rotation?: string,
  tierIndex?: number,
): Promise<BountyStageRewards[]> {
  const cacheKey = `${syndicateKey}:${enemyLevels[0]}-${enemyLevels[1]}:${stageCount}:${rotation || "all"}:${tierIndex ?? "lvl"}`;
  const cached = jobCache.get(cacheKey);
  if (cached) return cached;

  const file = resolveDropsFile(syndicateKey);
  if (!file) {
    const empty = Promise.resolve([]);
    jobCache.set(cacheKey, empty);
    return empty;
  }

  const request = getDropsData(file).then((entries) => {
    const level =
      (tierIndex != null ? entries[tierIndex] : undefined) ??
      matchBountyLevel(entries, enemyLevels);
    return level ? buildStageRewards(level, stageCount, rotation) : [];
  });
  jobCache.set(cacheKey, request);
  void request.catch(() => {
    if (jobCache.get(cacheKey) === request) jobCache.delete(cacheKey);
  });
  return request;
}

export function resolveRewardIcon(
  itemName: string,
  itemDb?: Record<string, ItemDbEntry>,
): string | undefined {
  return resolveRewardIconPath(itemName, getNameToEntryMap(itemDb));
}

export function resolveRewardUniqueName(
  itemName: string,
  itemDb?: Record<string, ItemDbEntry>,
): string | undefined {
  if (!itemName || !itemDb) return undefined;
  const stripped = stripQuantityPrefix(itemName).trim().toLowerCase();
  for (const [uniqueName, entry] of Object.entries(itemDb)) {
    if (entry.name?.toLowerCase() === stripped) return uniqueName;
  }
  return undefined;
}
