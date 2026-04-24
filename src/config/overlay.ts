import type { OverlaySettings } from "../types/ipc.js";

export const OVERLAY_SETTINGS_LIMITS = Object.freeze({
  ocrPassesMin: 1,
  ocrPassesMax: 6,
  matchThresholdMin: 0.55,
  matchThresholdMax: 0.95,
  ocrTimeoutMsMin: 4_000,
  ocrTimeoutMsMax: 30_000,
});

export const OVERLAY_DEFAULTS: OverlaySettings = Object.freeze({
  autoTriggerEnabled: true,
  hotkeyEnabled: true,
  hotkey: "F8",
  interactionHotkeyEnabled: true,
  interactionHotkey: "Control+Tab",
  ocrPasses: 2,
  matchThreshold: 0.74,
  ocrTimeoutMs: 15_000,
  worldNotificationsEnabled: true,
  cycleAlerts: { earth: false, cetus: false, vallis: false, cambion: false, duviri: false },
  cycleAlertMinutesBefore: 3,
  fissureAlerts: [],
  wfmNotificationsEnabled: false,
  autoCloseWfmOrders: true,
  showTradeNotification: true,
});
