import { writable } from "svelte/store";
import { OVERLAY_DEFAULTS } from "../config/overlay.js";
import type { OverlaySettings } from "../types/ipc.js";

export { OVERLAY_DEFAULTS };

export const overlaySettings = writable<OverlaySettings>({
  ...OVERLAY_DEFAULTS,
});

export const overlaySettingsLoaded = writable<boolean>(false);

/** Apply a saved settings response to the stores. Call after ipc.setOverlaySettings / getOverlaySettings. */
export function applyOverlaySettingsResponse(saved: OverlaySettings): void {
  overlaySettings.set({ ...OVERLAY_DEFAULTS, ...saved });
  overlaySettingsLoaded.set(true);
}
