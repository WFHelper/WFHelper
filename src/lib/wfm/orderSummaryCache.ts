import { normalizeWfmSlug } from "./backendLite.js";
import numericShared from "../../../config/shared/numeric.cjs";

const { normalizeRankFilter, toFiniteNonNegativeInt } = numericShared as {
  normalizeRankFilter: (value: unknown) => number | null;
  toFiniteNonNegativeInt: (value: unknown) => number | null;
};

const ORDER_SUMMARY_FRESH_TTL_MS = 6 * 60 * 60 * 1000;
const ORDER_SUMMARY_STALE_TTL_MS = 48 * 60 * 60 * 1000;

export type CachedOrderSummaryStatus = "ok" | "no_data";

export interface CachedOrderSummaryEntry {
  status: CachedOrderSummaryStatus;
  wts: number | null;
  wtb: number | null;
  timestamp: number;
  sourceTimestamp?: number | null;
}

export interface OrderSummaryCacheStats {
  total: number;
  ok: number;
  noData: number;
}

const cache = new Map<string, CachedOrderSummaryEntry>();

function cacheKey(slugInput: string, rankInput: number | null): string | null {
  const slug = normalizeWfmSlug(slugInput);
  const rank = normalizeRankFilter(rankInput);
  if (!slug || rank == null) return null;
  return `${slug}:r${rank}`;
}

export function isOrderSummaryFresh(entry: CachedOrderSummaryEntry): boolean {
  return Date.now() - entry.timestamp < ORDER_SUMMARY_FRESH_TTL_MS;
}

function isOrderSummaryExpired(entry: CachedOrderSummaryEntry): boolean {
  return Date.now() - entry.timestamp >= ORDER_SUMMARY_STALE_TTL_MS;
}

function pruneExpiredEntries(): void {
  for (const [key, entry] of cache.entries()) {
    if (!isOrderSummaryExpired(entry)) continue;
    cache.delete(key);
  }
}

export function getCachedOrderSummaryState(
  slugInput: string | null | undefined,
  rankInput: number | null | undefined,
  options?: { allowStale?: boolean },
): CachedOrderSummaryEntry | null {
  const key = cacheKey(slugInput || "", rankInput ?? null);
  if (!key) return null;

  const entry = cache.get(key);
  if (!entry) return null;

  if (isOrderSummaryExpired(entry)) {
    cache.delete(key);
    return null;
  }

  if (options?.allowStale === true) {
    return entry;
  }

  return isOrderSummaryFresh(entry) ? entry : null;
}

export function setCachedOrderSummary(
  slugInput: string | null | undefined,
  rankInput: number | null | undefined,
  data: {
    wts: number | null;
    wtb: number | null;
    status?: CachedOrderSummaryStatus;
    sourceTimestamp?: number | null;
  },
): void {
  const key = cacheKey(slugInput || "", rankInput ?? null);
  if (!key) return;

  cache.set(key, {
    status: data.status ?? "ok",
    wts: toFiniteNonNegativeInt(data.wts),
    wtb: toFiniteNonNegativeInt(data.wtb),
    timestamp: Date.now(),
    ...(data.sourceTimestamp != null ? { sourceTimestamp: Math.round(data.sourceTimestamp) } : {}),
  });
}

export function setCachedOrderSummaryNoData(
  slugInput: string | null | undefined,
  rankInput: number | null | undefined,
  options?: { sourceTimestamp?: number | null },
): void {
  setCachedOrderSummary(slugInput, rankInput, {
    status: "no_data",
    wts: null,
    wtb: null,
    ...(options?.sourceTimestamp != null ? { sourceTimestamp: options.sourceTimestamp } : {}),
  });
}

export function getOrderSummaryCacheStats(): OrderSummaryCacheStats {
  pruneExpiredEntries();

  let ok = 0;
  let noData = 0;
  for (const entry of cache.values()) {
    if (entry.status === "ok") ok += 1;
    else noData += 1;
  }

  return {
    total: ok + noData,
    ok,
    noData,
  };
}

export function clearOrderSummaryCache(): void {
  cache.clear();
}

export function exportOrderSummaryCache(): Record<string, CachedOrderSummaryEntry> {
  pruneExpiredEntries();
  const out: Record<string, CachedOrderSummaryEntry> = {};
  for (const [key, entry] of cache.entries()) {
    out[key] = entry;
  }
  return out;
}

export function importOrderSummaryCache(data: Record<string, CachedOrderSummaryEntry>): number {
  let imported = 0;

  for (const [key, value] of Object.entries(data)) {
    if (!value || typeof value !== "object") continue;
    const status = value.status;
    if (status !== "ok" && status !== "no_data") continue;
    if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) continue;
    if (isOrderSummaryExpired(value)) continue;

    const existing = cache.get(key);
    if (existing && existing.timestamp >= value.timestamp) continue;

    cache.set(key, {
      status,
      wts: toFiniteNonNegativeInt(value.wts),
      wtb: toFiniteNonNegativeInt(value.wtb),
      timestamp: Math.round(value.timestamp),
      ...(value.sourceTimestamp != null
        ? { sourceTimestamp: toFiniteNonNegativeInt(value.sourceTimestamp) }
        : {}),
    });
    imported += 1;
  }

  return imported;
}
