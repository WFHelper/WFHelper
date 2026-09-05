import { normalizeDucats, toFiniteNumber } from "../../../config/shared/numeric.js";
import { BACKEND_BOOTSTRAP_FAILURE_COOLDOWN_MS } from "../../../config/runtime/cacheConfig.js";
import { BACKEND_URL } from "../../../config/shared/backendConfig.js";
import { normalizeWfmSlug } from "../../../config/shared/wfm.js";
import { normalizeSubtype } from "../../../config/shared/wfmOrders.js";
import type { RequestPriority } from "./wfmPrice.js";
import { fetchWithTimeout, withAbortTimeout } from "../../../config/shared/fetchWithTimeout.js";

export type BackendRequestPriority = RequestPriority;

type FallbackMode = "always" | "high" | "never";
type BackendRequestCache =
  | "default"
  | "force-cache"
  | "no-cache"
  | "no-store"
  | "only-if-cached"
  | "reload";
interface BackendFetchInit {
  headers: Record<string, string>;
  cache?: BackendRequestCache;
}

const RAW_BACKEND_URL = (import.meta.env.VITE_WFM_BACKEND_URL || BACKEND_URL).trim();
const BACKEND_BASE_URL = RAW_BACKEND_URL.replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 3500;

// Optional bootstrap tokens are short-lived and bound to the caller's IP and
// User-Agent. See backend/worker/ARCHITECTURE.md for deployment order.

const BOOTSTRAP_ENABLED = (import.meta.env.VITE_WFM_BACKEND_BOOTSTRAP_ENABLED || "").trim() === "1";
const BOOTSTRAP_HEADER = "x-wfhelper-bootstrap";
const BOOTSTRAP_REFRESH_MARGIN_MS = 60_000; // re-fetch 1 min before expiry

let _bootstrapToken: string | null = null;
let _bootstrapTokenExpiry = 0;
let _bootstrapInFlight: Promise<string | null> | null = null;
// Back off after bootstrap failures so parallel requests do not pile up on
// the endpoint.
let _bootstrapRetryAfter = 0;

async function ensureBootstrapToken(): Promise<string | null> {
  if (!BOOTSTRAP_ENABLED || !isBackendLiteConfigured()) return null;

  // Return cached token if still fresh (with margin)
  if (_bootstrapToken && Date.now() < _bootstrapTokenExpiry - BOOTSTRAP_REFRESH_MARGIN_MS) {
    return _bootstrapToken;
  }

  // Back off after recent failures so parallel requests don't all retry at once
  if (Date.now() < _bootstrapRetryAfter) return null;

  if (_bootstrapInFlight) return _bootstrapInFlight;

  _bootstrapInFlight = fetchBootstrapToken().finally(() => {
    _bootstrapInFlight = null;
  });
  return _bootstrapInFlight;
}

async function fetchBootstrapToken(): Promise<string | null> {
  try {
    // The deadline covers the body read as well as the headers.
    return await withAbortTimeout(REQUEST_TIMEOUT_MS, async (signal) => {
      const response = await fetch(`${BACKEND_BASE_URL}/v1/bootstrap`, {
        signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        _bootstrapRetryAfter = Date.now() + BACKEND_BOOTSTRAP_FAILURE_COOLDOWN_MS;
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
        _bootstrapRetryAfter = Date.now() + BACKEND_BOOTSTRAP_FAILURE_COOLDOWN_MS;
        return null;
      }
      _bootstrapRetryAfter = 0;
      _bootstrapToken = json.data.token;
      _bootstrapTokenExpiry = json.data.expiresAt;
      return _bootstrapToken;
    });
  } catch {
    _bootstrapRetryAfter = Date.now() + BACKEND_BOOTSTRAP_FAILURE_COOLDOWN_MS;
    return null;
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

export function shouldDirectFallback(priority: BackendRequestPriority): boolean {
  if (!isBackendLiteConfigured()) return true;
  if (FALLBACK_MODE === "always") return true;
  if (FALLBACK_MODE === "never") return false;
  return priority === "high";
}

interface BackendPricePayload {
  slug: string;
  median: number;
  rank: number | null;
  timestamp: number | null;
}

interface BackendMetaPayload {
  slug: string;
  ducats: number | null;
  setRoot: boolean;
  thumb: string | null;
  icon: string | null;
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

interface BackendRequestOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  cache?: BackendRequestCache;
  allowStatuses?: number[];
}

async function requestBackend(
  pathname: string,
  options: BackendRequestOptions = {},
): Promise<Response | null> {
  if (!isBackendLiteConfigured()) return null;

  const bootstrapToken = await ensureBootstrapToken();
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (bootstrapToken) headers[BOOTSTRAP_HEADER] = bootstrapToken;
    if (options.headers) Object.assign(headers, options.headers);

    const requestInit: BackendFetchInit = { headers };
    if (options.cache) requestInit.cache = options.cache;

    // Callers read the body themselves, so the deadline ends at the headers.
    const response = await fetchWithTimeout(
      `${BACKEND_BASE_URL}${pathname}`,
      timeoutMs,
      requestInit,
    );

    if (response.status === 401) {
      invalidateBootstrapToken();
      return null;
    }
    if (!response.ok && !options.allowStatuses?.includes(response.status)) return null;
    return response;
  } catch {
    return null;
  }
}

/** Authenticated GET; raw Response on 2xx, null on any error. Caller parses. */
export async function fetchBackendRaw(
  pathname: string,
  options?: { timeoutMs?: number; headers?: Record<string, string>; cache?: BackendRequestCache },
): Promise<Response | null> {
  return requestBackend(pathname, { ...options, allowStatuses: [304] });
}

async function fetchBackendJson(
  pathname: string,
): Promise<BackendFetchResult<Record<string, unknown>>> {
  if (!isBackendLiteConfigured()) return { status: "unavailable" };

  const response = await requestBackend(pathname, { allowStatuses: [404] });
  if (!response) return { status: "error" };
  if (response.status === 404) return { status: "not_found" };

  try {
    const json = (await response.json()) as { ok?: boolean; data?: unknown };
    if (!json || json.ok !== true || !json.data || typeof json.data !== "object") {
      return { status: "not_found" };
    }
    return { status: "ok", data: json.data as Record<string, unknown> };
  } catch {
    return { status: "error" };
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

  const timestamp = toFiniteNumber(result.data.timestamp);
  const responseSlug =
    typeof result.data.slug === "string" ? normalizeWfmSlug(result.data.slug) : normalizedSlug;

  return {
    status: "ok",
    data: {
      slug: responseSlug || normalizedSlug,
      ducats: normalizeDucats(result.data.ducats),
      setRoot: Boolean(result.data.setRoot),
      thumb: typeof result.data.thumb === "string" ? result.data.thumb : null,
      icon: typeof result.data.icon === "string" ? result.data.icon : null,
      timestamp: timestamp != null ? Math.floor(timestamp) : null,
    },
  };
}

export async function fetchBackendOrderSummaryBySlug(
  slug: string,
  options?: { rank?: number | null; subtype?: string | null },
): Promise<BackendFetchResult<BackendOrderSummaryPayload>> {
  const normalizedSlug = normalizeWfmSlug(slug);
  if (!normalizedSlug) return { status: "not_found" };

  const rankRaw = toFiniteNumber(options?.rank ?? null);
  const rank = rankRaw != null && rankRaw >= 0 ? Math.floor(rankRaw) : null;
  // "regular" means the default variant, which the worker's subtype allowlist
  // rejects with a 400; the shared normaliser drops it back to the plain path.
  const subtype = normalizeSubtype(options?.subtype);
  // The worker treats subtype and rank as different validation paths; a relic
  // request never carries a rank.
  const path = subtype
    ? `/v1/order-summary/${encodeURIComponent(normalizedSlug)}?subtype=${encodeURIComponent(subtype)}`
    : rank != null
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
