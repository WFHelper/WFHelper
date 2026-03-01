/**
 * Inventory parsing helpers.
 * All functions take the raw inventory JSON and the itemDb lookup as inputs
 * so they are pure and easily testable.
 */

// Maps inventory JSON keys → UI filter categories + display labels
const CATEGORIES = [
  { key: 'Suits',           cat: 'warframes',  label: 'Warframe' },
  { key: 'LongGuns',        cat: 'primary',    label: 'Primary' },
  { key: 'Pistols',         cat: 'secondary',  label: 'Secondary' },
  { key: 'Melee',           cat: 'melee',      label: 'Melee' },
  { key: 'Sentinels',       cat: 'companions', label: 'Companion' },
  { key: 'SentinelWeapons', cat: 'companions', label: 'Companion' },
  { key: 'SpaceSuits',      cat: 'archwing',   label: 'Archwing' },
  { key: 'SpaceGuns',       cat: 'archwing',   label: 'Archwing' },
  { key: 'SpaceMelee',      cat: 'archwing',   label: 'Archwing' },
  { key: 'OperatorAmps',    cat: 'amps',       label: 'Amp' },
  { key: 'MechSuits',       cat: 'necramech',  label: 'Necramech' },
];

// Maps productCategory DB field → UI filter key (overrides default)
const PRODUCT_TO_FILTER = {
  Suits:           'warframes',
  LongGuns:        'primary',
  Pistols:         'secondary',
  Melee:           'melee',
  Sentinels:       'companions',
  SentinelWeapons: 'companions',
  SpaceSuits:      'archwing',
  SpaceGuns:       'archwing',
  SpaceMelee:      'archwing',
  OperatorAmps:    'amps',
  MechSuits:       'necramech',
};

/**
 * Resolve an internal item path to its display name and image.
 * Falls back to a prettified version of the path segment if not in the DB.
 * @param {string} internalName  e.g. /Lotus/Powersuits/Excalibur/Excalibur
 * @param {Record<string,*>} itemDb
 */
function resolveItem(internalName, itemDb) {
  if (itemDb[internalName]) return itemDb[internalName];
  if (!internalName) return { name: 'Unknown', imageUrl: null };
  const segments = internalName.split('/');
  let name = segments[segments.length - 1] || 'Unknown';
  // CamelCase → "Camel Case"
  name = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return { name, imageUrl: null, category: 'Unknown' };
}

/**
 * Determine the correct UI category for an item, using productCategory
 * from the DB when available, and a path-pattern fallback for amps.
 */
function inferCategory(internalName, defaultCat, dbEntry = {}) {
  if (/\/OperatorAmplifiers?\//i.test(internalName)) return 'amps';
  if (dbEntry.productCategory && PRODUCT_TO_FILTER[dbEntry.productCategory]) {
    return PRODUCT_TO_FILTER[dbEntry.productCategory];
  }
  return defaultCat;
}

/**
 * Return true if this item should be hidden from the inventory view.
 * Filters out exalted weapons and special-purpose items.
 */
function shouldHide(internalName, dbEntry = {}, resolved = {}) {
  if (dbEntry.exalted === true) return true;
  if (dbEntry.productCategory === 'SpecialItems') return true;
  if (typeof dbEntry.type === 'string' && /exalted/i.test(dbEntry.type)) return true;
  if (/^(Exalted Blade|Regulators(?: Prime)?|Iron Staff(?: Prime)?|Dex Pixia(?: Prime)?|Artemis Bow(?: Prime)?|Desert Wind(?: Prime)?)$/i.test(resolved?.name)) return true;
  if (/\/ExaltedWeapons?\//.test(internalName)) return true;
  if (/\/SpecialItems\//.test(internalName)) return true;
  return false;
}

/**
 * Parse the raw inventory JSON into a flat array of item objects suitable
 * for the Inventory view grid.
 *
 * @param {object} data    Raw inventory JSON (from file or IPC)
 * @param {object} itemDb  Item database lookup (from getItemDatabase IPC)
 * @returns {Array<object>}
 */
export function parseInventory(data, itemDb) {
  const items = [];

  for (const { key, cat, label } of CATEGORIES) {
    if (!Array.isArray(data[key])) continue;

    for (const entry of data[key]) {
      if (!entry?.ItemType) continue;
      const resolved = resolveItem(entry.ItemType, itemDb);
      const dbEntry  = itemDb[entry.ItemType] || {};

      if (shouldHide(entry.ItemType, dbEntry, resolved)) continue;

      const finalCat   = inferCategory(entry.ItemType, cat, dbEntry);
      const finalLabel = CATEGORIES.find(c => c.cat === finalCat)?.label || label;

      items.push({
        name:          resolved.name,
        internalName:  entry.ItemType,
        category:      finalCat,
        categoryLabel: finalLabel,
        rank:          entry.XP ? Math.min(30, Math.floor(entry.XP / 6000)) : 0,
        maxRank:       30,
        imageUrl:      resolved.imageUrl || null,
        isPrime:       resolved.isPrime  || false,
        masteryReq:    resolved.masteryReq || 0,
        vaulted:       resolved.vaulted  || false,
        tradable:      dbEntry.tradable  || resolved.isPrime || false,
        description:   dbEntry.description || '',
        components:    dbEntry.components  || [],
        drops:         dbEntry.drops       || [],
        wikiaUrl:      dbEntry.wikiaUrl    || null,
      });
    }
  }

  return items;
}

/**
 * Parse active builds and available blueprints from inventory JSON.
 * @param {object} data
 * @param {object} itemDb
 * @returns {{ building: Array, recipes: Array }}
 */
export function parseFoundry(data, itemDb) {
  const building = [];
  const recipes  = [];

  for (const recipe of (data.PendingRecipes || [])) {
    const resolved = resolveItem(recipe.ItemType, itemDb);
    let endDate = null;
    try {
      const raw = recipe.CompletionDate;
      if (raw) {
        endDate = new Date(
          raw.$date?.$numberLong ? parseInt(raw.$date.$numberLong) : (raw.$date || raw),
        );
      }
    } catch { /* ignore malformed dates */ }
    building.push({ name: resolved.name, imageUrl: resolved.imageUrl || null, endDate });
  }

  for (const recipe of (data.Recipes || [])) {
    const resolved = resolveItem(recipe.ItemType, itemDb);
    recipes.push({
      name:     resolved.name,
      imageUrl: resolved.imageUrl || null,
      count:    recipe.ItemCount || 1,
    });
  }

  return { building, recipes };
}

/**
 * Parse resources (MiscItems) from inventory JSON, sorted descending by count.
 * @param {object} data
 * @param {object} itemDb
 * @returns {Array<{name, imageUrl, internalName, count}>}
 */
export function parseResources(data, itemDb) {
  const resources = (data.MiscItems || []).map(item => {
    const resolved = resolveItem(item.ItemType, itemDb);
    return {
      name:         resolved.name,
      imageUrl:     resolved.imageUrl || null,
      internalName: item.ItemType,
      count:        item.ItemCount || 0,
    };
  });

  return resources.sort((a, b) => b.count - a.count);
}
