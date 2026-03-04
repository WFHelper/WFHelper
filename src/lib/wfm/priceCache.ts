const STORAGE_KEY = "wfm_price_cache_v2";
const PRICE_TTL_MS = 12 * 60 * 60 * 1000;
const NO_DATA_TTL_MS = 6 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 2000;

export type CachedPriceStatus = "ok" | "no_data";

export interface CachedPriceEntry {
  status: CachedPriceStatus;
  median: number | null;
  timestamp: number;
}

export interface PriceCacheStats {
  total: number;
  ok: number;
  noData: number;
}

const _prices = new Map<string, CachedPriceEntry>();
let _dirty = false;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function storageOrNull(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function ttlFor(status: CachedPriceStatus): number {
  return status === "ok" ? PRICE_TTL_MS : NO_DATA_TTL_MS;
}

function isFresh(entry: CachedPriceEntry): boolean {
  return Date.now() - entry.timestamp < ttlFor(entry.status);
}

function pruneExpiredEntries(): void {
  let changed = false;
  for (const [slug, entry] of _prices) {
    if (isFresh(entry)) continue;
    _prices.delete(slug);
    changed = true;
  }
  if (changed) {
    _dirty = true;
    _scheduleSave();
  }
}

try {
  const storage = storageOrNull();
  const raw = storage?.getItem(STORAGE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as {
      v?: number;
      entries?: Array<[slug: string, status: CachedPriceStatus, median: number | null, ts: number]>;
    };
    if (parsed.v === 2 && Array.isArray(parsed.entries)) {
      for (const [slug, status, median, ts] of parsed.entries) {
        const entry: CachedPriceEntry = { status, median, timestamp: ts };
        if (isFresh(entry)) {
          _prices.set(slug, entry);
        }
      }
    }
  }
} catch (e) {
  console.warn("[PriceCache] Failed to hydrate:", e);
}

function _scheduleSave(): void {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (!_dirty) return;
    persistCache();
  }, SAVE_DEBOUNCE_MS);
}

function persistCache(): void {
  _dirty = false;
  const storage = storageOrNull();
  if (!storage) return;
  try {
    const entries: Array<
      [slug: string, status: CachedPriceStatus, median: number | null, ts: number]
    > = [];
    for (const [slug, entry] of _prices) {
      if (isFresh(entry)) {
        entries.push([slug, entry.status, entry.median, entry.timestamp]);
      }
    }
    storage.setItem(STORAGE_KEY, JSON.stringify({ v: 2, entries }));
  } catch (e) {
    console.warn("[PriceCache] Failed to persist:", e);
  }
}

export function getCachedPriceState(slug: string): CachedPriceEntry | null {
  const entry = _prices.get(slug);
  if (!entry) return null;
  if (!isFresh(entry)) {
    _prices.delete(slug);
    _dirty = true;
    _scheduleSave();
    return null;
  }
  return entry;
}

export function getCachedPrice(slug: string): { median: number; timestamp: number } | null {
  const entry = getCachedPriceState(slug);
  if (!entry || entry.status !== "ok" || entry.median == null) return null;
  return { median: entry.median, timestamp: entry.timestamp };
}

export function setCachedPrice(slug: string, median: number): void {
  _prices.set(slug, { status: "ok", median, timestamp: Date.now() });
  _dirty = true;
  _scheduleSave();
}

export function setCachedNoData(slug: string): void {
  _prices.set(slug, { status: "no_data", median: null, timestamp: Date.now() });
  _dirty = true;
  _scheduleSave();
}

export function cacheSize(): number {
  return getPriceCacheStats().total;
}

export function getPriceCacheStats(): PriceCacheStats {
  pruneExpiredEntries();
  let ok = 0;
  let noData = 0;
  for (const entry of _prices.values()) {
    if (entry.status === "ok") ok += 1;
    else noData += 1;
  }
  return { total: ok + noData, ok, noData };
}

export function flushCache(): void {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  if (!_dirty) return;
  persistCache();
}
