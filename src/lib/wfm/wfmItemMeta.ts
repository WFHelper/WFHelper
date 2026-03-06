import {
  fetchBackendMetaBySlug,
  normalizeWfmSlug,
  shouldDirectFallback,
  type BackendRequestPriority,
} from "./backendLite.js";
import { log } from "../log.js";

const WFM_HEADERS = {
  Platform: "pc",
  Language: "en",
  Crossplay: "true",
  Accept: "application/json",
};

const WFM_ASSET_BASE = "https://warframe.market/static/assets/";
const META_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const META_NO_DATA_TTL_MS = 6 * 60 * 60 * 1000;

export interface WfmItemMeta {
  slug: string;
  ducats: number | null;
  setRoot: boolean;
  thumb: string | null;
  icon: string | null;
  timestamp: number;
}

export interface FetchMetaOptions {
  priority?: BackendRequestPriority;
}

const metaCache = new Map<string, WfmItemMeta>();
const metaNoDataCache = new Map<string, number>();
const inFlight = new Map<string, Promise<WfmItemMeta | null>>();

function toFiniteOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function isNoDataCacheFresh(cachedAt: number | null | undefined): boolean {
  if (typeof cachedAt !== "number" || !Number.isFinite(cachedAt)) return false;
  return Date.now() - cachedAt < META_NO_DATA_TTL_MS;
}

function rememberNoData(slug: string): void {
  metaNoDataCache.set(slug, Date.now());
}

function withAssetBase(path: unknown): string | null {
  if (typeof path !== "string" || !path.trim()) return null;
  return path.startsWith("http") ? path : `${WFM_ASSET_BASE}${path}`;
}

function isFresh(entry: WfmItemMeta): boolean {
  return Date.now() - entry.timestamp < META_TTL_MS;
}

function toMeta(slug: string, json: unknown): WfmItemMeta | null {
  const data = (json as { data?: Record<string, unknown> })?.data;
  if (!data || typeof data !== "object") return null;

  const ducatsRaw = toFiniteOrNull(data.ducats);
  const ducats = ducatsRaw != null ? Math.max(0, Math.round(ducatsRaw)) : null;

  const i18nEn = (data.i18n as { en?: Record<string, unknown> } | undefined)?.en || {};
  const thumb = withAssetBase(i18nEn.thumb || data.thumb || null);
  const icon = withAssetBase(i18nEn.icon || data.icon || null);

  return {
    slug,
    ducats,
    setRoot: Boolean(data.setRoot),
    thumb,
    icon,
    timestamp: Date.now(),
  };
}

type DirectMetaResult =
  | { status: "ok"; data: WfmItemMeta }
  | { status: "not_found" }
  | { status: "transient" };

async function fetchDirectMetaBySlug(slug: string): Promise<DirectMetaResult> {
  const response = await fetch(`https://api.warframe.market/v2/items/${slug}`, {
    headers: WFM_HEADERS,
  });
  if (response.status === 429 || response.status >= 500) {
    return { status: "transient" };
  }
  if (!response.ok) {
    return { status: "not_found" };
  }

  const json = (await response.json()) as unknown;
  const parsed = toMeta(slug, json);
  if (!parsed) return { status: "not_found" };
  return { status: "ok", data: parsed };
}

export async function fetchWfmItemMetaBySlug(
  slug: string | null | undefined,
  options?: FetchMetaOptions,
): Promise<WfmItemMeta | null> {
  const normalizedSlug = normalizeWfmSlug(slug);
  if (!normalizedSlug) return null;

  const priority = options?.priority || "low";

  const noDataCachedAt = metaNoDataCache.get(normalizedSlug);
  if (isNoDataCacheFresh(noDataCachedAt)) {
    return null;
  }
  if (noDataCachedAt != null) {
    metaNoDataCache.delete(normalizedSlug);
  }

  const cached = metaCache.get(normalizedSlug);
  if (cached && isFresh(cached)) {
    return cached;
  }

  const existing = inFlight.get(normalizedSlug);
  if (existing) return existing;

  const fallbackAllowed = shouldDirectFallback(priority);

  const task = (async () => {
    try {
      const backendResult = await fetchBackendMetaBySlug(normalizedSlug);
      if (backendResult.status === "ok") {
        const backendDucats = toFiniteOrNull(backendResult.data.ducats);
        const backendTimestamp = toFiniteOrNull(backendResult.data.timestamp);
        const backendMeta: WfmItemMeta = {
          slug: normalizeWfmSlug(backendResult.data.slug) || normalizedSlug,
          ducats: backendDucats != null ? Math.max(0, Math.round(backendDucats)) : null,
          setRoot: backendResult.data.setRoot,
          thumb: withAssetBase(backendResult.data.thumb),
          icon: withAssetBase(backendResult.data.icon),
          timestamp: backendTimestamp != null ? Math.floor(backendTimestamp) : Date.now(),
        };

        const shouldEnrichFromDirect =
          priority === "high" &&
          (backendMeta.ducats == null || (!backendMeta.thumb && !backendMeta.icon));

        if (shouldEnrichFromDirect && fallbackAllowed) {
          const directMeta = await fetchDirectMetaBySlug(normalizedSlug);
          if (directMeta.status === "ok") {
            metaCache.set(normalizedSlug, directMeta.data);
            metaNoDataCache.delete(normalizedSlug);
            return directMeta.data;
          }
        }

        metaCache.set(normalizedSlug, backendMeta);
        metaNoDataCache.delete(normalizedSlug);
        return backendMeta;
      }

      if (backendResult.status === "not_found") {
        rememberNoData(normalizedSlug);
        return null;
      }

      if (!fallbackAllowed) {
        return null;
      }

      const directMeta = await fetchDirectMetaBySlug(normalizedSlug);
      if (directMeta.status === "ok") {
        metaCache.set(normalizedSlug, directMeta.data);
        metaNoDataCache.delete(normalizedSlug);
        return directMeta.data;
      }

      if (directMeta.status === "not_found") {
        rememberNoData(normalizedSlug);
        return null;
      }

      return null;
    } catch (error) {
      log.warn(`[WFM] item meta fetch failed for ${normalizedSlug}:`, error);
      return null;
    } finally {
      inFlight.delete(normalizedSlug);
    }
  })();

  inFlight.set(normalizedSlug, task);
  return task;
}
