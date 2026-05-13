import { withScope } from "./logger";
import { extractMedianFromStatsPayload } from "../config/shared/wfmStats";
import * as wfmClient from "./wfmClient";
import { normalizeErrorMessage } from "../config/shared/errors";
import { normalizeWfmSlug } from "../config/shared/wfm";
import { WFM_STATS_CACHE_TTL_MS } from "../config/runtime/cacheConfig";

const log = withScope("wfmStatsPrice");

const CACHE_MAX_ENTRIES = 5_000;

interface CacheEntry {
  median: number;
  ts: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<number | null>>();

function getCachedPrice(slug: string): number | null {
  const hit = cache.get(slug);
  if (!hit) return null;
  if (Date.now() - hit.ts > WFM_STATS_CACHE_TTL_MS) {
    cache.delete(slug);
    return null;
  }
  return hit.median;
}

function setCachedPrice(slug: string, median: number): void {
  // Evict the oldest entry (first insertion) when the cache grows past the
  // cap. Map preserves insertion order, so the first key is the oldest.
  if (!cache.has(slug) && cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(slug, {
    median,
    ts: Date.now(),
  });
}

export function getCachedPriceBySlug(slugInput: unknown): number | null {
  const slug = normalizeWfmSlug(typeof slugInput === "string" ? slugInput : null);
  if (!slug) return null;
  return getCachedPrice(slug);
}

export async function fetchPriceBySlug(slugInput: unknown): Promise<number | null> {
  const slug = normalizeWfmSlug(typeof slugInput === "string" ? slugInput : null);
  if (!slug) return null;

  const cached = getCachedPrice(slug);
  if (cached != null) return cached;

  const pending = inFlight.get(slug);
  if (pending) return pending;

  const task = (async (): Promise<number | null> => {
    try {
      // Route through the shared wfmClient queue so stats fetches share the
      // 350 ms rate-limit budget with every other WFM call. A direct fetch()
      // here would bypass the queue and can trigger 429 bans.
      const payload = await wfmClient.request("GET", `/items/${slug}/statistics`);
      const median = extractMedianFromStatsPayload(payload);
      if (median == null) return null;

      setCachedPrice(slug, median);
      return median;
    } catch (err) {
      log.warn(`[WFM] stats fetch failed for ${slug}:`, normalizeErrorMessage(err));
      return null;
    } finally {
      inFlight.delete(slug);
    }
  })();

  inFlight.set(slug, task);
  return task;
}

function clearCache(): void {
  cache.clear();
  inFlight.clear();
}

export const __test__ = {
  clearCache,
};
