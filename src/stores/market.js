import { writable } from 'svelte/store';

/** WFM authentication state returned by wfmGetSession. */
export const marketSession = writable({ loggedIn: false, userName: null, platform: 'pc' });

/** Current sell + buy orders. */
export const marketOrders = writable({ sell: [], buy: [] });

/** Which order type tab is active: 'sell' | 'buy'. */
export const marketTypeTab = writable('sell');

/** Player's current online status: 'online' | 'ingame' | 'invisible' | null. */
export const marketStatus = writable(null);

/** Set of order IDs selected for bulk operations. */
export const marketSelected = writable(new Set());

/**
 * Timestamp (ms) of the last successful orders fetch.
 * Used to avoid redundant re-fetches on tab switches.
 */
export const marketOrdersLastFetch = writable(0);

/**
 * State for the create/edit order modal.
 * null = modal closed.
 * { mode: 'create', order: null } = creating a new order.
 * { mode: 'edit', order: {...} } = editing an existing order.
 */
export const orderModalState = writable(null);
