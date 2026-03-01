import { writable } from 'svelte/store';

/**
 * Item to display in the ItemDetailModal.
 * Set to an item object to open the modal; set to null to close it.
 */
export const activeItem = writable(null);

/**
 * Component to display in the ComponentDetailModal.
 * Shape: { comp: {...}, parentName: string } | null
 */
export const activeComponent = writable(null);

/**
 * Relic group to display in the RelicDetailModal.
 * Set to a group object to open; null to close.
 */
export const activeRelic = writable(null);
