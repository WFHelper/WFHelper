import { writable } from 'svelte/store';

export const OVERLAY_DEFAULTS = Object.freeze({
  autoTriggerEnabled: true,
  hotkeyEnabled:      true,
  hotkey:             'F8',
  cropPreset:         'balanced',
  ocrPasses:          2,
  matchThreshold:     0.74,
  ocrTimeoutMs:       15000,
});

/** Current overlay settings (loaded from main process on app start). */
export const overlaySettings = writable({ ...OVERLAY_DEFAULTS });

/** True once the settings have been fetched from the main process at least once. */
export const overlaySettingsLoaded = writable(false);
