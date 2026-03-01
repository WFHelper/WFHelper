import { writable } from 'svelte/store';

/**
 * The relic database from getRelicDatabase IPC.
 * Shape: { groups: { [key]: group }, byUniqueName: { [uniqueName]: { groupKey, quality } } }
 * null = not loaded yet.
 */
export const relicDb = writable(null);

/** Active tier filter: 'all' | 'Lith' | 'Meso' | 'Neo' | 'Axi' | 'Requiem'. */
export const relicTierFilter = writable('all');

/** Active text search. */
export const relicSearch = writable('');

/** Sort mode: 'tier' | 'ev_desc' | 'ev_asc'. */
export const relicSortMode = writable('tier');

/** Quality mode for EV calculation: 'best' | 'intact' | 'exceptional' | 'flawless' | 'radiant'. */
export const relicQualityMode = writable('best');

/** Squad size for EV calculation: 1–4. */
export const relicSquadSize = writable(1);

/**
 * How many relics the player owns, keyed by groupKey.
 * Shape: { [groupKey]: { intact, exceptional, flawless, radiant } }
 */
export const relicOwnedCounts = writable({});

/**
 * Incrementing counter — bumped by the EV warmup after each batch so that
 * RelicsView re-reads from the (non-reactive) EV cache maps and re-renders.
 */
export const relicEvRevision = writable(0);
