import { toFiniteNumber } from "../../../config/shared/numeric.js";
import { normalizeWfmSlug as _normalizeWfmSlug } from "../../../config/shared/wfm.js";

/** Re-export from shared module for existing renderer consumers. */
export const normalizeWfmSlug = _normalizeWfmSlug;

export type BackendRequestPriority = "high" | "normal" | "low";

type FallbackMode = "always" | "high" | "never";

const RAW_BACKEND_URL = (import.meta.env.VITE_WFM_BACKEND_URL || "").trim();
const BACKEND_BASE_URL = RAW_BACKEND_URL.replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 3500;

// ── Bootstrap token ─────────────────────────────────────────────────────────
// When VITE_WFM_BACKEND_BOOTSTRAP_ENABLED=1 the client fetches a short-lived
// HMAC-signed token from /v1/bootstrap and attaches it to every subsequent
// backend request via x-wfhelper-bootstrap.  The server binds the token to the
// caller's IP + User-Agent hash, so it cannot be replayed from other machines.
//
// Deployment sequence (see worker ARCHITECTURE.md):
//   1. wrangler secret put BOOTSTRAP_TOKEN_SECRET
//   2. Deploy app with VITE_WFM_BACKEND_BOOTSTRAP_ENABLED=1
//   3. Set PUBLIC_BOOTSTRAP_REQUIRED=1 in wrangler.jsonc and redeploy worker

const BOOTSTRAP_ENABLED =
  (import.meta.env.VITE_WFM_BACKEND_BOOTSTRAP_ENABLED || "").trim() === "1";
const BOOTSTRAP_HEADER = "x-wfhelper-bootstrap";
const BOOTSTRAP_REFRESH_MARGIN_MS = 60_000; // re-fetch 1 min before expiry

let _bootstrapToken: string | null = null;
let _bootstrapTokenExpiry = 0;
// After a failed bootstrap fetch, suppress retries for this long so a
// CSP block / network error doesn't cause every parallel request to pile
// up on the bootstrap endpoint.
let _bootstrapRetryAfter = 0;
const BOOTSTRAP_FAILURE_COOLDOWN_MS = 30_000;

async function ensureBootstrapToken(): Promise<string | null> {
  if (!BOOTSTRAP_ENABLED || !isBackendLiteConfigured()) return null;

  // Return cached token if still fresh (with margin)
  if (_bootstrapToken && Date.now() < _bootstrapTokenExpiry - BOOTSTRAP_REFRESH_MARGIN_MS) {
    return _bootstrapToken;
  }

  // Back off after recent failures so parallel requests don't all retry at once
  if (Date.now() < _bootstrapRetryAfter) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/v1/bootstrap`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      _bootstrapRetryAfter = Date.now() + BOOTSTRAP_FAILURE_COOLDOWN_MS;
      return null;
    }
    const json = (await response.json()) as {
      ok?: boolean;
      data?: { token?: string; expiresAt?: number };
    };
    if (
      !json?.ok ||
      typeof json.data?.token !== "string" ||
      typeof json.data?.expiresAt !== "number"
    ) {
      _bootstrapRetryAfter = Date.now() + BOOTSTRAP_FAILURE_COOLDOWN_MS;
      return null;
    }
    _bootstrapRetryAfter = 0;
    _bootstrapToken = json.data.token;
    _bootstrapTokenExpiry = json.data.expiresAt;
    return _bootstrapToken;
  } catch {
    _bootstrapRetryAfter = Date.now() + BOOTSTRAP_FAILURE_COOLDOWN_MS;
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function invalidateBootstrapToken(): void {
  _bootstrapToken = null;
  _bootstrapTokenExpiry = 0;
}

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

export function getBackendBaseUrl(): string {
  return BACKEND_BASE_URL;
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

/**
 * Make a raw authenticated GET request to the backend.
 * Handles bootstrap token and timeout. Returns the raw Response on 2xx,
 * or null on any network/auth error. Callers are responsible for parsing the body.
 */
export async function fetchBackendRaw(
  pathname: string,
  options?: { timeoutMs?: number; headers?: Record<string, string> },
): Promise<Response | null> {
  if (!isBackendLiteConfigured()) return null;

  const bootstrapToken = await ensureBootstrapToken();
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (bootstrapToken) headers[BOOTSTRAP_HEADER] = bootstrapToken;
    if (options?.headers) Object.assign(headers, options.headers);

    const response = await fetch(`${BACKEND_BASE_URL}${pathname}`, {
      signal: controller.signal,
      headers,
    });

    if (response.status === 401) {
      invalidateBootstrapToken();
      return null;
    }
    // 304 is a valid success response — return it so callers can handle it.
    if (!response.ok && response.status !== 304) return null;
    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBackendJson(
  pathname: string,
): Promise<BackendFetchResult<Record<string, unknown>>> {
  if (!isBackendLiteConfigured()) {
    return { status: "unavailable" };
  }

  const bootstrapToken = await ensureBootstrapToken();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (bootstrapToken) headers[BOOTSTRAP_HEADER] = bootstrapToken;

    const response = await fetch(`${BACKEND_BASE_URL}${pathname}`, {
      signal: controller.signal,
      headers,
    });

    if (response.status === 401) {
      // Token was rejected (expired or server secret rotated) — invalidate so
      // the next call fetches a fresh one.  Treat this call as an error so the
      // caller falls through to the direct-WFM fallback.
      invalidateBootstrapToken();
      return { status: "error" };
    }
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
