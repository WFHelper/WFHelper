import type { OverlaySettings } from "../types/ipc.js";

export const OVERLAY_DEFAULTS: OverlaySettings = Object.freeze({
  autoTriggerEnabled: true,
  hotkeyEnabled: true,
  hotkey: "F8",
  interactionHotkeyEnabled: true,
  interactionHotkey: "Control+Tab",
  worldNotificationsEnabled: true,
  cycleAlerts: { earth: false, cetus: false, vallis: false, cambion: false, duviri: false },
  cycleAlertMinutesBefore: 3,
  fissureAlerts: [],
  wfmNotificationsEnabled: false,
  autoCloseWfmOrders: true,
  showTradeNotification: true,
});
