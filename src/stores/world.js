import { writable } from 'svelte/store';

/** Parsed world state from the main process (null = not fetched yet). */
export const worldData = writable(null);

/** Timestamp of the last successful world-state fetch (ms). */
export const worldLastFetch = writable(0);

/** True while a world-state fetch is in progress. */
export const worldLoading = writable(false);

/**
 * Which fissure list to show: 'normal' | 'steel'.
 * Persisted to localStorage.
 */
export const worldFissureMode = writable(
  typeof localStorage !== 'undefined' && localStorage.getItem('wf_fissure_mode') === 'steel'
    ? 'steel'
    : 'normal',
);

worldFissureMode.subscribe(value => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('wf_fissure_mode', value);
  }
});
