import { withScope } from "./logger";
import { extractMedianFromStatsPayload } from "./wfmStats";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("wfmStatsPrice");

const STATS_TTL_MS = 5 * 60 * 1000;
const STATS_TIMEOUT_MS = 7_000;

import { WFM_HEADERS } from "../config/shared/wfm";

interface CacheEntry {
  median: number;
  ts: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<number | null>>();

function normalizeSlug(slug: any): string {
  if (typeof slug !== "string") return "";
  return slug.trim().toLowerCase();
}

function getCachedPrice(slug: string): number | null {
  const hit = cache.get(slug);
  if (!hit) return null;
  if (Date.now() - hit.ts > STATS_TTL_MS) {
    cache.delete(slug);
    return null;
  }
  return hit.median;
}

function setCachedPrice(slug: string, median: number): void {
  cache.set(slug, {
    median,
    ts: Date.now(),
  });
}

export function getCachedPriceBySlug(slugInput: any): number | null {
  const slug = normalizeSlug(slugInput);
  if (!slug) return null;
  return getCachedPrice(slug);
}

export async function fetchPriceBySlug(
  slugInput: any,
  options: { timeoutMs?: number } = {},
): Promise<number | null> {
  const slug = normalizeSlug(slugInput);
  if (!slug) return null;

  const cached = getCachedPrice(slug);
  if (cached != null) return cached;

  const pending = inFlight.get(slug);
  if (pending) return pending;

  const task = (async (): Promise<number | null> => {
    const controller = new AbortController();
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Math.max(500, Number(options.timeoutMs))
      : STATS_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);

    try {
      const response = await fetch(`https://api.warframe.market/v1/items/${slug}/statistics`, {
        headers: WFM_HEADERS,
        signal: controller.signal,
      });

      if (!response.ok) return null;

      const payload = await response.json();
      const median = extractMedianFromStatsPayload(payload);
      if (median == null) return null;

      setCachedPrice(slug, median);
      return median;
    } catch (err) {
      log.warn(`[WFM] stats fetch failed for ${slug}:`, normalizeErrorMessage(err));
      return null;
    } finally {
      clearTimeout(timer);
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
  normalizeSlug,
  clearCache,
  getCachedPrice,
  setCachedPrice,
};