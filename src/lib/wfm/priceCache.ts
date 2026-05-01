const PRICE_TTL_MS = 12 * 60 * 60 * 1000;
const NO_DATA_TTL_MS = 6 * 60 * 60 * 1000;

type CachedPriceStatus = "ok" | "no_data";

export interface CachedPriceEntry {
  status: CachedPriceStatus;
  median: number | null;
  timestamp: number;
}

const _prices = new Map<string, CachedPriceEntry>();

function ttlFor(status: CachedPriceStatus): number {
  return status === "ok" ? PRICE_TTL_MS : NO_DATA_TTL_MS;
}

function isFresh(entry: CachedPriceEntry): boolean {
  return Date.now() - entry.timestamp < ttlFor(entry.status);
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
