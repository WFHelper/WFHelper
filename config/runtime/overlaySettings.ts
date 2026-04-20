export interface CycleAlerts {
  earth: boolean;
  cetus: boolean;
  vallis: boolean;
  cambion: boolean;
  duviri: boolean;
}

export interface FissureAlert {
  id: string;
  tier: string;
  missionType: string;
  steelPath: "any" | "normal" | "steel";
  planet: string;
}

export interface OverlaySettings {
  [key: string]: unknown;
  autoTriggerEnabled: boolean;
  hotkeyEnabled: boolean;
  hotkey: string;
  interactionHotkeyEnabled: boolean;
  interactionHotkey: string;
  ocrEngine: string;
  ocrPasses: number;
  matchThreshold: number;
  ocrTimeoutMs: number;
  worldNotificationsEnabled: boolean;
  cycleAlerts: CycleAlerts;
  cycleAlertMinutesBefore: number;
  fissureAlerts: FissureAlert[];
  wfmNotificationsEnabled: boolean;
  autoCloseWfmOrders: boolean;
  showTradeNotification: boolean;
}

export const OVERLAY_SETTINGS_DEFAULTS = Object.freeze({
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
  cycleAlerts: Object.freeze({ earth: false, cetus: false, vallis: false, cambion: false, duviri: false }),
  cycleAlertMinutesBefore: 3,
  fissureAlerts: Object.freeze([] as FissureAlert[]),
  wfmNotificationsEnabled: false,
  autoCloseWfmOrders: true,
  showTradeNotification: true,
});

export const OVERLAY_SETTINGS_LIMITS = Object.freeze({
  ocrPassesMin: 1,
  ocrPassesMax: 6,
  matchThresholdMin: 0.55,
  matchThresholdMax: 0.95,
  ocrTimeoutMsMin: 4_000,
  ocrTimeoutMsMax: 30_000,
});
