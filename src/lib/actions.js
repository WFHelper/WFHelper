/**
 * Shared action functions called from multiple components.
 *
 * These live outside any single component so that WelcomeView,
 * the live-update listener, and the auto-load can all trigger the
 * same "inventory loaded" flow by importing from here.
 */

import { get } from 'svelte/store';
import { inventoryData }  from '../stores/data.js';
import { masteryData }    from '../stores/mastery.js';
import { currentView, statusText } from '../stores/app.js';
import { relicDb, relicOwnedCounts } from '../stores/relics.js';
import { parseOwnedRelics } from './relic.js';

/**
 * Called whenever a new inventory JSON is received (file load, AlecaFrame,
 * or the file-watcher live-update).
 *
 * Updates all relevant stores and navigates to the inventory view.
 *
 * @param {object} data  Raw inventory JSON
 */
export async function onInventoryLoaded(data) {
  console.log('[actions] onInventoryLoaded — top-level keys:', data ? Object.keys(data).slice(0, 8) : 'null');

  // AlecaFrame wraps inventory inside InventoryJson — unwrap it.
  // The value may be a parsed object OR a JSON string (depending on how the
  // file was saved/decrypted). Handle both cases.
  if (data?.InventoryJson && !data?.Suits) {
    console.log('[actions] Unwrapping InventoryJson envelope');
    data = data.InventoryJson;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
        console.log('[actions] Parsed InventoryJson string → object');
      } catch (e) {
        console.error('[actions] Failed to parse InventoryJson string:', e.message);
      }
    }
  }

  if (data?.Suits) console.log('[actions] Suits count:', data.Suits.length);
  inventoryData.set(data);
  currentView.set('inventory');

  // Refresh relic owned counts if the relic DB was already loaded
  const db = get(relicDb);
  if (db) relicOwnedCounts.set(parseOwnedRelics(data, db));

  // Load mastery data in the background (non-blocking)
  window.api.getMasteryProgress()
    .then(md => masteryData.set(md))
    .catch(err => console.warn('[Mastery] getMasteryProgress failed:', err));
}

/**
 * Update the status bar text with the current parsed-item count.
 * Called after parsedItems updates (subscribed in App.svelte).
 * @param {number} count
 */
export function setInventoryStatus(count) {
  statusText.set(`${count} items loaded`);
}
