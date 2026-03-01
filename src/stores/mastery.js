import { writable } from 'svelte/store';

/**
 * Result of getMasteryProgress IPC call.
 * Shape: { items: [], stats: { total, mastered, inProgress, missing, byCategory: {} } }
 * null = not loaded yet.
 */
export const masteryData = writable(null);
