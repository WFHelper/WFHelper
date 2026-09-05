import { normalizeWfmSlug } from "../../../config/shared/wfm.js";
import { isCacheEntryFresh, normalizeRank } from "../../../config/shared/numeric.js";
import { WFM_HEADERS } from "../../../config/shared/wfm.js";
import { rendererOrderBookCacheKey } from "../../../config/shared/wfmCacheKeys.js";
import {
  extractWfmOrderList,
  normalizeSubtype,
  normalizeWfmOrderBookSide,
  type WfmOrderBookEntry,
} from "../../../config/shared/wfmOrders.js";
import { fetchWithTimeout } from "../fetchWithTimeout.js";

export type OrderBookEntry = WfmOrderBookEntry;

export interface ItemOrderBook {
  slug: string;
  sell: OrderBookEntry[];
  buy: OrderBookEntry[];
  timestamp: number;
}

type ItemOrderBookResult =
  | { status: "ok"; data: ItemOrderBook }
  | { status: "not_found"; slug: string }
  | { status: "error"; slug: string };

const ORDERBOOK_TTL_MS = 45_000;
const ORDERBOOK_NO_DATA_TTL_MS = 3 * 60 * 1000;
const DIRECT_ORDER_BOOK_FETCH_TIMEOUT_MS = 10_000;

interface OrderBookDebugCounters {
  requests: number;
  cacheHitOk: number;
  cacheHitNoData: number;
  httpCalls: number;
  v1FallbackCalls: number;
  resultOk: number;
  resultNoData: number;
  resultError: number;
}

type CacheEntry =
  | { status: "ok"; data: ItemOrderBook; cachedAt: number }
  | { status: "not_found"; cachedAt: number };

const cacheBySlug = new Map<string, CacheEntry>();
const inFlightBySlug = new Map<string, { owner: symbol; promise: Promise<ItemOrderBookResult> }>();
const generationBySlug = new Map<string, number>();
let clearGeneration = 0;

const orderBookDebugCounters: OrderBookDebugCounters = {
  requests: 0,
  cacheHitOk: 0,
  cacheHitNoData: 0,
  httpCalls: 0,
  v1FallbackCalls: 0,
  resultOk: 0,
  resultNoData: 0,
  resultError: 0,
};

function bumpCounter(counter: keyof OrderBookDebugCounters): void {
  orderBookDebugCounters[counter] += 1;
}

function isFresh(entry: CacheEntry): boolean {
  return isCacheEntryFresh(entry, ORDERBOOK_TTL_MS, ORDERBOOK_NO_DATA_TTL_MS, {
    timestampKey: "cachedAt",
  });
}

async function fetchRawOrdersFromEndpoint(
  url: string,
): Promise<{ data: unknown[] | null; transient: boolean }> {
  bumpCounter("httpCalls");

  let response: Response;
  try {
    response = await fetchWithTimeout(url, DIRECT_ORDER_BOOK_FETCH_TIMEOUT_MS, {
      headers: WFM_HEADERS,
    });
  } catch {
    return { data: null, transient: true };
  }

  if (response.status === 429 || response.status >= 500) {
    return { data: null, transient: true };
  }
  if (!response.ok) return { data: null, transient: false };

  const jsonPayload = await response.json();
  const rawOrders = extractWfmOrderList(jsonPayload);
  if (!rawOrders) return { data: null, transient: false };

  return { data: rawOrders, transient: false };
}

async function fetchDirectOrderBook(
  slug: string,
  rank: number | null,
  subtype: string | null,
): Promise<ItemOrderBookResult> {
  const v2Attempt = await fetchRawOrdersFromEndpoint(
    `https://api.warframe.market/v2/orders/item/${slug}`,
  );
  if (v2Attempt.data) {
    bumpCounter("resultOk");
    return {
      status: "ok",
      data: {
        slug,
        // Renderer keeps the FULL book - the browse tab pages through it; the
        // default 500 cap is for the worker's KV-bound prewarm path only.
        sell: normalizeWfmOrderBookSide(
          v2Attempt.data,
          "sell",
          rank,
          Number.MAX_SAFE_INTEGER,
          subtype,
        ),
        buy: normalizeWfmOrderBookSide(
          v2Attempt.data,
          "buy",
          rank,
          Number.MAX_SAFE_INTEGER,
          subtype,
        ),
        timestamp: Date.now(),
      },
    };
  }
  if (v2Attempt.transient) {
    bumpCounter("resultError");
    return { status: "error", slug };
  }

  bumpCounter("v1FallbackCalls");
  const v1Attempt = await fetchRawOrdersFromEndpoint(
    `https://api.warframe.market/v1/items/${slug}/orders`,
  );
  if (v1Attempt.data) {
    bumpCounter("resultOk");
    return {
      status: "ok",
      data: {
        slug,
        sell: normalizeWfmOrderBookSide(
          v1Attempt.data,
          "sell",
          rank,
          Number.MAX_SAFE_INTEGER,
          subtype,
        ),
        buy: normalizeWfmOrderBookSide(
          v1Attempt.data,
          "buy",
          rank,
          Number.MAX_SAFE_INTEGER,
          subtype,
        ),
        timestamp: Date.now(),
      },
    };
  }

  bumpCounter(v1Attempt.transient ? "resultError" : "resultNoData");
  return v1Attempt.transient ? { status: "error", slug } : { status: "not_found", slug };
}

export function resetOrderBookDebugCounters(): void {
  for (const key of Object.keys(orderBookDebugCounters) as Array<keyof OrderBookDebugCounters>) {
    orderBookDebugCounters[key] = 0;
  }
}

function subtypedCacheKey(slug: string, rank: number | null, subtype: string | null): string {
  const base = rendererOrderBookCacheKey(slug, rank);
  return subtype ? `${base}:st-${subtype}` : base;
}

export function clearOrderBookCache(
  slug?: string | null,
  rank?: number | null,
  subtype?: string | null,
): void {
  const normalizedSlug = normalizeWfmSlug(slug);
  if (!normalizedSlug) {
    clearGeneration += 1;
    cacheBySlug.clear();
    inFlightBySlug.clear();
    generationBySlug.clear();
    return;
  }

  const normalizedRank = normalizeRank(rank);
  const key = subtypedCacheKey(normalizedSlug, normalizedRank, normalizeSubtype(subtype));
  cacheBySlug.delete(key);
  inFlightBySlug.delete(key);
  generationBySlug.set(key, (generationBySlug.get(key) ?? 0) + 1);
}

export async function fetchItemOrderBookBySlug(
  slug: string | null | undefined,
  options?: { rank?: number | null; subtype?: string | null },
): Promise<ItemOrderBookResult> {
  const normalizedSlug = normalizeWfmSlug(slug);
  bumpCounter("requests");
  if (!normalizedSlug) {
    bumpCounter("resultError");
    return { status: "error", slug: "" };
  }

  const normalizedRank = normalizeRank(options?.rank ?? null);
  const normalizedSubtype = normalizeSubtype(options?.subtype);
  const key = subtypedCacheKey(normalizedSlug, normalizedRank, normalizedSubtype);

  const cached = cacheBySlug.get(key);
  if (cached && isFresh(cached)) {
    if (cached.status === "ok") {
      bumpCounter("cacheHitOk");
      return { status: "ok", data: cached.data };
    }
    bumpCounter("cacheHitNoData");
    return { status: "not_found", slug: normalizedSlug };
  }

  const inFlight = inFlightBySlug.get(key);
  if (inFlight) return inFlight.promise;

  const requestClearGeneration = clearGeneration;
  const requestKeyGeneration = generationBySlug.get(key) ?? 0;
  const isCurrentRequest = (): boolean =>
    requestClearGeneration === clearGeneration &&
    requestKeyGeneration === (generationBySlug.get(key) ?? 0);

  const requestOwner = Symbol(key);
  const request = (async (): Promise<ItemOrderBookResult> => {
    try {
      const result = await fetchDirectOrderBook(normalizedSlug, normalizedRank, normalizedSubtype);
      if (result.status === "ok") {
        const data: ItemOrderBook = result.data;
        if (isCurrentRequest()) {
          cacheBySlug.set(key, { status: "ok", data, cachedAt: Date.now() });
        }
        return { status: "ok", data };
      }

      if (result.status === "not_found") {
        if (isCurrentRequest()) {
          cacheBySlug.set(key, { status: "not_found", cachedAt: Date.now() });
        }
        return { status: "not_found", slug: normalizedSlug };
      }

      return { status: "error", slug: normalizedSlug };
    } finally {
      if (inFlightBySlug.get(key)?.owner === requestOwner) inFlightBySlug.delete(key);
    }
  })();

  inFlightBySlug.set(key, { owner: requestOwner, promise: request });
  return request;
}
