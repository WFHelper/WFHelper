const WFM_HEADERS = {
  Platform: "pc",
  Language: "en",
  Crossplay: "true",
  Accept: "application/json",
};

const WFM_ASSET_BASE = "https://warframe.market/static/assets/";
const META_CACHE_KEY = "wfm_item_meta_cache_v1";
const META_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface WfmItemMeta {
  slug: string;
  ducats: number | null;
  setRoot: boolean;
  thumb: string | null;
  icon: string | null;
  timestamp: number;
}

interface PersistedMeta {
  slug: string;
  ducats: number | null;
  setRoot: boolean;
  thumb: string | null;
  icon: string | null;
  timestamp: number;
}

const metaCache = new Map<string, WfmItemMeta | null>();
const inFlight = new Map<string, Promise<WfmItemMeta | null>>();

function storageOrNull(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
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

  const ducatsRaw = data.ducats;
  const ducats =
    typeof ducatsRaw === "number" && Number.isFinite(ducatsRaw)
      ? Math.max(0, Math.round(ducatsRaw))
      : null;

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

function hydratePersistentCache(): void {
  const storage = storageOrNull();
  if (!storage) return;

  try {
    const raw = storage.getItem(META_CACHE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw) as { v?: number; entries?: PersistedMeta[] };
    if (parsed.v !== 1 || !Array.isArray(parsed.entries)) return;

    for (const entry of parsed.entries) {
      if (!entry?.slug || typeof entry.slug !== "string") continue;
      const hydrated: WfmItemMeta = {
        slug: entry.slug,
        ducats: typeof entry.ducats === "number" ? entry.ducats : null,
        setRoot: Boolean(entry.setRoot),
        thumb: withAssetBase(entry.thumb),
        icon: withAssetBase(entry.icon),
        timestamp: typeof entry.timestamp === "number" ? entry.timestamp : 0,
      };
      if (!isFresh(hydrated)) continue;
      metaCache.set(entry.slug, hydrated);
    }
  } catch (error) {
    console.warn("[WFM] Failed to hydrate item meta cache:", error);
  }
}

function persistCache(): void {
  const storage = storageOrNull();
  if (!storage) return;

  try {
    const entries: PersistedMeta[] = [];
    for (const [slug, meta] of metaCache.entries()) {
      if (!meta || !isFresh(meta)) continue;
      entries.push({
        slug,
        ducats: meta.ducats,
        setRoot: meta.setRoot,
        thumb: meta.thumb,
        icon: meta.icon,
        timestamp: meta.timestamp,
      });
    }
    storage.setItem(META_CACHE_KEY, JSON.stringify({ v: 1, entries }));
  } catch (error) {
    console.warn("[WFM] Failed to persist item meta cache:", error);
  }
}

hydratePersistentCache();

export async function fetchWfmItemMetaBySlug(
  slug: string | null | undefined,
): Promise<WfmItemMeta | null> {
  if (!slug) return null;

  const cached = metaCache.get(slug);
  if (cached && isFresh(cached)) return cached;
  if (cached === null) return null;

  const existing = inFlight.get(slug);
  if (existing) return existing;

  const task = (async () => {
    try {
      const response = await fetch(`https://api.warframe.market/v2/items/${slug}`, {
        headers: WFM_HEADERS,
      });
      if (!response.ok) {
        metaCache.set(slug, null);
        persistCache();
        return null;
      }

      const json = (await response.json()) as unknown;
      const parsed = toMeta(slug, json);
      metaCache.set(slug, parsed);
      persistCache();
      return parsed;
    } catch (error) {
      console.warn(`[WFM] item meta fetch failed for ${slug}:`, error);
      metaCache.set(slug, null);
      persistCache();
      return null;
    } finally {
      inFlight.delete(slug);
    }
  })();

  inFlight.set(slug, task);
  return task;
}
