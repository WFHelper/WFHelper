"use strict";

const log = require("./logger").withScope("wfmCatalog");

/**
 * wfmCatalog.js — Warframe.market item catalog (main-process only)
 *
 * Loads the full WFM item list on first demand and keeps it cached in memory.
 * Uses the v2 API directly (v1 /items returns 404).
 * Exposes lookups used by order forms and the renderer item-link mapping IPC.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const WFM_V2_BASE = "https://api.warframe.market/v2";
const WFM_HEADERS = {
  Platform: "pc",
  Language: "en",
  Crossplay: "true",
  Accept: "application/json",
  "User-Agent": "WarframeCompanion/1.0",
};
const WFM_THUMB_BASE = "https://warframe.market/static/assets/";
const WFM_ITEM_URL_BASE = "https://warframe.market/items/";
const ITEM_PATH_CANDIDATES = Object.freeze(["/items", "/collections/items"]);
const NAME_SET_SUFFIX = " set";
const SLUG_SET_SUFFIX_RE = /_set$/;
const SEARCH_MIN_QUERY_LENGTH = 2;
const SEARCH_SCAN_MULTIPLIER = 2;

// ── State ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CatalogItem
 * @property {string|null} id
 * @property {string} url_name
 * @property {string} item_name
 * @property {string|null} thumb
 * @property {string|null} icon
 * @property {number|null} maxRank
 * @property {string|null} gameRef
 */

/** @type {CatalogItem[]} */
let _items = [];
let _byId = new Map();
let _bySlug = new Map();
let _byNameLc = new Map();
let _byGameRefLc = new Map();
let _loaded = false;
let _loading = null; // in-flight promise

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Unwrap v2 envelope: { data: [...] } or { payload: {...} } or raw array */
function _unwrap(obj) {
  if (!obj) return null;
  if (obj.data !== undefined) return obj.data;
  if (obj.payload !== undefined) return obj.payload;
  return obj;
}

/** Normalise a single v2 item to the internal catalog shape */
function _normalise(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const slug = source.slug || source.url_name || source._slug || "";
  const name =
    source?.i18n?.en?.name ||
    source?.i18n?.en?.itemName ||
    source?.i18n?.en?.item_name ||
    source?.item_name ||
    source?.itemName ||
    source?.name ||
    slug.replace(/_/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const thumb = source?.i18n?.en?.thumb || source.thumb || null;
  const icon = source?.i18n?.en?.icon || source.icon || null;
  const rawMaxRank = Number(source.maxRank ?? source.max_rank ?? null);
  const maxRank = Number.isFinite(rawMaxRank) && rawMaxRank > 0 ? Math.floor(rawMaxRank) : null;
  const gameRef =
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

async function _load() {
  if (_loaded) return;
  if (_loading) return _loading;

  _loading = (async () => {
    try {
      log.log("[WFMCatalog] Fetching item catalog (v2)…");

      let rawItems = [];

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
              v && typeof v === "object" ? { _slug: k, ...v } : { _slug: k },
            );
          } else if (Array.isArray(data)) {
            rawItems = data;
          }
        } catch (e) {
          log.warn(`[WFMCatalog] fetch ${path} failed:`, e.message);
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
          .replace(/\b[a-z]/g, (c) => c.toUpperCase());
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

/**
 * Search items by name fragment (case-insensitive, starts-with first then contains).
 *
 * @param {string} query
 * @param {number} [limit=20]
 * @returns {Promise<Array<{ id, url_name, item_name, thumb, icon }>>}
 */
async function searchItems(query, limit = 20) {
  await _load();
  if (!query || query.length < SEARCH_MIN_QUERY_LENGTH) return [];

  const q = query.toLowerCase().trim();

  const startsWith = [];
  const contains = [];

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

function isLoaded() {
  return _loaded;
}

async function ensureLoaded() {
  await _load();
  return _items.length;
}

function lookupByName(itemName) {
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

function getMarketUrl(itemName) {
  const item = lookupByName(itemName);
  if (!item?.url_name) return null;
  return `${WFM_ITEM_URL_BASE}${item.url_name}`;
}

function getRendererLookup() {
  const lookup = {};
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

/**
 * Look up an item by its WFM UUID.
 */
async function lookupById(id) {
  await _load();
  return _byId.get(id) || null;
}

/**
 * Look up an item by its url_name slug.
 */
async function lookupBySlug(slug) {
  await _load();
  return _bySlug.get(slug) || null;
}

/**
 * Trigger a background load of the catalog (call on app startup for faster first search).
 */
function prefetch() {
  _load().catch((err) => log.error("[WFMCatalog] prefetch failed:", err.message));
}

module.exports = {
  searchItems,
  lookupById,
  lookupBySlug,
  lookupByName,
  getMarketUrl,
  getRendererLookup,
  isLoaded,
  ensureLoaded,
  prefetch,
};
