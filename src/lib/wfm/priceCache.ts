const PRICE_TTL_MS = 12 * 60 * 60 * 1000;
const NO_DATA_TTL_MS = 6 * 60 * 60 * 1000;

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

function ttlFor(status: CachedPriceStatus): number {
  return status === "ok" ? PRICE_TTL_MS : NO_DATA_TTL_MS;
}

function isFresh(entry: CachedPriceEntry): boolean {
  return Date.now() - entry.timestamp < ttlFor(entry.status);
}

function pruneExpiredEntries(): void {
  for (const [slug, entry] of _prices) {
    if (isFresh(entry)) continue;
    _prices.delete(slug);
  }
}

export function getCachedPriceState(slug: string): CachedPriceEntry | null {
  const entry = _prices.get(slug);
  if (!entry) return null;
  if (!isFresh(entry)) {
    _prices.delete(slug);
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
}

export function setCachedNoData(slug: string): void {
  _prices.set(slug, { status: "no_data", median: null, timestamp: Date.now() });
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

/** Serialise the cache to a plain object for persistence. Expired entries are pruned first. */
export function exportCache(): Record<string, CachedPriceEntry> {
  pruneExpiredEntries();
  const out: Record<string, CachedPriceEntry> = {};
  for (const [slug, entry] of _prices) {
    out[slug] = entry;
  }
  return out;
}

/** Bulk-import entries (e.g. loaded from disk). Only fresh entries are kept. */
export function importCache(data: Record<string, CachedPriceEntry>): number {
  let imported = 0;
  for (const [slug, entry] of Object.entries(data)) {
    if (
      entry &&
      typeof entry.timestamp === "number" &&
      typeof entry.status === "string" &&
      isFresh(entry) &&
      !_prices.has(slug)
    ) {
      _prices.set(slug, entry);
      imported++;
    }
  }
  return imported;
}
