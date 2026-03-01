import { fetchPriceBySlug } from './wfmPrice.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const RELIC_ICON_PATHS = {
  lith:    'world-icons/relic-lith.png',
  meso:    'world-icons/relic-meso.png',
  neo:     'world-icons/relic-neo.png',
  axi:     'world-icons/relic-axi.png',
  requiem: 'world-icons/relic-requiem.png',
  omnia:   'world-icons/relic-requiem.png',
  default: 'world-icons/relic-lith.png',
};

export const RELIC_TIER_ORDER = { Lith: 0, Meso: 1, Neo: 2, Axi: 3, Requiem: 4 };

const QUALITY_MODES = ['intact', 'exceptional', 'flawless', 'radiant'];

const EV_NODATA_TTL_MS  = 2 * 60 * 1000; // suppress retries for 2 minutes
const EV_TRANSIENT_MS   = 30_000;         // retry delay after rate-limit / server error
const EV_BATCH_SIZE     = 30;             // relics per warmup batch
const EV_WORKERS        = 2;             // concurrent fetch workers per batch

// ─── CSS helper ───────────────────────────────────────────────────────────────

/** Map a relic tier name to its CSS class (e.g. 'Lith' → 'lith'). */
export function fissureTierClass(tier = '') {
  const t = tier.toLowerCase();
  if (t.includes('lith'))    return 'lith';
  if (t.includes('meso'))    return 'meso';
  if (t.includes('neo'))     return 'neo';
  if (t.includes('axi'))     return 'axi';
  if (t.includes('requiem')) return 'requiem';
  if (t.includes('omnia'))   return 'omnia';
  return 'default';
}

// ─── Owned relic parsing ──────────────────────────────────────────────────────

/**
 * Count how many of each relic quality the player owns.
 * @param {object|null} inventoryData
 * @param {object|null} relicDb  { groups: {}, byUniqueName: {} }
 * @returns {Record<string, {intact, exceptional, flawless, radiant}>}
 */
export function parseOwnedRelics(inventoryData, relicDb) {
  const owned = {};
  if (!inventoryData || !relicDb) return owned;

  const levelKeys = inventoryData.LevelKeys || [];
  console.log('[parseOwnedRelics] LevelKeys count:', levelKeys.length);
  if (levelKeys.length > 0) {
    console.log('[parseOwnedRelics] First 3 LevelKeys ItemTypes:', levelKeys.slice(0, 3).map(e => e.ItemType));
  }
  const byUniqSample = Object.keys(relicDb.byUniqueName || {}).slice(0, 3);
  console.log('[parseOwnedRelics] byUniqueName sample keys:', byUniqSample);

  let matched = 0;
  for (const entry of levelKeys) {
    const info = relicDb.byUniqueName[entry.ItemType];
    if (!info) continue;
    matched++;
    const { groupKey, quality } = info;
    if (!owned[groupKey]) owned[groupKey] = { intact: 0, exceptional: 0, flawless: 0, radiant: 0 };
    owned[groupKey][quality] = (owned[groupKey][quality] || 0) + (entry.ItemCount || 1);
  }
  console.log('[parseOwnedRelics] matched:', matched, 'owned groups:', Object.keys(owned).length);

  return owned;
}

// ─── EV calculation ───────────────────────────────────────────────────────────

/**
 * Expected value of the best reward pick from N independent players.
 *
 * Uses the order-statistics formula:
 *   E[max_N] = Σ v_j · (CDF_j^N − CDF_{j-1}^N)
 *
 * @param {{ chance: number }[]} rewards  Relic reward array (chance in %)
 * @param {(number|null)[]} prices        WFM prices aligned by index
 * @param {number} N                      Squad size (1-4)
 * @returns {number}
 */
export function computeSquadEV(rewards, prices, N) {
  const items = rewards.map((r, i) => ({ prob: r.chance / 100, price: prices[i] ?? 0 }));

  if (N <= 1) return items.reduce((sum, it) => sum + it.prob * it.price, 0);

  // Group items with the same price and sort ascending
  const sorted = [...items].sort((a, b) => a.price - b.price);
  const grouped = [];
  for (const item of sorted) {
    const last = grouped[grouped.length - 1];
    if (last && last.price === item.price) {
      last.prob += item.prob;
    } else {
      grouped.push({ price: item.price, prob: item.prob });
    }
  }

  let ev = 0;
  let cdfPrev = 0;
  for (const g of grouped) {
    const cdfCur = Math.min(1, cdfPrev + g.prob);
    ev += g.price * (Math.pow(cdfCur, N) - Math.pow(cdfPrev, N));
    cdfPrev = cdfCur;
  }
  return ev;
}

// ─── EV cache (module-level singletons) ──────────────────────────────────────
// These maps live outside Svelte's reactivity to avoid re-rendering on every
// intermediate cache update. The relicEvRevision store is bumped by the warmup
// to tell Svelte when to re-read the cache.

const evCache          = new Map(); // `${groupKey}|${squad}|${quality}` → number
const evNoDataCache    = new Map(); // key → timestamp (ms since epoch)
const evPending        = new Set(); // cache keys currently being computed
const groupPriceCache  = new Map(); // groupKey → price snapshot
const groupPricePending = new Set();

let warmupRunning = false;
let warmupToken   = 0;

// ─── Cache accessors (used by RelicsView) ────────────────────────────────────

export function evCacheKey(groupKey, squadSize, qualityMode) {
  return `${groupKey}|${squadSize}|${qualityMode}`;
}

/** @returns {number|null} */
export function getCachedEv(groupKey, squadSize, qualityMode) {
  return evCache.get(evCacheKey(groupKey, squadSize, qualityMode)) ?? null;
}

/** True if we recently confirmed no price data (prevents hammering WFM). */
export function evHasFreshNoData(groupKey, squadSize, qualityMode) {
  const ts = evNoDataCache.get(evCacheKey(groupKey, squadSize, qualityMode));
  return !!(ts && Date.now() - ts < EV_NODATA_TTL_MS);
}

/** Wipe all EV caches; increments the warmup token to cancel any in-progress warmup. */
export function resetEvCaches() {
  evCache.clear();
  evNoDataCache.clear();
  evPending.clear();
  groupPriceCache.clear();
  groupPricePending.clear();
  warmupToken++;
  warmupRunning = false;
}

/** Cancel any in-progress warmup without clearing caches. */
export function cancelWarmup() {
  warmupToken++;
  warmupRunning = false;
}

// ─── EV computation ───────────────────────────────────────────────────────────

/**
 * Fetch prices for all rewards in a relic group and populate the EV cache
 * for every squad-size × quality combination.
 *
 * Returns early if the group is already cached or a fetch is already pending.
 */
export async function computeGroupEv(group) {
  // Use the solo-best sentinel key to check if this group has been processed
  const sentinelKey = evCacheKey(group.key, 1, 'best');
  if (evCache.has(sentinelKey)) return;
  const noDataTs = evNoDataCache.get(sentinelKey);
  if (noDataTs && Date.now() - noDataTs < EV_NODATA_TTL_MS) return;
  if (evPending.has(sentinelKey) || groupPricePending.has(group.key)) return;

  evPending.add(sentinelKey);
  groupPricePending.add(group.key);

  try {
    // Fetch prices for each quality tier (reuses existing snapshot if present)
    let snapshot = groupPriceCache.get(group.key);
    if (!snapshot) {
      snapshot = { transient: false, qualities: {} };

      // Collect unique reward slugs across ALL quality tiers, then fetch them all
      // in one parallel batch (avoids redundant per-quality fetches for shared items).
      const uniqueSlugs = [
        ...new Set(
          Object.values(group.qualities || {})
            .flatMap(qd => (qd.rewards || []).map(r => r?.urlName).filter(Boolean)),
        ),
      ];
      const priceMap = new Map();
      await Promise.all(
        uniqueSlugs.map(async slug => {
          priceMap.set(slug, await fetchPriceBySlug(slug));
        }),
      );

      // Now process each quality tier — all prices are in the cache / priceMap
      for (const [qualityName, qualityData] of Object.entries(group.qualities || {})) {
        const results = (qualityData.rewards || []).map(r =>
          r?.urlName
            ? (priceMap.get(r.urlName) ?? { status: 'no_slug', median: null })
            : { status: 'no_slug', median: null },
        );

        if (results.some(r => r?.status === 'transient')) snapshot.transient = true;

        const prices = results.map(r => (r?.status === 'ok' ? r.median : null));
        snapshot.qualities[qualityName] = {
          rewards:     qualityData.rewards,
          prices,
          hasAnyPrice: prices.some(p => p != null),
        };
      }

      // Don't persist transient snapshots — they'll be re-fetched on next attempt.
      if (!snapshot.transient) {
        groupPriceCache.set(group.key, snapshot);
      }
    }

    // Populate EV cache for all squad × quality combinations in one pass
    for (let squad = 1; squad <= 4; squad++) {
      let bestEv = null;

      for (const qm of QUALITY_MODES) {
        const qData = snapshot.qualities[qm];
        const qKey  = evCacheKey(group.key, squad, qm);

        if (!qData?.hasAnyPrice) {
          if (!snapshot.transient) evNoDataCache.set(qKey, Date.now());
          continue;
        }

        const qEv = computeSquadEV(qData.rewards, qData.prices, squad);
        evCache.set(qKey, qEv);
        evNoDataCache.delete(qKey);
        if (bestEv == null || qEv > bestEv) bestEv = qEv;
      }

      const bestKey = evCacheKey(group.key, squad, 'best');
      if (bestEv != null) {
    evCache.set(bestKey, bestEv);
        evNoDataCache.delete(bestKey);
      } else if (!snapshot.transient) {
        evNoDataCache.set(bestKey, Date.now());
      }
    }

    // If the snapshot was rate-limited/transient and we couldn't cache any EV,
    // set a short-TTL entry so the warmup loop doesn't re-queue this group
    // immediately and spin in a tight loop.
    if (snapshot.transient && !evCache.has(sentinelKey)) {
      evNoDataCache.set(sentinelKey, Date.now() - (EV_NODATA_TTL_MS - EV_TRANSIENT_MS));
    }
  } finally {
    groupPricePending.delete(group.key);
    evPending.delete(sentinelKey);
  }
}

// ─── Background warmup ────────────────────────────────────────────────────────

/**
 * Pre-compute EV scores for a list of relic groups in the background.
 * Processes groups in batches with EV_WORKERS concurrent workers.
 * Calls onBatchDone() after each batch so the UI can re-render with fresh data.
 *
 * Safe to call multiple times — subsequent calls while a warmup is running
 * are ignored via the warmupToken mechanism.
 *
 * @param {Array} groups
 * @param {() => void} onBatchDone  Called after each batch and at completion
 */
export async function warmupRelicEvs(groups, onBatchDone) {
  if (warmupRunning) return;
  warmupRunning = true;

  const token = ++warmupToken;

  try {
    for (;;) {
      if (token !== warmupToken) return; // cancelled by resetEvCaches

      const now = Date.now();
      const queue = [];

      for (const g of groups) {
        const key     = evCacheKey(g.key, 1, 'best');
        const noDataTs = evNoDataCache.get(key);
        if (evCache.has(key) || evPending.has(key)) continue;
        if (noDataTs && now - noDataTs < EV_NODATA_TTL_MS) continue;
        queue.push(g);
        if (queue.length >= EV_BATCH_SIZE) break;
      }

      if (!queue.length) break;

      // N concurrent workers consume from the shared queue
      await Promise.all(
        Array.from({ length: EV_WORKERS }, async () => {
          for (;;) {
            if (token !== warmupToken) return;
            const group = queue.shift();
            if (!group) return;
            await computeGroupEv(group);
          }
        }),
      );

      if (token === warmupToken) onBatchDone();
      // Yield to the event loop between batches so the UI stays responsive.
      await new Promise(r => setTimeout(r, 50));
    }
  } finally {
    if (token === warmupToken) {
      warmupRunning = false;
      onBatchDone(); // final render pass
    }
  }
}
