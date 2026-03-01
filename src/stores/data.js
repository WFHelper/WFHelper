import { writable, derived } from 'svelte/store';
import { parseInventory } from '../lib/inventory.js';

/** Raw item database, keyed by internal uniqueName path. */
export const itemDb = writable({});

/** warframe.market item name → { url_name } map. */
export const wfmItems = writable({});

/** Raw inventory JSON as received from the main process (null = not loaded). */
export const inventoryData = writable(null);

/**
 * Parsed inventory item list — automatically recomputed whenever inventoryData
 * or itemDb changes. Components read this instead of calling parseInventory directly.
 */
export const parsedItems = derived(
  [inventoryData, itemDb],
  ([$inv, $db]) => {
    if (!$inv || !$db || typeof $db !== 'object') return [];
    const dbSize = Object.keys($db).length;
    console.log('[parsedItems] inv keys:', $inv ? Object.keys($inv).slice(0, 5) : 'null', 'dbSize:', dbSize);
    if (dbSize === 0) return [];
    return parseInventory($inv, $db);
  },
);
