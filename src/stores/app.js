import { writable } from 'svelte/store';

/** The currently visible view name. */
export const currentView = writable('welcome');

/** Status bar message. */
export const statusText = writable('No inventory loaded');

/** Whether debug logging is active. Persisted to localStorage. */
export const debugMode = writable(
  typeof localStorage !== 'undefined' && localStorage.getItem('wf_debug_mode') === '1',
);

// Keep localStorage in sync whenever debugMode changes
debugMode.subscribe(value => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('wf_debug_mode', value ? '1' : '0');
  }
});
