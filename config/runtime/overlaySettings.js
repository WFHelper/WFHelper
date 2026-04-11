"use strict";

const OVERLAY_OCR_ENGINES = Object.freeze(["windows", "tesseract"]);

const OVERLAY_SETTINGS_DEFAULTS = Object.freeze({
  autoTriggerEnabled: true,
  hotkeyEnabled: true,
  hotkey: "F8",
  interactionHotkeyEnabled: true,
  interactionHotkey: "Control+Tab",
  ocrEngine: "windows",
  ocrPasses: 2,
  matchThreshold: 0.74,
  ocrTimeoutMs: 15_000,
  worldNotificationsEnabled: true,
  cycleAlerts: Object.freeze({ earth: false, cetus: false, vallis: false, cambion: false }),
  fissureAlerts: Object.freeze([]),
  wfmNotificationsEnabled: false,
  autoCloseWfmOrders: true,
  showTradeNotification: true,
});

const OVERLAY_SETTINGS_LIMITS = Object.freeze({
  ocrPassesMin: 1,
  ocrPassesMax: 6,
  matchThresholdMin: 0.55,
  matchThresholdMax: 0.95,
  ocrTimeoutMsMin: 4_000,
  ocrTimeoutMsMax: 30_000,
});

module.exports = {
  OVERLAY_OCR_ENGINES,
  OVERLAY_SETTINGS_DEFAULTS,
  OVERLAY_SETTINGS_LIMITS,
};
