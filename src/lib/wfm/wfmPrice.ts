import { getCachedPriceState, setCachedNoData, setCachedPrice } from "./priceCache.js";
import type { WfmItemsLookup } from "../../types/ipc.js";
import { schedulePriceCacheRevision } from "../../stores/pricing.js";
import {
  fetchBackendPriceBySlug,
  shouldDirectFallback,
  type BackendRequestPriority,
} from "./backendLite.js";
import wfmStatsShared from "../../../config/shared/wfmStats.cjs";

const BASE_DELAY_MS = 180;
const MAX_DYNAMIC_DELAY_MS = 1200;
const DELAY_DECAY_STEP_MS = 5;
const DELAY_BACKOFF_STEP_MS = 120;
const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MIN_429_COOLDOWN_MS = 30_000;

type SharedWfmStatsModule = {
  extractMedianFromStatsPayload: (jsonPayload: unknown) => number | null;
};

const { extractMedianFromStatsPayload } = wfmStatsShared as SharedWfmStatsModule;

const WFM_HEADERS = {
  Platform: "pc",
  Language: "en",
  Crossplay: "true",
  Accept: "application/json",
};

let _lastRequestAt = 0;
let _runnerActive = false;
let _dynamicDelayMs = BASE_DELAY_MS;

type PriceStatus = "ok" | "no_data" | "no_slug" | "transient";
type PriceCacheUpdateStatus = "ok" | "no_data";
type PriceCacheUpdateListener = (slug: string, status: PriceCacheUpdateStatus) => void;
export type RequestPriority = "high" | "normal" | "low";
export interface FetchPriceOptions {
  priority?: RequestPriority;
  allowSetFallback?: boolean;
}

export interface PriceDebugCounters {
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
}

export interface PriceQueueStats {
  high: number;
  normal: number;
  low: number;
  running: boolean;
  delayMs: number;
}

interface QueueTask<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
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
};

const priceCacheUpdateListeners = new Set<PriceCacheUpdateListener>();
const laneQueues: Record<RequestPriority, QueueTask<unknown>[]> = {
  high: [],
  normal: [],
  low: [],
};
const inFlightBySlug = new Map<string, Promise<PriceBySlugResult>>();

function bumpCounter(counter: keyof PriceDebugCounters): void {
  priceDebugCounters[counter] += 1;
}

function emitPriceCacheUpdate(slug: string, status: PriceCacheUpdateStatus): void {
  schedulePriceCacheRevision();
  for (const listener of priceCacheUpdateListeners) {
    try {
      listener(slug, status);
    } catch (e) {
      console.warn("[WFM] price cache listener failed:", e);
    }
  }
}

function cachePrice(slug: string, median: number): void {
  const existing = getCachedPriceState(slug);
  if (existing?.status === "ok" && existing.median != null && existing.median === median) {
    return;
  }
  setCachedPrice(slug, median);
  emitPriceCacheUpdate(slug, "ok");
}

function cacheNoData(slug: string): void {
  const existing = getCachedPriceState(slug);
  if (existing?.status === "no_data") return;
  setCachedNoData(slug);
  emitPriceCacheUpdate(slug, "no_data");
}

export function getPriceDebugCounters(): PriceDebugCounters {
  return { ...priceDebugCounters };
}

export function resetPriceDebugCounters(): void {
  for (const key of Object.keys(priceDebugCounters) as Array<keyof PriceDebugCounters>) {
    priceDebugCounters[key] = 0;
  }
}

export function onPriceCacheUpdate(listener: PriceCacheUpdateListener): () => void {
  priceCacheUpdateListeners.add(listener);
  return () => {
    priceCacheUpdateListeners.delete(listener);
  };
}

export function getPriceQueueStats(): PriceQueueStats {
  return {
    high: laneQueues.high.length,
    normal: laneQueues.normal.length,
    low: laneQueues.low.length,
    running: _runnerActive,
    delayMs: _dynamicDelayMs,
  };
}

export interface PriceBySlugResult {
  status: PriceStatus;
  slug: string | null;
  median: number | null;
  timestamp?: number;
}

export interface PriceByNameResult {
  median: number;
  slug: string;
  timestamp: number;
}

interface StatsResponse {
  ok: boolean;
  transient: boolean;
  json?: unknown;
}

function popNextTask(): QueueTask<unknown> | null {
  if (laneQueues.high.length > 0) return laneQueues.high.shift() || null;
  if (laneQueues.normal.length > 0) return laneQueues.normal.shift() || null;
  if (laneQueues.low.length > 0) return laneQueues.low.shift() || null;
  return null;
}

async function runQueueRunner(): Promise<void> {
  if (_runnerActive) return;
  _runnerActive = true;

  try {
    for (;;) {
      const task = popNextTask();
      if (!task) break;

      const now = Date.now();
      const elapsed = now - _lastRequestAt;
      if (elapsed < _dynamicDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, _dynamicDelayMs - elapsed));
      }
      _lastRequestAt = Date.now();

      try {
        const result = await task.fn();
        task.resolve(result);
      } catch (error) {
        task.reject(error);
      }
    }
  } finally {
    _runnerActive = false;
    if (laneQueues.high.length > 0 || laneQueues.normal.length > 0 || laneQueues.low.length > 0) {
      void runQueueRunner();
    }
  }
}

function enqueue<T>(fn: () => Promise<T>, priority: RequestPriority = "normal"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    laneQueues[priority].push({
      fn: fn as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    void runQueueRunner();
  });
}

async function fetchStatsJson(slug: string, priority: RequestPriority): Promise<StatsResponse> {
  return enqueue(async () => {
    bumpCounter("httpCalls");
    const resp = await fetch(`https://api.warframe.market/v1/items/${slug}/statistics`, {
      headers: WFM_HEADERS,
    });

    if (resp.status === 429) {
      bumpCounter("rateLimited");
      _dynamicDelayMs = Math.min(MAX_DYNAMIC_DELAY_MS, _dynamicDelayMs + DELAY_BACKOFF_STEP_MS);
      const retryAfter = parseInt(
        resp.headers.get("retry-after") || `${DEFAULT_RETRY_AFTER_SECONDS}`,
        10,
      );
      _lastRequestAt =
        Date.now() + Math.max(retryAfter * 1000, MIN_429_COOLDOWN_MS) - _dynamicDelayMs;
      console.warn(`[WFM] Rate limited (429). Cooling down for ${retryAfter}s.`);
      return { ok: false, transient: true };
    }

    if (_dynamicDelayMs > BASE_DELAY_MS) {
      _dynamicDelayMs = Math.max(BASE_DELAY_MS, _dynamicDelayMs - DELAY_DECAY_STEP_MS);
    }

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
): Promise<PriceBySlugResult> {
  const backendResult = await fetchBackendPriceBySlug(slug);
  if (backendResult.status === "ok") {
    cachePrice(slug, backendResult.data.median);
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
    if (!fallbackAllowed) {
      cacheNoData(slug);
      bumpCounter("resultNoData");
      return { status: "no_data", slug, median: null };
    }
  } else if (backendResult.status === "error") {
    bumpCounter("backendError");
    if (!fallbackAllowed) {
      bumpCounter("resultTransient");
      return { status: "transient", slug, median: null };
    }
  }

  const res = await fetchStatsJson(slug, priority);
  if (!res.ok) {
    if (!res.transient) {
      cacheNoData(slug);
    }
    bumpCounter(res.transient ? "resultTransient" : "resultNoData");
    return {
      status: res.transient ? "transient" : "no_data",
      slug,
      median: null,
    };
  }

  const median = extractMedianFromStatsPayload(res.json);
  if (median != null) {
    cachePrice(slug, median);
    bumpCounter("resultOk");
    return { median, slug, status: "ok", timestamp: Date.now() };
  }
  cacheNoData(slug);
  bumpCounter("resultNoData");
  return { status: "no_data", slug, median: null };
}

export async function fetchPriceBySlug(
  slug: string | null | undefined,
  options?: FetchPriceOptions,
): Promise<PriceBySlugResult> {
  if (!slug) return { status: "no_slug", slug: null, median: null };
  bumpCounter("requests");
  const priority = options?.priority || "normal";

  const cached = getCachedPriceState(slug);
  if (cached) {
    if (cached.status === "ok" && cached.median != null) {
      bumpCounter("cacheHitOk");
      bumpCounter("resultOk");
      return {
        median: cached.median,
        slug,
        status: "ok",
        timestamp: cached.timestamp,
      };
    }
    bumpCounter("cacheHitNoData");
    bumpCounter("resultNoData");
    return { status: "no_data", slug, median: null };
  }

  const inFlight = inFlightBySlug.get(slug);
  if (inFlight) {
    bumpCounter("inFlightDeduped");
    return inFlight;
  }

  const requestPromise = (async () => {
    try {
      return await fetchPriceBySlugInternal(slug, priority);
    } catch (e) {
      console.warn(`[WFM] fetch failed for ${slug}:`, e);
      bumpCounter("resultTransient");
      return { status: "transient" as const, slug, median: null };
    } finally {
      inFlightBySlug.delete(slug);
    }
  })();

  inFlightBySlug.set(slug, requestPromise);
  return requestPromise;
}

export async function fetchPriceByName(
  itemName: string,
  wfmItems: WfmItemsLookup,
  options?: FetchPriceOptions,
): Promise<PriceByNameResult | null> {
  if (!itemName) return null;
  bumpCounter("requests");
  const priority = options?.priority || "normal";
  const allowSetFallback = options?.allowSetFallback === true;

  const key = itemName.toLowerCase();
  const mapping = wfmItems[key] || null;
  const setMapping = wfmItems[`${key} set`] || null;
  let slug = mapping?.url_name;

  if (!slug && /\bset$/i.test(itemName) && setMapping?.url_name) {
    slug = setMapping.url_name;
  }

  if (!slug) {
    slug = key
      .replace(/['']/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }
  if (!slug) return null;

  const slugsToTry = allowSetFallback && !slug.endsWith("_set") ? [`${slug}_set`, slug] : [slug];

  for (const trySlug of slugsToTry) {
    const result = await fetchPriceBySlug(trySlug, { priority });
    if (result.status === "ok" && result.median != null) {
      if (trySlug !== slug) cachePrice(slug, result.median);
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
} as const;
