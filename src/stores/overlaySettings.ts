import { writable } from "svelte/store";
import { OVERLAY_SETTINGS_DEFAULTS } from "../../config/runtime/overlaySettings.js";
import type { OverlaySettings } from "../types/ipc.js";

export const OVERLAY_DEFAULTS: OverlaySettings = {
  ...OVERLAY_SETTINGS_DEFAULTS,
  cycleAlerts: { ...OVERLAY_SETTINGS_DEFAULTS.cycleAlerts },
  fissureAlerts: [...OVERLAY_SETTINGS_DEFAULTS.fissureAlerts],
};

export const overlaySettings = writable<OverlaySettings>({
  ...OVERLAY_DEFAULTS,
});

export const overlaySettingsLoaded = writable<boolean>(false);

/** Apply a saved settings response to the stores. Call after ipc.setOverlaySettings / getOverlaySettings. */
export function applyOverlaySettingsResponse(saved: OverlaySettings): void {
  overlaySettings.set({ ...OVERLAY_DEFAULTS, ...saved });
  overlaySettingsLoaded.set(true);
}
