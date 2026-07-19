import { get } from "svelte/store";
import {
  applyOverlaySettingsResponse,
  overlaySettings,
  overlaySettingsLoaded,
} from "../stores/overlaySettings.js";
import { invoke } from "./ipc.js";

// Main zooms the window before first paint, so this lives in main's settings file.
export async function loadUiScale(): Promise<number> {
  if (!get(overlaySettingsLoaded)) {
    const loaded = await invoke("getOverlaySettings");
    if (loaded) applyOverlaySettingsResponse(loaded);
  }
  return get(overlaySettings).uiScale;
}

export async function saveUiScale(scale: number): Promise<void> {
  const saved = await invoke("setOverlaySettings", { uiScale: scale });
  if (saved) applyOverlaySettingsResponse(saved);
}
