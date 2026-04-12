import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("wfmCatalog");

/**
 * wfmCatalog.ts — Warframe.market item catalog (main-process only)
 *
 * Loads the full WFM item list on first demand and keeps it cached in memory.
 * Uses the v2 API directly (v1 /items returns 404).
 * Exposes lookups used by order forms and the renderer item-link mapping IPC.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

import { WFM_HEADERS as _BASE_HEADERS, WFM_ASSET_BASE } from "../config/shared/wfm";

const WFM_V2_BASE = "https://api.warframe.market/v2";
const WFM_HEADERS: Record<string, string> = Object.freeze({
  ..._BASE_HEADERS,
  "User-Agent": "WarframeCompanion/1.0",
});
const WFM_THUMB_BASE = WFM_ASSET_BASE;
const WFM_ITEM_URL_BASE = "https://warframe.market/items/";
const ITEM_PATH_CANDIDATES: ReadonlyArray<string> = Object.freeze([
  "/items",
  "/collections/items",
]);
const NAME_SET_SUFFIX = " set";
const SLUG_SET_SUFFIX_RE = /_set$/;
const SEARCH_MIN_QUERY_LENGTH = 2;
const SEARCH_SCAN_MULTIPLIER = 2;

// ── State ─────────────────────────────────────────────────────────────────────

interface CatalogItem {
  id: string | null;
  url_name: string;
  item_name: string;
  thumb: string | null;
  icon: string | null;
  maxRank: number | null;
  gameRef: string | null;
}

let _items: CatalogItem[] = [];
let _byId = new Map<string, CatalogItem>();
let _bySlug = new Map<string, CatalogItem>();
let _byNameLc = new Map<string, CatalogItem>();
let _byGameRefLc = new Map<string, CatalogItem>();
let _loaded = false;
let _loading: Promise<void> | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _unwrap(obj: any): any {
  if (!obj) return null;
  if (obj.data !== undefined) return obj.data;
  if (obj.payload !== undefined) return obj.payload;
  return obj;
}

function _normalise(raw: any): CatalogItem {
  const source = raw && typeof raw === "object" ? raw : {};
  const slug: string = source.slug || source.url_name || source._slug || "";
  const name: string =
    source?.i18n?.en?.name ||
    source?.i18n?.en?.itemName ||
    source?.i18n?.en?.item_name ||
    source?.item_name ||
    source?.itemName ||
    source?.name ||
    slug.replace(/_/g, " ").replace(/\b[a-z]/g, (c: string) => c.toUpperCase());
  const thumb: string | null = source?.i18n?.en?.thumb || source.thumb || null;
  const icon: string | null = source?.i18n?.en?.icon || source.icon || null;
  const rawMaxRank = Number(source.maxRank ?? source.max_rank ?? null);
  const maxRank = Number.isFinite(rawMaxRank) && rawMaxRank > 0 ? Math.floor(rawMaxRank) : null;
  const gameRef: string | null =
    typeof source.gameRef === "string" && source.gameRef.trim().length > 0
      ? source.gameRef
      : typeof source.game_ref === "string" && source.game_ref.trim().length > 0
        ? source.game_ref
        : null;
  return {
    id: source.id || null,
    url_name: slug,
    item_name: name,
    thumb: thumb ? (thumb.startsWith("http") ? thumb : WFM_THUMB_BASE + thumb) : null,
    icon: icon ? (icon.startsWith("http") ? icon : WFM_THUMB_BASE + icon) : null,
    maxRank,
    gameRef,
  };
}

// ── Loader ────────────────────────────────────────────────────────────────────

async function _load(): Promise<void> {
  if (_loaded) return;
  if (_loading) return _loading;

  _loading = (async () => {
    try {
      log.log("[WFMCatalog] Fetching item catalog (v2)…");

      let rawItems: any[] = [];

      for (const path of ITEM_PATH_CANDIDATES) {
        if (rawItems.length) break;
        try {
          const resp = await fetch(`${WFM_V2_BASE}${path}`, { headers: WFM_HEADERS });
          if (!resp.ok) {
            log.warn(`[WFMCatalog] ${path} returned ${resp.status}`);
            continue;
          }
          const json = await resp.json();
          const data = _unwrap(json);
          if (!data) continue;

          if (Array.isArray(data.items)) {
            rawItems = data.items;
          } else if (data.items && typeof data.items === "object") {
            rawItems = Object.entries(data.items).map(([k, v]) =>
              v && typeof v === "object" ? { _slug: k, ...(v as object) } : { _slug: k },
            );
          } else if (Array.isArray(data)) {
            rawItems = data;
          }
        } catch (e) {
          log.warn(`[WFMCatalog] fetch ${path} failed:`, normalizeErrorMessage(e));
        }
      }

      _items = rawItems.map(_normalise);

      _byId.clear();
      _bySlug.clear();
      _byNameLc.clear();
      _byGameRefLc.clear();

      for (const item of _items) {
        if (item.id) _byId.set(item.id, item);
        if (item.url_name) _bySlug.set(item.url_name, item);
        const nameLc = (item.item_name || "").toLowerCase();
        if (nameLc) _byNameLc.set(nameLc, item);
        const gameRefLc = (item.gameRef || "").toLowerCase();
        if (gameRefLc) _byGameRefLc.set(gameRefLc, item);

        const slugName = item.url_name
          .replace(SLUG_SET_SUFFIX_RE, "")
          .replace(/_/g, " ")
          .replace(/\b[a-z]/g, (c: string) => c.toUpperCase());
        const slugNameLc = slugName.toLowerCase();
        if (slugNameLc && !_byNameLc.has(slugNameLc)) {
          _byNameLc.set(slugNameLc, item);
        }
      }

      _loaded = true;
      log.log(`[WFMCatalog] Loaded ${_items.length} items.`);
    } finally {
      _loading = null;
    }
  })();

  return _loading;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function searchItems(
  query: string,
  limit: number = 20,
): Promise<CatalogItem[]> {
  await _load();
  if (!query || query.length < SEARCH_MIN_QUERY_LENGTH) return [];

  const q = query.toLowerCase().trim();

  const startsWith: CatalogItem[] = [];
  const contains: CatalogItem[] = [];

  for (const item of _items) {
    const name = (item.item_name || "").toLowerCase();
    if (name.startsWith(q)) {
      startsWith.push(item);
    } else if (name.includes(q)) {
      contains.push(item);
    }
    if (startsWith.length + contains.length >= limit * SEARCH_SCAN_MULTIPLIER) break;
  }

  return [...startsWith, ...contains].slice(0, limit);
}

export function isLoaded(): boolean {
  return _loaded;
}

export async function ensureLoaded(): Promise<number> {
  await _load();
  return _items.length;
}

export function lookupByName(itemName: string): CatalogItem | null {
  if (!itemName) return null;
  const key = String(itemName).toLowerCase();
  let item = _byNameLc.get(key);
  if (item) return item;

  item = _byNameLc.get(`${key}${NAME_SET_SUFFIX}`);
  if (item) return item;

  if (key.endsWith(NAME_SET_SUFFIX)) {
    return _byNameLc.get(key.slice(0, -NAME_SET_SUFFIX.length)) || null;
  }

  return null;
}

export function getMarketUrl(itemName: string): string | null {
  const item = lookupByName(itemName);
  if (!item?.url_name) return null;
  return `${WFM_ITEM_URL_BASE}${item.url_name}`;
}

export function getRendererLookup(): Record<string, any> {
  const lookup: Record<string, any> = {};
  for (const [name, item] of _byNameLc.entries()) {
    lookup[name] = {
      url_name: item.url_name,
      item_name: item.item_name,
      thumb: item.thumb,
      icon: item.icon,
      maxRank: item.maxRank,
      gameRef: item.gameRef,
    };
  }
  for (const [gameRefLc, item] of _byGameRefLc.entries()) {
    if (lookup[gameRefLc]) continue;
    lookup[gameRefLc] = {
      url_name: item.url_name,
      item_name: item.item_name,
      thumb: item.thumb,
      icon: item.icon,
      maxRank: item.maxRank,
      gameRef: item.gameRef,
    };
  }
  return lookup;
}

export async function lookupById(id: string): Promise<CatalogItem | null> {
  await _load();
  return _byId.get(id) || null;
}

export async function lookupBySlug(slug: string): Promise<CatalogItem | null> {
  await _load();
  return _bySlug.get(slug) || null;
}

export function prefetch(): void {
  _load().catch((err) => log.error("[WFMCatalog] prefetch failed:", normalizeErrorMessage(err)));
}