interface CycleAlerts {
  earth: boolean;
  cetus: boolean;
  vallis: boolean;
  cambion: boolean;
  duviri: boolean;
}

interface FissureAlert {
  id: string;
  tier: string;
  missionType: string;
  steelPath: "any" | "normal" | "steel";
  planet: string;
}

export type OverlayWindowKey = "reward" | "planner" | "rivenLeft" | "rivenRight";

export interface OverlaySavedWindowBounds {
  x: number;
  y: number;
  displayId?: string | null;
}

export interface OverlaySettings {
  [key: string]: unknown;
  autoTriggerEnabled: boolean;
  hotkeyEnabled: boolean;
  hotkey: string;
  interactionHotkeyEnabled: boolean;
  interactionHotkey: string;
  worldNotificationsEnabled: boolean;
  cycleAlerts: CycleAlerts;
  cycleAlertMinutesBefore: number;
  fissureAlerts: FissureAlert[];
  notificationSoundEnabled: boolean;
  wfmNotificationsEnabled: boolean;
  autoCloseWfmOrders: boolean;
  relicRewardsOverlayEnabled: boolean;
  relicRecommendationOverlayEnabled: boolean;
  tradeNotificationOverlayEnabled: boolean;
  rivenOverlayEnabled: boolean;
  overlayScale: number;
  overlayWindowBounds: Partial<Record<OverlayWindowKey, OverlaySavedWindowBounds>>;
}

export const OVERLAY_SETTINGS_DEFAULTS = Object.freeze({
  autoTriggerEnabled: true,
  hotkeyEnabled: true,
  hotkey: "F8",
  interactionHotkeyEnabled: true,
  interactionHotkey: "Control+Tab",
  worldNotificationsEnabled: true,
  cycleAlerts: Object.freeze({
    earth: false,
    cetus: false,
    vallis: false,
    cambion: false,
    duviri: false,
  }),
  cycleAlertMinutesBefore: 3,
  fissureAlerts: Object.freeze([] as FissureAlert[]),
  notificationSoundEnabled: true,
  wfmNotificationsEnabled: false,
  autoCloseWfmOrders: true,
  relicRewardsOverlayEnabled: true,
  relicRecommendationOverlayEnabled: true,
  tradeNotificationOverlayEnabled: true,
  rivenOverlayEnabled: true,
  overlayScale: 1,
  overlayWindowBounds: Object.freeze({}),
});

type OverlayToggleKey =
  | "relicRewardsOverlayEnabled"
  | "relicRecommendationOverlayEnabled"
  | "tradeNotificationOverlayEnabled"
  | "rivenOverlayEnabled";

function isOverlayToggleEnabled(
  settings: Partial<Pick<OverlaySettings, OverlayToggleKey>> | null | undefined,
  key: OverlayToggleKey,
): boolean {
  return settings?.[key] !== false;
}

export function isRelicRewardsOverlayEnabled(
  settings: Pick<OverlaySettings, "relicRewardsOverlayEnabled"> | null | undefined,
): boolean {
  return isOverlayToggleEnabled(settings, "relicRewardsOverlayEnabled");
}

export function isRelicRecommendationOverlayEnabled(
  settings: Pick<OverlaySettings, "relicRecommendationOverlayEnabled"> | null | undefined,
): boolean {
  return isOverlayToggleEnabled(settings, "relicRecommendationOverlayEnabled");
}

export function isTradeNotificationOverlayEnabled(
  settings: Pick<OverlaySettings, "tradeNotificationOverlayEnabled"> | null | undefined,
): boolean {
  return isOverlayToggleEnabled(settings, "tradeNotificationOverlayEnabled");
}

export function isRivenOverlayEnabled(
  settings: Pick<OverlaySettings, "rivenOverlayEnabled"> | null | undefined,
): boolean {
  return isOverlayToggleEnabled(settings, "rivenOverlayEnabled");
}
