/**
 * Persistent WFM price cache backed by localStorage.
 *
 * Prices are cached for up to 2 hours so the relic planner and item modals
 * don't need to re-fetch on every view switch or app restart.
 * Similar approach to AlecaFrame's price caching.
 */

const STORAGE_KEY  = 'wfm_price_cache_v1';
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const SAVE_DEBOUNCE_MS = 2000;            // batch writes to localStorage

/** @type {Map<string, {median: number, timestamp: number}>} */
const _prices = new Map();
let _dirty = false;
let _saveTimer = null;

// ── Hydrate from localStorage on module load ─────────────────────────────────

try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const { v, entries } = JSON.parse(raw);
    if (v === 1 && Array.isArray(entries)) {
      const now = Date.now();
      let loaded = 0;
      for (const [slug, median, ts] of entries) {
        if (now - ts < CACHE_TTL_MS) {
          _prices.set(slug, { median, timestamp: ts });
          loaded++;
        }
      }
      if (loaded) console.log(`[PriceCache] Hydrated ${loaded} cached prices from localStorage`);
    }
  }
} catch (e) {
  console.warn('[PriceCache] Failed to hydrate:', e.message);
}

// ── Persistence ──────────────────────────────────────────────────────────────

function _scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (!_dirty) return;
    _dirty = false;
    try {
      const now = Date.now();
      const entries = [];
      for (const [slug, { median, timestamp }] of _prices) {
        if (now - timestamp < CACHE_TTL_MS) {
          entries.push([slug, median, timestamp]);
        }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, entries }));
    } catch (e) {
      console.warn('[PriceCache] Failed to persist:', e.message);
    }
  }, SAVE_DEBOUNCE_MS);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get a cached price by slug. Returns null if missing or expired.
 * @param {string} slug
 * @returns {{ median: number, timestamp: number } | null}
 */
export function getCachedPrice(slug) {
  const entry = _prices.get(slug);
  if (!entry) return null;
  if (Date.now() - entry.timestamp >= CACHE_TTL_MS) {
    _prices.delete(slug);
    return null;
  }
  return entry;
}

/**
 * Store a price in the cache and schedule a localStorage write.
 * @param {string} slug
 * @param {number} median
 */
export function setCachedPrice(slug, median) {
  _prices.set(slug, { median, timestamp: Date.now() });
  _dirty = true;
  _scheduleSave();
}

/** Number of valid (non-expired) entries currently cached. */
export function cacheSize() {
  return _prices.size;
}

/** Force an immediate save (e.g. before app close). */
export function flushCache() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  _dirty = true;
  _scheduleSave();
}
