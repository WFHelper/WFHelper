import { getCachedPriceState, setCachedNoData, setCachedPrice } from "./priceCache.js";
import type { WfmItemsLookup } from "../../types/ipc.js";
import { schedulePriceCacheRevision } from "../../stores/pricing.js";
import {
  fetchBackendPriceBySlug,
  shouldDirectFallback,
  type BackendRequestPriority,
} from "./backendLite.js";
import { extractMedianFromStatsPayload } from "../../../config/shared/wfmStats.js";
import { normalizeRankFilter as normalizePriceRank } from "../../../config/shared/numeric.js";
import { isWfmExcludedSlug } from "../../../config/shared/wfmExclusions.js";
import { WFM_BACKEND_ERROR_COOLDOWN_MS } from "../../../config/runtime/cacheConfig.js";
import { log } from "../log.js";
import { normalizeWfmSlug, WFM_HEADERS } from "../../../config/shared/wfm.js";
import { rendererPriceCacheKey } from "../../../config/shared/wfmCacheKeys.js";
import { createAdaptiveDelayController, createPriorityRequestQueue } from "./requestPolicy.js";

const BASE_DELAY_MS = 350;
const MAX_DYNAMIC_DELAY_MS = 1200;
const DELAY_DECAY_STEP_MS = 5;
const DELAY_BACKOFF_STEP_MS = 120;
const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MIN_429_COOLDOWN_MS = 30_000;
const MAX_PRICE_QUEUE_DEPTH = 64;
const PRICE_QUEUE_FULL_ERROR = "WFM_PRICE_QUEUE_FULL";
// When the backend returns an error and direct fallback is not allowed, suppress
// retries for this duration so a cold/erroring worker doesn't get hammered.

const priceDelay = createAdaptiveDelayController({
  baseDelayMs: BASE_DELAY_MS,
  maxDelayMs: MAX_DYNAMIC_DELAY_MS,
  decayStepMs: DELAY_DECAY_STEP_MS,
  backoffStepMs: DELAY_BACKOFF_STEP_MS,
  minRateLimitCooldownMs: MIN_429_COOLDOWN_MS,
});

type PriceStatus = "ok" | "no_data" | "no_slug" | "transient";
type PriceCacheUpdateStatus = "ok" | "no_data";
type PriceCacheUpdateListener = (slug: string, status: PriceCacheUpdateStatus) => void;
export type RequestPriority = "high" | "normal" | "low";
interface FetchPriceOptions {
  priority?: RequestPriority;
  allowSetFallback?: boolean;
  rank?: number | null;
  ignoreNoDataCache?: boolean;
  cacheOnly?: boolean;
}

interface PriceDebugCounters {
  requests: number;
  cacheHitOk: number;
  cacheHitNoData: number;
  inFlightDeduped: number;
  httpCalls: number;
  resultOk: number;
  resultNoData: number;
  resultTransient: number;
  rateLimited: number;
  backendHitOk: number;
  backendHitNoData: number;
  backendError: number;
  queueDropped: number;
}

const priceDebugCounters: PriceDebugCounters = {
  requests: 0,
  cacheHitOk: 0,
  cacheHitNoData: 0,
  inFlightDeduped: 0,
  httpCalls: 0,
  resultOk: 0,
  resultNoData: 0,
  resultTransient: 0,
  rateLimited: 0,
  backendHitOk: 0,
  backendHitNoData: 0,
  backendError: 0,
  queueDropped: 0,
};

// Per-slug transient error cooldown. Populated when backend errors with no fallback
// allowed so retries are suppressed for WFM_BACKEND_ERROR_COOLDOWN_MS instead of
// hammering the worker on every render cycle.
const backendErrorCooldown = new Map<string, number>(); // cacheKey -> expiry timestamp
// Tracks slugs that returned no price data this session so the warning is
// only logged once rather than on every hydration cycle.
const _warnedNoDataSlugs = new Set<string>();

function pruneBackendErrorCooldown(): void {
  const now = Date.now();
  for (const [key, expiry] of backendErrorCooldown) {
    if (expiry <= now) backendErrorCooldown.delete(key);
  }
}

const priceCacheUpdateListeners = new Set<PriceCacheUpdateListener>();
const inFlightBySlug = new Map<string, Promise<PriceBySlugResult>>();

function bumpCounter(counter: keyof PriceDebugCounters): void {
  priceDebugCounters[counter] += 1;
}

const priceQueue = createPriorityRequestQueue<RequestPriority>({
  priorities: ["high", "normal", "low"],
  maxDepth: MAX_PRICE_QUEUE_DEPTH,
  beforeTask: priceDelay.waitForTurn,
  onDrop: () => bumpCounter("queueDropped"),
  dropError: () => new Error(PRICE_QUEUE_FULL_ERROR),
});

function emitPriceCacheUpdate(slug: string, status: PriceCacheUpdateStatus): void {
  schedulePriceCacheRevision();
  for (const listener of priceCacheUpdateListeners) {
    try {
      listener(slug, status);
    } catch (e) {
      log.warn("[WFM] price cache listener failed:", e);
    }
  }
}

function cachePrice(cacheKey: string, sourceSlug: string, median: number): void {
  const existing = getCachedPriceState(cacheKey);
  if (existing?.status === "ok" && existing.median != null && existing.median === median) {
    return;
  }
  setCachedPrice(cacheKey, median);
  emitPriceCacheUpdate(sourceSlug, "ok");
}

function cacheNoData(cacheKey: string, sourceSlug: string): void {
  const existing = getCachedPriceState(cacheKey);
  if (existing?.status === "no_data") return;
  setCachedNoData(cacheKey);
  emitPriceCacheUpdate(sourceSlug, "no_data");
}

export function getPriceDebugCountersForTest(): PriceDebugCounters {
  return { ...priceDebugCounters };
}

export function onPriceCacheUpdate(listener: PriceCacheUpdateListener): () => void {
  priceCacheUpdateListeners.add(listener);
  return () => {
    priceCacheUpdateListeners.delete(listener);
  };
}

interface PriceBySlugResult {
  status: PriceStatus;
  slug: string | null;
  median: number | null;
  timestamp?: number;
}

interface PriceByNameResult {
  median: number;
  slug: string;
  timestamp: number;
}

interface StatsResponse {
  ok: boolean;
  transient: boolean;
  json?: unknown;
}

function enqueue<T>(fn: () => Promise<T>, priority: RequestPriority = "normal"): Promise<T> {
  return priceQueue.enqueue(fn, priority);
}

async function fetchStatsJson(slug: string, priority: RequestPriority): Promise<StatsResponse> {
  return enqueue(async () => {
    bumpCounter("httpCalls");
    const resp = await fetch(`https://api.warframe.market/v1/items/${slug}/statistics`, {
      headers: WFM_HEADERS,
    });

    if (resp.status === 429) {
      bumpCounter("rateLimited");
      const retryAfter = parseInt(
        resp.headers.get("retry-after") || `${DEFAULT_RETRY_AFTER_SECONDS}`,
        10,
      );
      priceDelay.noteRateLimited(retryAfter);
      log.warn(`[WFM] Rate limited (429). Cooling down for ${retryAfter}s.`);
      return { ok: false, transient: true };
    }

    priceDelay.noteSuccess();

    if (!resp.ok) {
      return {
        ok: false,
        transient: resp.status >= 500 || resp.status === 408,
      };
    }

    return {
      ok: true,
      transient: false,
      json: await resp.json(),
    };
  }, priority);
}

async function fetchPriceBySlugInternal(
  slug: string,
  priority: RequestPriority,
  rank: number | null,
): Promise<PriceBySlugResult> {
  const cacheKey = rendererPriceCacheKey(slug, rank);
  const backendResult = await fetchBackendPriceBySlug(slug, { rank });
  if (backendResult.status === "ok") {
    cachePrice(cacheKey, slug, backendResult.data.median);
    bumpCounter("backendHitOk");
    bumpCounter("resultOk");
    return {
      status: "ok",
      slug: backendResult.data.slug,
      median: backendResult.data.median,
      timestamp: backendResult.data.timestamp || Date.now(),
    };
  }

  const fallbackPriority = priority as BackendRequestPriority;
  const fallbackAllowed = shouldDirectFallback(fallbackPriority);

  if (backendResult.status === "not_found") {
    bumpCounter("backendHitNoData");
    cacheNoData(cacheKey, slug);
    if (!_warnedNoDataSlugs.has(slug)) {
      _warnedNoDataSlugs.add(slug);
      log.warn(
        `[WFM price] No data for "${slug}" - if non-tradable, add to WFM_EXCLUDED_SLUGS in config/shared/wfmExclusions.ts`,
      );
    }
    bumpCounter("resultNoData");
    return { status: "no_data", slug, median: null };
  }

  if (backendResult.status === "error") {
    bumpCounter("backendError");
  }

  if (!fallbackAllowed) {
    bumpCounter("resultTransient");
    backendErrorCooldown.set(cacheKey, Date.now() + WFM_BACKEND_ERROR_COOLDOWN_MS);
    if (backendErrorCooldown.size > 1000) pruneBackendErrorCooldown();
    return { status: "transient", slug, median: null };
  }

  const res = await fetchStatsJson(slug, priority);
  if (!res.ok) {
    if (!res.transient) {
      cacheNoData(cacheKey, slug);
    }
    bumpCounter(res.transient ? "resultTransient" : "resultNoData");
    return {
      status: res.transient ? "transient" : "no_data",
      slug,
      median: null,
    };
  }

  const median = extractMedianFromStatsPayload(res.json, rank != null ? { rank } : undefined);
  if (median != null) {
    cachePrice(cacheKey, slug, median);
    bumpCounter("resultOk");
    return { median, slug, status: "ok", timestamp: Date.now() };
  }
  cacheNoData(cacheKey, slug);
  bumpCounter("resultNoData");
  return { status: "no_data", slug, median: null };
}

export async function fetchPriceBySlug(
  slug: string | null | undefined,
  options?: FetchPriceOptions,
): Promise<PriceBySlugResult> {
  const normalizedSlug = normalizeWfmSlug(slug);
  if (!normalizedSlug) return { status: "no_slug", slug: null, median: null };
  if (isWfmExcludedSlug(normalizedSlug)) return { status: "no_slug", slug: null, median: null };
  bumpCounter("requests");
  const priority = options?.priority || "normal";
  const rank = normalizePriceRank(options?.rank ?? null);
  const ignoreNoDataCache = options?.ignoreNoDataCache === true;
  const cacheOnly = options?.cacheOnly === true;
  const cacheKey = rendererPriceCacheKey(normalizedSlug, rank);

  const cached = getCachedPriceState(cacheKey);
  if (cached) {
    if (cached.status === "ok" && cached.median != null) {
      bumpCounter("cacheHitOk");
      bumpCounter("resultOk");
      return {
        median: cached.median,
        slug: normalizedSlug,
        status: "ok",
        timestamp: cached.timestamp,
      };
    }

    if (!ignoreNoDataCache) {
      bumpCounter("cacheHitNoData");
      bumpCounter("resultNoData");
      return { status: "no_data", slug: normalizedSlug, median: null };
    }
  }

  if (cacheOnly) {
    bumpCounter("resultNoData");
    return { status: "no_data", slug: normalizedSlug, median: null };
  }

  const cooldownExpiry = backendErrorCooldown.get(cacheKey);
  if (cooldownExpiry !== undefined && Date.now() < cooldownExpiry) {
    bumpCounter("resultTransient");
    return { status: "transient", slug: normalizedSlug, median: null };
  }

  const inFlight = inFlightBySlug.get(cacheKey);
  if (inFlight) {
    bumpCounter("inFlightDeduped");
    return inFlight;
  }

  const requestPromise = (async () => {
    try {
      return await fetchPriceBySlugInternal(normalizedSlug, priority, rank);
    } catch (e) {
      log.warn(`[WFM] fetch failed for ${normalizedSlug}:`, e);
      bumpCounter("resultTransient");
      return { status: "transient" as const, slug: normalizedSlug, median: null };
    } finally {
      inFlightBySlug.delete(cacheKey);
    }
  })();

  inFlightBySlug.set(cacheKey, requestPromise);
  return requestPromise;
}

export async function fetchPriceByName(
  itemName: string,
  wfmItems: WfmItemsLookup,
  options?: FetchPriceOptions,
): Promise<PriceByNameResult | null> {
  if (!itemName) return null;
  const priority = options?.priority || "normal";
  const allowSetFallback = options?.allowSetFallback === true;
  const rank = normalizePriceRank(options?.rank ?? null);
  const ignoreNoDataCache = options?.ignoreNoDataCache === true;
  const cacheOnly = options?.cacheOnly === true;

  const key = itemName.toLowerCase();
  const mapping = wfmItems[key] || null;
  const setMapping = wfmItems[`${key} set`] || null;
  let slug = normalizeWfmSlug(mapping?.url_name);

  if (!slug && /\bset$/i.test(itemName) && setMapping?.url_name) {
    slug = normalizeWfmSlug(setMapping.url_name);
  }

  if (!slug) {
    slug = normalizeWfmSlug(key);
  }
  if (!slug) return null;

  const slugsToTry = allowSetFallback && !slug.endsWith("_set") ? [`${slug}_set`, slug] : [slug];

  for (const trySlug of slugsToTry) {
    const result = await fetchPriceBySlug(trySlug, {
      priority,
      rank,
      ignoreNoDataCache,
      cacheOnly,
    });
    if (result.status === "ok" && result.median != null) {
      if (trySlug !== slug) {
        cachePrice(rendererPriceCacheKey(slug, rank), slug, result.median);
      }
      return {
        median: result.median,
        slug: trySlug,
        timestamp: result.timestamp || Date.now(),
      };
    }
  }

  return null;
}

export const __test__ = {
  extractMedianFromStatsPayload,
  enqueueForTest: enqueue,
  priceQueueFullError: PRICE_QUEUE_FULL_ERROR,
} as const;
