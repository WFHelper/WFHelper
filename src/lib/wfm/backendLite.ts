import numericShared from "../../../config/shared/numeric.cjs";
import wfmShared from "../../../config/shared/wfm.cjs";

const { toFiniteNumber } = numericShared as {
  toFiniteNumber: (value: unknown) => number | null;
};

const { normalizeWfmSlug: _normalizeWfmSlug } = wfmShared as {
  normalizeWfmSlug: (value: string | null | undefined) => string | null;
};

/** Re-export from shared module for existing renderer consumers. */
export const normalizeWfmSlug = _normalizeWfmSlug;

export type BackendRequestPriority = "high" | "normal" | "low";

type FallbackMode = "always" | "high" | "never";

const RAW_BACKEND_URL = (import.meta.env.VITE_WFM_BACKEND_URL || "").trim();
const BACKEND_BASE_URL = RAW_BACKEND_URL.replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 3500;

function resolveFallbackMode(): FallbackMode {
  const raw = (import.meta.env.VITE_WFM_BACKEND_DIRECT_FALLBACK || "").trim().toLowerCase();
  if (raw === "always" || raw === "high" || raw === "never") {
    return raw;
  }
  return "high";
}

const FALLBACK_MODE = resolveFallbackMode();

export function isBackendLiteConfigured(): boolean {
  return BACKEND_BASE_URL.length > 0;
}

export function shouldDirectFallback(priority: BackendRequestPriority): boolean {
  if (!isBackendLiteConfigured()) return true;
  if (FALLBACK_MODE === "always") return true;
  if (FALLBACK_MODE === "never") return false;
  return priority === "high";
}

export interface BackendPricePayload {
  slug: string;
  median: number;
  rank: number | null;
  timestamp: number | null;
}

export interface BackendMetaPayload {
  slug: string;
  ducats: number | null;
  setRoot: boolean;
  thumb: string | null;
  icon: string | null;
  timestamp: number | null;
}

export interface BackendOrderBookEntry {
  userName: string;
  status: string | null;
  platinum: number;
  quantity: number;
  rank: number | null;
}

export interface BackendOrdersPayload {
  slug: string;
  sell: BackendOrderBookEntry[];
  buy: BackendOrderBookEntry[];
  timestamp: number | null;
}

export interface BackendOrderSummaryPayload {
  slug: string;
  rank: number | null;
  wts: number | null;
  wtb: number | null;
  timestamp: number | null;
}

export type BackendFetchResult<T> =
  | { status: "ok"; data: T }
  | { status: "not_found" }
  | { status: "unavailable" }
  | { status: "error" };

function parseOrderBookSide(value: unknown): BackendOrderBookEntry[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;

      const userName = typeof row.userName === "string" ? row.userName.trim() : "";
      if (!userName) return null;

      const platinumRaw = toFiniteNumber(row.platinum);
      if (platinumRaw == null || platinumRaw <= 0) return null;

      const quantityRaw = toFiniteNumber(row.quantity);
      const quantity = quantityRaw != null && quantityRaw > 0 ? Math.floor(quantityRaw) : 1;

      const rankRaw = toFiniteNumber(row.rank);
      const rank = rankRaw != null && rankRaw >= 0 ? Math.floor(rankRaw) : null;

      return {
        userName,
        status: typeof row.status === "string" ? row.status : null,
        platinum: Math.round(platinumRaw),
        quantity,
        rank,
      };
    })
    .filter((entry): entry is BackendOrderBookEntry => entry != null);
}

async function fetchBackendJson(
  pathname: string,
): Promise<BackendFetchResult<Record<string, unknown>>> {
  if (!isBackendLiteConfigured()) {
    return { status: "unavailable" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${BACKEND_BASE_URL}${pathname}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    if (response.status === 404) return { status: "not_found" };
    if (!response.ok) return { status: "error" };

    const json = (await response.json()) as { ok?: boolean; data?: unknown };
    if (!json || json.ok !== true || !json.data || typeof json.data !== "object") {
      return { status: "not_found" };
    }

    return { status: "ok", data: json.data as Record<string, unknown> };
  } catch {
    return { status: "error" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchBackendPriceBySlug(
  slug: string,
  options?: { rank?: number | null },
): Promise<BackendFetchResult<BackendPricePayload>> {
  const normalizedSlug = normalizeWfmSlug(slug);
  if (!normalizedSlug) return { status: "not_found" };

  const rankRaw = toFiniteNumber(options?.rank ?? null);
  const rank = rankRaw != null && rankRaw >= 0 ? Math.floor(rankRaw) : null;
  const path =
    rank != null
      ? `/v1/prices/${encodeURIComponent(normalizedSlug)}?rank=${encodeURIComponent(String(rank))}`
      : `/v1/prices/${encodeURIComponent(normalizedSlug)}`;

  const result = await fetchBackendJson(path);
  if (result.status !== "ok") return result;

  const median = toFiniteNumber(result.data.median);
  if (median == null || median <= 0) return { status: "not_found" };

  const timestamp = toFiniteNumber(result.data.timestamp);
  const responseRank = toFiniteNumber(result.data.rank);
  const responseSlug =
    typeof result.data.slug === "string" ? normalizeWfmSlug(result.data.slug) : normalizedSlug;

  return {
    status: "ok",
    data: {
      slug: responseSlug || normalizedSlug,
      median: Math.round(Math.abs(median)),
      rank: responseRank != null && responseRank >= 0 ? Math.floor(responseRank) : rank,
      timestamp: timestamp != null ? Math.floor(timestamp) : null,
    },
  };
}

export async function fetchBackendMetaBySlug(
  slug: string,
): Promise<BackendFetchResult<BackendMetaPayload>> {
  const normalizedSlug = normalizeWfmSlug(slug);
  if (!normalizedSlug) return { status: "not_found" };

  const result = await fetchBackendJson(`/v1/meta/${encodeURIComponent(normalizedSlug)}`);
  if (result.status !== "ok") return result;

  const ducatsRaw = toFiniteNumber(result.data.ducats);
  const timestamp = toFiniteNumber(result.data.timestamp);
  const responseSlug =
    typeof result.data.slug === "string" ? normalizeWfmSlug(result.data.slug) : normalizedSlug;

  return {
    status: "ok",
    data: {
      slug: responseSlug || normalizedSlug,
      ducats: ducatsRaw != null ? Math.max(0, Math.round(ducatsRaw)) : null,
      setRoot: Boolean(result.data.setRoot),
      thumb: typeof result.data.thumb === "string" ? result.data.thumb : null,
      icon: typeof result.data.icon === "string" ? result.data.icon : null,
      timestamp: timestamp != null ? Math.floor(timestamp) : null,
    },
  };
}

export async function fetchBackendOrdersBySlug(
  slug: string,
  options?: { rank?: number | null },
): Promise<BackendFetchResult<BackendOrdersPayload>> {
  const normalizedSlug = normalizeWfmSlug(slug);
  if (!normalizedSlug) return { status: "not_found" };

  const rankRaw = toFiniteNumber(options?.rank ?? null);
  const rank = rankRaw != null && rankRaw >= 0 ? Math.floor(rankRaw) : null;
  const path =
    rank != null
      ? `/v1/orders/${encodeURIComponent(normalizedSlug)}?rank=${encodeURIComponent(String(rank))}`
      : `/v1/orders/${encodeURIComponent(normalizedSlug)}`;

  const result = await fetchBackendJson(path);
  if (result.status !== "ok") return result;

  const timestamp = toFiniteNumber(result.data.timestamp);
  const responseSlug =
    typeof result.data.slug === "string" ? normalizeWfmSlug(result.data.slug) : normalizedSlug;

  return {
    status: "ok",
    data: {
      slug: responseSlug || normalizedSlug,
      sell: parseOrderBookSide(result.data.sell),
      buy: parseOrderBookSide(result.data.buy),
      timestamp: timestamp != null ? Math.floor(timestamp) : null,
    },
  };
}

export async function fetchBackendOrderSummaryBySlug(
  slug: string,
  options?: { rank?: number | null },
): Promise<BackendFetchResult<BackendOrderSummaryPayload>> {
  const normalizedSlug = normalizeWfmSlug(slug);
  if (!normalizedSlug) return { status: "not_found" };

  const rankRaw = toFiniteNumber(options?.rank ?? null);
  const rank = rankRaw != null && rankRaw >= 0 ? Math.floor(rankRaw) : null;
  const path =
    rank != null
      ? `/v1/order-summary/${encodeURIComponent(normalizedSlug)}?rank=${encodeURIComponent(String(rank))}`
      : `/v1/order-summary/${encodeURIComponent(normalizedSlug)}`;

  const result = await fetchBackendJson(path);
  if (result.status !== "ok") return result;

  const timestamp = toFiniteNumber(result.data.timestamp);
  const responseRank = toFiniteNumber(result.data.rank);
  const responseSlug =
    typeof result.data.slug === "string" ? normalizeWfmSlug(result.data.slug) : normalizedSlug;

  return {
    status: "ok",
    data: {
      slug: responseSlug || normalizedSlug,
      rank: responseRank != null && responseRank >= 0 ? Math.floor(responseRank) : rank,
      wts: (() => {
        const value = toFiniteNumber(result.data.wts);
        return value != null && value >= 0 ? Math.round(value) : null;
      })(),
      wtb: (() => {
        const value = toFiniteNumber(result.data.wtb);
        return value != null && value >= 0 ? Math.round(value) : null;
      })(),
      timestamp: timestamp != null ? Math.floor(timestamp) : null,
    },
  };
}
