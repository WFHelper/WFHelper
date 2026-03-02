const log = require('./logger').withScope('wfmCatalog');
"use strict";

/**
 * wfmCatalog.js — Warframe.market item catalog (main-process only)
 *
 * Loads the full WFM item list on first demand and keeps it cached in memory.
 * Uses the v2 API directly (v1 /items returns 404).
 * Exposes lookups used by the order create/edit modal in the renderer.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const WFM_V2_BASE  = "https://api.warframe.market/v2";
const WFM_HEADERS  = {
  Platform:  "pc",
  Language:  "en",
  Crossplay: "true",
  Accept:    "application/json",
  "User-Agent": "WarframeCompanion/1.0",
};
const WFM_THUMB_BASE = "https://warframe.market/static/assets/";

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Array<{ id: string, url_name: string, item_name: string, thumb: string|null }>} */
let _items    = [];
let _byId     = new Map();
let _bySlug   = new Map();
let _byNameLc = new Map();
let _loaded   = false;
let _loading  = null; // in-flight promise

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Unwrap v2 envelope: { data: [...] } or { payload: {...} } or raw array */
function _unwrap(obj) {
  if (!obj) return null;
  if (obj.data  !== undefined) return obj.data;
  if (obj.payload !== undefined) return obj.payload;
  return obj;
}

/** Normalise a single v2 item to the internal catalog shape */
function _normalise(raw) {
  const slug = raw.slug || raw.url_name || raw._slug || "";
  const name =
    raw?.i18n?.en?.itemName ||
    raw?.i18n?.en?.item_name ||
    raw?.item_name ||
    raw?.itemName ||
    raw?.name ||
    slug.replace(/_/g, " ").replace(/\b[a-z]/g, c => c.toUpperCase());
  const thumb = raw.thumb || raw.icon || null;
  return {
    id:        raw.id   || null,
    url_name:  slug,
    item_name: name,
    thumb:     thumb ? (thumb.startsWith("http") ? thumb : WFM_THUMB_BASE + thumb) : null,
  };
}

// ── Loader ────────────────────────────────────────────────────────────────────

async function _load() {
  if (_loaded) return;
  if (_loading) return _loading;

  _loading = (async () => {
    log.log("[WFMCatalog] Fetching item catalog (v2)…");

    let rawItems = [];

    for (const path of ["/items", "/collections/items"]) {
      if (rawItems.length) break;
      try {
        const resp = await fetch(`${WFM_V2_BASE}${path}`, { headers: WFM_HEADERS });
        if (!resp.ok) { log.warn(`[WFMCatalog] ${path} returned ${resp.status}`); continue; }
        const json = await resp.json();
        const data = _unwrap(json);
        if (!data) continue;

        if (Array.isArray(data.items)) {
          rawItems = data.items;
        } else if (data.items && typeof data.items === "object") {
          rawItems = Object.entries(data.items).map(([k, v]) =>
            (v && typeof v === "object") ? { _slug: k, ...v } : { _slug: k }
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

    for (const item of _items) {
      if (item.id)       _byId.set(item.id, item);
      if (item.url_name) _bySlug.set(item.url_name, item);
      const nameLc = (item.item_name || "").toLowerCase();
      if (nameLc)        _byNameLc.set(nameLc, item);
    }

    _loaded  = true;
    _loading = null;
    log.log(`[WFMCatalog] Loaded ${_items.length} items.`);
  })();

  return _loading;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Search items by name fragment (case-insensitive, starts-with first then contains).
 *
 * @param {string} query
 * @param {number} [limit=20]
 * @returns {Promise<Array<{ id, url_name, item_name, thumb }>>}
 */
async function searchItems(query, limit = 20) {
  await _load();
  if (!query || query.length < 2) return [];

  const q = query.toLowerCase().trim();

  const startsWith = [];
  const contains   = [];

  for (const item of _items) {
    const name = (item.item_name || "").toLowerCase();
    if (name.startsWith(q)) {
      startsWith.push(item);
    } else if (name.includes(q)) {
      contains.push(item);
    }
    if (startsWith.length + contains.length >= limit * 2) break;
  }

  return [...startsWith, ...contains].slice(0, limit);
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

module.exports = { searchItems, lookupById, lookupBySlug, prefetch };
