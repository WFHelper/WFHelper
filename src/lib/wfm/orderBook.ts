import { normalizeWfmSlug } from "./backendLite.js";
import { normalizeRank } from "../../../config/shared/numeric.js";
import { WFM_HEADERS } from "../../../config/shared/wfm.js";

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

export interface OrderBookDebugCounters {
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
const inFlightBySlug = new Map<string, Promise<ItemOrderBookResult>>();

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

function parseOrderType(order: Record<string, unknown>): "sell" | "buy" | null {
  const typeV1 = typeof order.order_type === "string" ? order.order_type.toLowerCase() : "";
  if (typeV1 === "sell" || typeV1 === "buy") return typeV1;
  const typeV2 = typeof order.type === "string" ? order.type.toLowerCase() : "";
  if (typeV2 === "sell" || typeV2 === "buy") return typeV2;
  return null;
}

function parseOrderUserName(order: Record<string, unknown>): string {
  const user = order.user as Record<string, unknown> | undefined;
  if (!user) return "";
  const nameV1 = typeof user.ingame_name === "string" ? user.ingame_name.trim() : "";
  if (nameV1) return nameV1;
  const nameV2 = typeof user.ingameName === "string" ? user.ingameName.trim() : "";
  if (nameV2) return nameV2;
  return "";
}

function parseOrderStatus(order: Record<string, unknown>): string | null {
  const user = order.user as Record<string, unknown> | undefined;
  return typeof user?.status === "string" ? user.status.toLowerCase() : null;
}

function parseOrderRank(order: Record<string, unknown>): number | null {
  const rankRaw =
    typeof order.rank === "number"
      ? order.rank
      : typeof order.mod_rank === "number"
        ? order.mod_rank
        : null;
  if (rankRaw == null || !Number.isFinite(rankRaw) || rankRaw < 0) return null;
  return Math.floor(rankRaw);
}

function extractOrderList(payload: unknown): unknown[] | null {
  if (!payload || typeof payload !== "object") return null;
  const jsonPayload = payload as {
    payload?: { orders?: unknown };
    data?: { orders?: unknown } | unknown[];
    orders?: unknown;
  };

  if (Array.isArray(jsonPayload.data)) return jsonPayload.data;
  if (Array.isArray(jsonPayload.payload?.orders)) return jsonPayload.payload.orders;
  if (jsonPayload.data && typeof jsonPayload.data === "object") {
    const maybeData = jsonPayload.data as { orders?: unknown };
    if (Array.isArray(maybeData.orders)) return maybeData.orders;
  }
  if (Array.isArray(jsonPayload.orders)) return jsonPayload.orders;
  return null;
}

async function fetchRawOrdersFromEndpoint(
  url: string,
): Promise<{ data: unknown[] | null; transient: boolean }> {
  bumpCounter("httpCalls");

  let response: Response;
  try {
    response = await fetch(url, {
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
  const rawOrders = extractOrderList(jsonPayload);
  if (!rawOrders) return { data: null, transient: false };

  return { data: rawOrders, transient: false };
}

function toOrderBookSide(
  rawOrders: unknown,
  orderType: "sell" | "buy",
  rankFilter: number | null,
): OrderBookEntry[] {
  if (!Array.isArray(rawOrders)) return [];

  const entries = rawOrders
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;
      const order = raw as Record<string, unknown>;

      const side = parseOrderType(order);
      if (side !== orderType) return null;
      if (order.visible === false) return null;

      const rank = parseOrderRank(order);
      if (rankFilter != null && rank !== rankFilter) return null;

      const userName = parseOrderUserName(order);
      if (!userName) return null;

      const platinumRaw = Number(order.platinum);
      if (!Number.isFinite(platinumRaw) || platinumRaw <= 0) return null;

      const quantityRaw = Number(order.quantity);
      const quantity =
        Number.isFinite(quantityRaw) && quantityRaw > 0 ? Math.floor(quantityRaw) : 1;

      return {
        userName,
        status: parseOrderStatus(order),
        platinum: Math.round(platinumRaw),
        quantity,
        rank,
      } satisfies OrderBookEntry;
    })
    .filter((entry): entry is OrderBookEntry => entry != null);

  entries.sort((a, b) => {
    if (a.platinum !== b.platinum) {
      return orderType === "sell" ? a.platinum - b.platinum : b.platinum - a.platinum;
    }
    if (a.quantity !== b.quantity) {
      return b.quantity - a.quantity;
    }
    return a.userName.localeCompare(b.userName);
  });

  return entries.slice(0, 500);
}

async function fetchDirectOrderBook(
  slug: string,
  rank: number | null,
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
        sell: toOrderBookSide(v2Attempt.data, "sell", rank),
        buy: toOrderBookSide(v2Attempt.data, "buy", rank),
        timestamp: nowMs(),
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
        sell: toOrderBookSide(v1Attempt.data, "sell", rank),
        buy: toOrderBookSide(v1Attempt.data, "buy", rank),
        timestamp: nowMs(),
      },
    };
  }

  bumpCounter(v1Attempt.transient ? "resultError" : "resultNoData");
  return v1Attempt.transient ? { status: "error", slug } : { status: "not_found", slug };
}

export function getOrderBookDebugCounters(): OrderBookDebugCounters {
  return { ...orderBookDebugCounters };
}

export function resetOrderBookDebugCounters(): void {
  for (const key of Object.keys(orderBookDebugCounters) as Array<keyof OrderBookDebugCounters>) {
    orderBookDebugCounters[key] = 0;
  }
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
  bumpCounter("requests");
  if (!normalizedSlug) {
    bumpCounter("resultError");
    return { status: "error", slug: "" };
  }

  const normalizedRank = normalizeRank(options?.rank ?? null);
  const key = orderBookCacheKey(normalizedSlug, normalizedRank);

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
  if (inFlight) return inFlight;

  const request = (async (): Promise<ItemOrderBookResult> => {
    try {
      const result = await fetchDirectOrderBook(normalizedSlug, normalizedRank);
      if (result.status === "ok") {
        const data: ItemOrderBook = result.data;
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
