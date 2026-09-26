import { median as plainMedian } from "../arbi/arbiChartData.js";
import { fetchBackendPriceHistory } from "../wfm/priceHistory.js";
import { fetchPriceBySlug } from "../wfm/wfmPrice.js";
import {
  isMedianStrategy,
  type MedianReference,
  type MedianStrategyId,
  type WorkbenchStrategyId,
} from "./pricingStrategies.js";
import { normalizeSubtype } from "../../../config/shared/wfmOrders.js";
import type { MarketStatPoint } from "../../../config/shared/marketStats.js";

const DAY_MS = 86_400_000;
const HISTORY_WINDOW_DAYS = 90;
export const MIN_TRADE_DAYS = 7;
const DEFAULT_CONCURRENCY = 4;

export interface MedianTarget {
  slug: string;
  rank: number | null;
  subtype: string | null;
}

/** An exact half split averages the two sides, so equal volumes give the plain median. */
function volumeWeightedMedian(days: readonly MarketStatPoint[]): number {
  const sorted = [...days].sort((a, b) => a.median - b.median);
  const half = sorted.reduce((sum, day) => sum + (day.volume ?? 0), 0) / 2;
  let cumulative = 0;
  for (let index = 0; index < sorted.length - 1; index += 1) {
    cumulative += sorted[index].volume ?? 0;
    if (cumulative > half) return sorted[index].median;
    if (cumulative === half) return (sorted[index].median + sorted[index + 1].median) / 2;
  }
  return sorted[sorted.length - 1].median;
}

/** Median of the daily archive medians over the last 90 days for one rank, or null
 *  with fewer than MIN_TRADE_DAYS trading days. */
export function ninetyDayMedian(
  points: readonly MarketStatPoint[],
  rank: number | null,
  now: number,
): MedianReference | null {
  const cutoff = now - HISTORY_WINDOW_DAYS * DAY_MS;
  const traded = points.filter(
    (point) =>
      point.time >= cutoff &&
      point.time <= now &&
      Number.isFinite(point.median) &&
      point.median > 0 &&
      point.volume !== 0,
  );
  const exact = traded.filter((point) => point.rank === rank);
  // A rankless row pools rank 0, the way the 48h price and the archive's bare rows do.
  const days = exact.length > 0 || rank != null ? exact : traded.filter((p) => p.rank === 0);
  if (days.length < MIN_TRADE_DAYS) return null;

  // A day without a volume cannot be weighed against the others, so one such day
  // turns the whole window into a plain median.
  const median = days.every((day) => day.volume != null)
    ? volumeWeightedMedian(days)
    : plainMedian(days.map((day) => day.median));
  return { median, days: days.length };
}

interface MedianSources {
  fetch48h: (slug: string, rank: number | null) => Promise<number | null>;
  fetchHistory: (slug: string) => Promise<readonly MarketStatPoint[] | null>;
  now?: () => number;
  concurrency?: number;
}

interface MedianLoader {
  load: (
    id: WorkbenchStrategyId,
    targets: readonly MedianTarget[],
    isCancelled?: () => boolean,
  ) => Promise<void>;
  peek: (id: WorkbenchStrategyId, target: MedianTarget) => MedianReference | null;
}

// Neither source is split by subtype (a relic's refinements share one price), so a
// row with a subtype gets no median rather than another refinement's price.
function medianSupported(target: MedianTarget): boolean {
  return normalizeSubtype(target.subtype) == null;
}

function referenceKey(id: MedianStrategyId, target: MedianTarget): string {
  return `${id}:${target.slug}:${target.rank ?? ""}`;
}

export function createMedianLoader(sources: MedianSources): MedianLoader {
  const now = sources.now ?? Date.now;
  const concurrency = Math.max(1, sources.concurrency ?? DEFAULT_CONCURRENCY);
  const references = new Map<string, MedianReference | null>();
  const historyInFlight = new Map<string, Promise<readonly MarketStatPoint[] | null>>();

  function historyOf(slug: string): Promise<readonly MarketStatPoint[] | null> {
    const pending = historyInFlight.get(slug);
    if (pending) return pending;
    const request = sources
      .fetchHistory(slug)
      .catch(() => null)
      .finally(() => historyInFlight.delete(slug));
    historyInFlight.set(slug, request);
    return request;
  }

  async function loadOne(id: MedianStrategyId, target: MedianTarget): Promise<void> {
    const key = referenceKey(id, target);
    if (id === "median-90d") {
      if (references.has(key)) return;
      const points = await historyOf(target.slug);
      if (points) references.set(key, ninetyDayMedian(points, target.rank, now()));
      return;
    }
    const value = await sources.fetch48h(target.slug, target.rank).catch(() => null);
    references.set(key, value != null && value > 0 ? { median: value, days: null } : null);
  }

  return {
    async load(id, targets, isCancelled) {
      if (!isMedianStrategy(id)) return;
      const unique = new Map<string, MedianTarget>();
      for (const target of targets) {
        if (medianSupported(target)) unique.set(referenceKey(id, target), target);
      }
      const queue = [...unique.values()];
      await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
          for (let target = queue.shift(); target; target = queue.shift()) {
            if (isCancelled?.()) return;
            await loadOne(id, target);
          }
        }),
      );
    },
    peek(id, target) {
      if (!isMedianStrategy(id) || !medianSupported(target)) return null;
      return references.get(referenceKey(id, target)) ?? null;
    },
  };
}

/** 90-day references last the session; the 48h price keeps the price cache's own freshness. */
export const workbenchMedianLoader = createMedianLoader({
  fetch48h: async (slug, rank) => {
    const result = await fetchPriceBySlug(slug, { rank });
    return result.status === "ok" ? result.median : null;
  },
  fetchHistory: fetchBackendPriceHistory,
});
