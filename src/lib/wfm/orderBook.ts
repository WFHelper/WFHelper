import { fetchBackendOrdersBySlug, normalizeWfmSlug } from "./backendLite.js";

export interface OrderBookEntry {
  userName: string;
  status: string | null;
  platinum: number;
  quantity: number;
  rank: number | null;
}

export interface ItemOrderBook {
  slug: string;
  sell: OrderBookEntry[];
  buy: OrderBookEntry[];
  timestamp: number;
}

export type ItemOrderBookResult =
  | { status: "ok"; data: ItemOrderBook }
  | { status: "not_found"; slug: string }
  | { status: "error"; slug: string };

const ORDERBOOK_TTL_MS = 45_000;
const ORDERBOOK_NO_DATA_TTL_MS = 3 * 60 * 1000;

type CacheEntry =
  | { status: "ok"; data: ItemOrderBook; cachedAt: number }
  | { status: "not_found"; cachedAt: number };

const cacheBySlug = new Map<string, CacheEntry>();
const inFlightBySlug = new Map<string, Promise<ItemOrderBookResult>>();

function normalizeRank(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim().length === 0) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function orderBookCacheKey(slug: string, rank: number | null): string {
  return rank == null ? slug : `${slug}:r${rank}`;
}

function nowMs(): number {
  return Date.now();
}

function isFresh(entry: CacheEntry): boolean {
  const ttl = entry.status === "ok" ? ORDERBOOK_TTL_MS : ORDERBOOK_NO_DATA_TTL_MS;
  return nowMs() - entry.cachedAt < ttl;
}

export function clearOrderBookCache(slug?: string | null, rank?: number | null): void {
  const normalizedSlug = normalizeWfmSlug(slug);
  if (!normalizedSlug) {
    cacheBySlug.clear();
    inFlightBySlug.clear();
    return;
  }

  const normalizedRank = normalizeRank(rank);
  const key = orderBookCacheKey(normalizedSlug, normalizedRank);
  cacheBySlug.delete(key);
  inFlightBySlug.delete(key);
}

export async function fetchItemOrderBookBySlug(
  slug: string | null | undefined,
  options?: { rank?: number | null },
): Promise<ItemOrderBookResult> {
  const normalizedSlug = normalizeWfmSlug(slug);
  if (!normalizedSlug) {
    return { status: "error", slug: "" };
  }

  const normalizedRank = normalizeRank(options?.rank ?? null);
  const key = orderBookCacheKey(normalizedSlug, normalizedRank);

  const cached = cacheBySlug.get(key);
  if (cached && isFresh(cached)) {
    if (cached.status === "ok") {
      return { status: "ok", data: cached.data };
    }
    return { status: "not_found", slug: normalizedSlug };
  }

  const inFlight = inFlightBySlug.get(key);
  if (inFlight) return inFlight;

  const request = (async (): Promise<ItemOrderBookResult> => {
    try {
      const result = await fetchBackendOrdersBySlug(normalizedSlug, { rank: normalizedRank });
      if (result.status === "ok") {
        const data: ItemOrderBook = {
          slug: result.data.slug || normalizedSlug,
          sell: result.data.sell || [],
          buy: result.data.buy || [],
          timestamp: result.data.timestamp || nowMs(),
        };
        cacheBySlug.set(key, { status: "ok", data, cachedAt: nowMs() });
        return { status: "ok", data };
      }

      if (result.status === "not_found") {
        cacheBySlug.set(key, { status: "not_found", cachedAt: nowMs() });
        return { status: "not_found", slug: normalizedSlug };
      }

      return { status: "error", slug: normalizedSlug };
    } finally {
      inFlightBySlug.delete(key);
    }
  })();

  inFlightBySlug.set(key, request);
  return request;
}
