/**
 * Warframe.market price fetching.
 *
 * Prices are fetched on-demand and cached in two layers:
 *   1. In-memory map (instant, lost on page reload)
 *   2. localStorage via priceCache.js (survives restarts, 2-hour TTL)
 *
 * All outbound requests pass through a serial queue with a minimum delay
 * between calls to avoid hammering the WFM API from the renderer process.
 */

import { getCachedPrice, setCachedPrice } from './priceCache.js';

const MIN_DELAY_MS = 350; // ~3 req/s to match WFM rate limits

const WFM_HEADERS = {
  Platform:          'pc',
  Language:          'en',
  Crossplay:         'true',
  Accept:            'application/json',
  'Accept-Encoding': 'identity',
  'User-Agent':      'WarframeCompanion/1.0',
};

// ── Rate-limit queue ──────────────────────────────────────────────────────────

let _queue = Promise.resolve();
let _lastRequestAt = 0;

/**
 * Enqueue a function that returns a promise, ensuring at least MIN_DELAY_MS
 * between consecutive fetch requests.
 */
function enqueue(fn) {
  const result = _queue.then(async () => {
    const now = Date.now();
    const elapsed = now - _lastRequestAt;
    if (elapsed < MIN_DELAY_MS) {
      await new Promise(r => setTimeout(r, MIN_DELAY_MS - elapsed));
    }
    _lastRequestAt = Date.now();
    return fn();
  });
  _queue = result.catch(() => {}); // keep queue alive after errors
  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the most recent sell-side median price from a WFM statistics response. */
function extractMedian(json) {
  const payload = json?.payload;
  if (!payload) return null;

  const closed  = payload.statistics_closed || {};
  const live    = payload.statistics_live   || {};
  const rows = [
    ...(closed['48hours'] || closed['48_hours'] || []),
    ...(live['48hours']   || live['48_hours']   || []),
  ]
    .filter(x => !x.order_type || x.order_type === 'sell')
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  const latest = rows.at(-1);
  if (!latest) return null;

  const raw = latest.median ?? latest.moving_avg ?? latest.wa_price ?? latest.avg_price ?? latest.min_price;
  if (raw == null) return null;

  const n = Math.round(Math.abs(Number(raw)));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchStatsJson(slug) {
  return enqueue(async () => {
    const resp = await fetch(
      `https://api.warframe.market/v1/items/${slug}/statistics`,
      { headers: WFM_HEADERS },
    );
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get('retry-after') || '30', 10);
      _lastRequestAt = Date.now() + Math.max(retryAfter * 1000, 30_000) - MIN_DELAY_MS;
      console.warn(`[WFM] Rate limited (429). Cooling down for ${retryAfter}s.`);
      return { ok: false, transient: true };
    }
    if (!resp.ok) return { ok: false, transient: resp.status >= 500 || resp.status === 408 };
    return { ok: true, json: await resp.json() };
  });
}

/**
 * Fetch a WFM price by URL slug.
 * Checks the persistent localStorage cache first (2h TTL).
 *
 * @param {string|null} slug  e.g. 'ash_prime_set'
 * @returns {Promise<{status: 'ok'|'no_data'|'no_slug'|'transient', slug: string, median: number|null}>}
 */
export async function fetchPriceBySlug(slug) {
  if (!slug) return { status: 'no_slug', slug, median: null };

  // Check persistent cache first (survives navigation and restarts)
  const cached = getCachedPrice(slug);
  if (cached) {
    return { median: cached.median, slug, status: 'ok', timestamp: cached.timestamp };
  }

  try {
    const res = await fetchStatsJson(slug);
    if (!res.ok) return { status: res.transient ? 'transient' : 'no_data', slug, median: null };

    const median = extractMedian(res.json);
    if (median != null) {
      setCachedPrice(slug, median); // persist to localStorage
      return { median, slug, status: 'ok', timestamp: Date.now() };
    }
    return { status: 'no_data', slug, median: null };
  } catch (e) {
    console.warn(`[WFM] fetch failed for ${slug}:`, e.message);
    return { status: 'transient', slug, median: null };
  }
}

/**
 * Fetch a WFM price by item name, using the wfmItems map for slug lookup.
 * Tries "<slug>_set" first for prime items, then bare slug.
 *
 * @param {string} itemName   Display name, e.g. 'Ash Prime'
 * @param {object} wfmItems   Name→{url_name} map from getWfmItems IPC
 * @returns {Promise<{median: number, slug: string, timestamp: number}|null>}
 */
export async function fetchPriceByName(itemName, wfmItems) {
  if (!itemName) return null;

  const key     = itemName.toLowerCase();
  const mapping = wfmItems[key] || wfmItems[`${key} set`] || null;
  let slug      = mapping?.url_name;

  // Guess a slug if no exact mapping found
  if (!slug) {
    slug = key.replace(/['']/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  if (!slug) return null;

  // Try set slug first, then bare slug
  const slugsToTry = slug.endsWith('_set') ? [slug] : [`${slug}_set`, slug];

  // Check persistent cache (including _set variant)
  for (const trySlug of slugsToTry) {
    const cached = getCachedPrice(trySlug);
    if (cached) return { median: cached.median, slug: trySlug, timestamp: cached.timestamp };
  }

  for (const trySlug of slugsToTry) {
    try {
      const res = await fetchStatsJson(trySlug);
      if (!res.ok) continue;
      const median = extractMedian(res.json);
      if (median != null) {
        setCachedPrice(trySlug, median); // persist to localStorage
        if (trySlug !== slug) setCachedPrice(slug, median); // also cache under original slug
        return { median, slug: trySlug, timestamp: Date.now() };
      }
    } catch (e) {
      console.warn(`[WFM] stats fetch failed for ${trySlug}:`, e.message);
    }
  }
  return null;
}
