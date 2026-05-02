import { normalizeWfmSlug } from "./backendLite.js";
import { normalizeRankFilter, toFiniteNonNegativeInt } from "../../../config/shared/numeric.js";
import { rendererOrderSummaryCacheKey } from "../../../config/shared/wfmCacheKeys.js";

const ORDER_SUMMARY_FRESH_TTL_MS = 24 * 60 * 60 * 1000;
const ORDER_SUMMARY_STALE_TTL_MS = 48 * 60 * 60 * 1000;

type CachedOrderSummaryStatus = "ok" | "no_data";

export interface CachedOrderSummaryEntry {
  status: CachedOrderSummaryStatus;
  wts: number | null;
  wtb: number | null;
  timestamp: number;
  sourceTimestamp?: number | null;
}

const cache = new Map<string, CachedOrderSummaryEntry>();

function cacheKey(slugInput: string, rankInput: number | null): string | null {
  const slug = normalizeWfmSlug(slugInput);
  const rank = normalizeRankFilter(rankInput);
  return slug ? rendererOrderSummaryCacheKey(slug, rank) : null;
}

export function isOrderSummaryFresh(entry: CachedOrderSummaryEntry): boolean {
  return Date.now() - entry.timestamp < ORDER_SUMMARY_FRESH_TTL_MS;
}

function isOrderSummaryExpired(entry: CachedOrderSummaryEntry): boolean {
  return Date.now() - entry.timestamp >= ORDER_SUMMARY_STALE_TTL_MS;
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

export function clearOrderSummaryCache(): void {
  cache.clear();
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
