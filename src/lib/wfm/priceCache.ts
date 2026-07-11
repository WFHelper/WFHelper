import { isCacheEntryFresh } from "../../../config/shared/numeric.js";

// Must outlast the worker's refresh cadence or snapshot imports get holes:
// prices refresh at 21h staleness + up to a full prewarm walk before the cron
// revisits (~8h base catalog, ~21h ranked) - entries are legitimately ~29-42h
// old. 48h matches ORDER_SUMMARY_STALE_TTL_MS; anything older is evicted and
// visible-card hydration refetches it.
const PRICE_TTL_MS = 48 * 60 * 60 * 1000;
const NO_DATA_TTL_MS = 12 * 60 * 60 * 1000;

type CachedPriceStatus = "ok" | "no_data";

export interface CachedPriceEntry {
  status: CachedPriceStatus;
  median: number | null;
  timestamp: number;
}

const _prices = new Map<string, CachedPriceEntry>();

function isFresh(entry: CachedPriceEntry): boolean {
  return isCacheEntryFresh(entry, PRICE_TTL_MS, NO_DATA_TTL_MS);
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

export function setCachedPrice(slug: string, median: number): void {
  _prices.set(slug, { status: "ok", median, timestamp: Date.now() });
}

export function setCachedNoData(slug: string): void {
  _prices.set(slug, { status: "no_data", median: null, timestamp: Date.now() });
}

function clearPriceCache(): void {
  _prices.clear();
}

/** Bulk-import entries from the snapshot cache. Only fresh entries are kept. */
export function importCache(data: Record<string, CachedPriceEntry>): number {
  let imported = 0;
  for (const [slug, entry] of Object.entries(data)) {
    if (
      entry &&
      typeof entry.timestamp === "number" &&
      typeof entry.status === "string" &&
      isFresh(entry)
    ) {
      const existing = _prices.get(slug);
      if (existing && existing.timestamp >= entry.timestamp) {
        continue;
      }

      _prices.set(slug, entry);
      imported++;
    }
  }
  return imported;
}

export const __test__ = {
  clearPriceCache,
};
