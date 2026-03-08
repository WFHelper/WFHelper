import type { OverlaySettings } from "../types/ipc.js";

export const OVERLAY_CROP_PRESETS = ["balanced", "tight", "wide", "custom"] as const;
export const OVERLAY_OCR_ENGINES = ["windows", "tesseract"] as const;

export const OVERLAY_SETTINGS_LIMITS = Object.freeze({
  ocrPassesMin: 1,
  ocrPassesMax: 6,
  matchThresholdMin: 0.55,
  matchThresholdMax: 0.95,
  ocrTimeoutMsMin: 4_000,
  ocrTimeoutMsMax: 30_000,
  cropTopRatioMin: 0.0,
  cropTopRatioMax: 0.9,
  cropHeightRatioMin: 0.08,
  cropHeightRatioMax: 0.9,
});

export const OVERLAY_DEFAULTS: OverlaySettings = Object.freeze({
  autoTriggerEnabled: true,
  hotkeyEnabled: true,
  hotkey: "F8",
  interactionHotkeyEnabled: true,
  interactionHotkey: "Control+Tab",
  cropDebugHotkeyEnabled: true,
  cropDebugHotkey: "F9",
  cropPreset: "balanced",
  cropTopRatio: 0.38,
  cropHeightRatio: 0.36,
  ocrEngine: "windows",
  ocrPasses: 2,
  matchThreshold: 0.74,
  ocrTimeoutMs: 15_000,
  worldNotificationsEnabled: true,
});
