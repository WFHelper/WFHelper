/**
 * Helper utilities for the World view.
 *
 * Includes Prime Resurgence item detection and icon path constants.
 * Kept separate from format.js so format.js stays a pure time/number helper.
 */

export const PLANET_ICON_PATHS = {
  earth:   'world-icons/earth.webp',
  cetus:   'world-icons/earth.webp',  // Cetus is on Earth
  vallis:  'world-icons/vallis.webp',
  cambion: 'world-icons/cambion.webp',
};

export const RELIC_ICON_PATHS = {
  lith:    'world-icons/relic-lith.png',
  meso:    'world-icons/relic-meso.png',
  neo:     'world-icons/relic-neo.png',
  axi:     'world-icons/relic-axi.png',
  requiem: 'world-icons/relic-requiem.png',
  omnia:   'world-icons/relic-requiem.png',
  default: 'world-icons/relic-lith.png',
};

/** Map a relic/fissure tier string to a CSS class name. */
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

// ─── Prime Resurgence helpers ─────────────────────────────────────────────────

/** True if the item is prime playable gear (not a cosmetic). */
function isLikelyPrimeGear(name = '') {
  return (
    /prime/i.test(name) &&
    !/(scarf|armor|syandana|ephemera|sigil|glyph|emote|sugatra|operator|mask|noggle|pack)/i.test(name)
  );
}

const PRIME_CATS     = new Set(['warframe', 'weapon', 'companion', 'warframes', 'primary', 'secondary', 'melee', 'sentinels', 'pets', 'sentinel weapons']);
const PRIME_PRODUCTS = new Set(['suits', 'longguns', 'pistols', 'melee', 'sentinels', 'sentinelweapons']);

/** True if a DB entry is a candidate to appear in the Resurgence showcase grid. */
export function isResurgenceCandidate(entry = {}) {
  if (!isLikelyPrimeGear(entry.name || '')) return false;
  const category = (entry.category || '').toLowerCase();
  const product  = (entry.productCategory || '').toLowerCase();
  const type     = (entry.type || '').toLowerCase();
  if (PRIME_CATS.has(category)) return true;
  if (PRIME_PRODUCTS.has(product)) return true;
  if (/(warframe|rifle|shotgun|sniper|bow|pistol|melee|sentinel|companion)/.test(type)) return true;
  return false;
}

function canonicalName(value = '') {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Extract all "X Prime" or "Prime X" substrings from a display string. */
function extractPrimeNames(text) {
  if (!text) return [];
  const out = new Set();
  const matches = text.match(
    /(?:Prime\s+[A-Za-z']+(?:\s+[A-Za-z']+)*)|(?:[A-Za-z']+(?:\s+[A-Za-z']+)*\s+Prime)/gi,
  ) || [];
  for (const m of matches) {
    const s = m.trim().replace(/\s{2,}/g, ' ');
    if (/^prime\s+/i.test(s)) {
      const rest = s.replace(/^prime\s+/i, '').trim();
      if (rest) out.add(`${rest} Prime`);
    } else {
      out.add(s);
    }
  }
  return [...out];
}

/**
 * Build the list of up to 9 featured Prime items from Varzia's inventory,
 * annotated with whether the player owns each one.
 *
 * @param {object|null} varzia        worldData.vaultTrader
 * @param {object|null} inventoryData Player's raw inventory JSON
 * @param {object}      itemDb        Item database lookup
 * @returns {{ name: string, imageUrl: string, owned: boolean }[]}
 */
export function buildFeaturedPrimes(varzia, inventoryData, itemDb) {
  if (!varzia || !itemDb) return [];

  // Build owned lookup sets from the player's inventory
  const ownedUnique = new Set();
  const ownedNames  = new Set();
  if (inventoryData) {
    const invKeys = ['Suits', 'LongGuns', 'Pistols', 'Melee', 'Sentinels', 'SentinelWeapons', 'SpaceSuits', 'SpaceGuns', 'SpaceMelee', 'OperatorAmps', 'MechSuits'];
    for (const key of invKeys) {
      for (const e of (inventoryData[key] || [])) {
        if (!e?.ItemType) continue;
        ownedUnique.add(e.ItemType);
        const db = itemDb[e.ItemType];
        if (db?.name) ownedNames.add(db.name.toLowerCase());
      }
    }
  }

  const featured = [];
  const seen     = new Set();

  // ① Prefer entries with a direct uniqueName → DB match (most reliable images)
  for (const inv of (varzia.inventory || [])) {
    const db = inv?.uniqueName ? itemDb[inv.uniqueName] : null;
    if (!db?.name || !db.imageUrl || !isResurgenceCandidate(db)) continue;
    const key = db.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    featured.push({
      name:     db.name,
      imageUrl: db.imageUrl,
      owned:    ownedUnique.has(inv.uniqueName) || ownedNames.has(key),
    });
    if (featured.length >= 9) break;
  }

  // ② Fill remainder by parsing Prime names out of pack labels
  if (featured.length < 9) {
    const dbByName = new Map(
      Object.entries(itemDb)
        .filter(([, v]) => v?.name)
        .map(([u, v]) => [v.name.toLowerCase(), { ...v, uniqueName: u }]),
    );
    const dbByCanonical = new Map();
    for (const [u, v] of Object.entries(itemDb)) {
      if (!v?.name) continue;
      const c = canonicalName(v.name);
      if (!dbByCanonical.has(c)) dbByCanonical.set(c, { ...v, uniqueName: u });
    }

    for (const inv of (varzia.inventory || [])) {
      const db  = inv?.uniqueName ? itemDb[inv.uniqueName] : null;
      const raw = (db?.name || inv.item || '').replace(/\bM\s*P\s*V\b/gi, '').replace(/\b(single|dual)\s*pack\b/gi, '').replace(/\s{2,}/g, ' ').trim();

      for (const primeName of extractPrimeNames(raw)) {
        const cleaned = primeName.replace(/\bpower suit\b/gi, '').replace(/\s{2,}/g, ' ').trim();
        const entry   = dbByName.get(cleaned.toLowerCase()) || dbByCanonical.get(canonicalName(cleaned));
        if (!entry?.imageUrl || !isResurgenceCandidate(entry)) continue;
        const key = entry.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        featured.push({
          name:     entry.name,
          imageUrl: entry.imageUrl,
          owned:    (entry.uniqueName && ownedUnique.has(entry.uniqueName)) || ownedNames.has(key),
        });
        if (featured.length >= 9) break;
      }
      if (featured.length >= 9) break;
    }
  }

  return featured;
}
