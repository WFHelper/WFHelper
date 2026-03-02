import { writable } from "svelte/store";
import type { OverlaySettings } from "../types/ipc.js";

export const OVERLAY_DEFAULTS: OverlaySettings = Object.freeze({
  autoTriggerEnabled: true,
  hotkeyEnabled: true,
  hotkey: "F8",
  cropPreset: "balanced",
  ocrPasses: 2,
  matchThreshold: 0.74,
  ocrTimeoutMs: 15000,
});

export const overlaySettings = writable<OverlaySettings>({
  ...OVERLAY_DEFAULTS,
});

export const overlaySettingsLoaded = writable<boolean>(false);
