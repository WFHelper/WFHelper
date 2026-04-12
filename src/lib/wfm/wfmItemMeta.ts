import {
  fetchBackendMetaBySlug,
  normalizeWfmSlug,
  shouldDirectFallback,
  type BackendRequestPriority,
} from "./backendLite.js";
import { log } from "../log.js";
import { toFiniteNumber } from "../../../config/shared/numeric.js";
import { WFM_HEADERS, WFM_ASSET_BASE } from "../../../config/shared/wfm.js";
import { isWfmExcludedSlug } from "../../../config/shared/wfmExclusions.js";

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
// One-time-per-session warning set — avoids log spam on repeated hydration.
const _warnedNoMetaSlugs = new Set<string>();

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

  const ducatsRaw = toFiniteNumber(data.ducats);
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

/**
 * Bulk-import meta entries from the snapshot blob.
 * Only imports entries that are fresher than what's already in memory (or absent).
 * Never throws.
 */
export function importMetaFromSnapshot(
  data: Record<string, WfmItemMeta>,
): number {
  let count = 0;
  for (const [slug, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.slug !== "string" || typeof entry.timestamp !== "number") continue;
    if (!isFresh(entry)) continue;
    const existing = metaCache.get(slug);
    if (existing && existing.timestamp >= entry.timestamp) continue;
    metaCache.set(slug, {
      slug: entry.slug,
      ducats: entry.ducats != null ? Math.max(0, Math.round(entry.ducats)) : null,
      setRoot: Boolean(entry.setRoot),
      thumb: typeof entry.thumb === "string" ? entry.thumb : null,
      icon: typeof entry.icon === "string" ? entry.icon : null,
      timestamp: Math.round(entry.timestamp),
    });
    count++;
  }
  return count;
}

export async function fetchWfmItemMetaBySlug(
  slug: string | null | undefined,
  options?: FetchMetaOptions,
): Promise<WfmItemMeta | null> {
  const normalizedSlug = normalizeWfmSlug(slug);
  if (!normalizedSlug) return null;
  if (isWfmExcludedSlug(normalizedSlug)) return null;

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
        const backendDucats = toFiniteNumber(backendResult.data.ducats);
        const backendTimestamp = toFiniteNumber(backendResult.data.timestamp);
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
        if (!_warnedNoMetaSlugs.has(normalizedSlug)) {
          _warnedNoMetaSlugs.add(normalizedSlug);
          log.warn(`[WFM meta] No listing for "${normalizedSlug}" — item may not exist on warframe.market. If non-tradable, add to WFM_EXCLUDED_SLUGS in config/shared/wfmExclusions.ts`);
        }
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
        if (!_warnedNoMetaSlugs.has(normalizedSlug)) {
          _warnedNoMetaSlugs.add(normalizedSlug);
          log.warn(`[WFM meta] No listing for "${normalizedSlug}" — item may not exist on warframe.market. If non-tradable, add to WFM_EXCLUDED_SLUGS in config/shared/wfmExclusions.ts`);
        }
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
