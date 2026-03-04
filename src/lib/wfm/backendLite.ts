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

export type BackendFetchResult<T> =
  | { status: "ok"; data: T }
  | { status: "not_found" }
  | { status: "unavailable" }
  | { status: "error" };

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
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
): Promise<BackendFetchResult<BackendPricePayload>> {
  if (!slug) return { status: "not_found" };

  const result = await fetchBackendJson(`/v1/prices/${encodeURIComponent(slug)}`);
  if (result.status !== "ok") return result;

  const median = toFiniteNumber(result.data.median);
  if (median == null || median <= 0) return { status: "not_found" };

  const timestamp = toFiniteNumber(result.data.timestamp);

  return {
    status: "ok",
    data: {
      slug: typeof result.data.slug === "string" ? result.data.slug : slug,
      median: Math.round(Math.abs(median)),
      timestamp: timestamp != null ? Math.floor(timestamp) : null,
    },
  };
}

export async function fetchBackendMetaBySlug(
  slug: string,
): Promise<BackendFetchResult<BackendMetaPayload>> {
  if (!slug) return { status: "not_found" };

  const result = await fetchBackendJson(`/v1/meta/${encodeURIComponent(slug)}`);
  if (result.status !== "ok") return result;

  const ducatsRaw = toFiniteNumber(result.data.ducats);
  const timestamp = toFiniteNumber(result.data.timestamp);

  return {
    status: "ok",
    data: {
      slug: typeof result.data.slug === "string" ? result.data.slug : slug,
      ducats: ducatsRaw != null ? Math.max(0, Math.round(ducatsRaw)) : null,
      setRoot: Boolean(result.data.setRoot),
      thumb: typeof result.data.thumb === "string" ? result.data.thumb : null,
      icon: typeof result.data.icon === "string" ? result.data.icon : null,
      timestamp: timestamp != null ? Math.floor(timestamp) : null,
    },
  };
}
