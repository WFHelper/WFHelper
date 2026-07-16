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

export type OverlayWindowKey = "reward" | "planner" | "rivenLeft" | "rivenRight" | "arbiSummary";

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
  messageNotificationsEnabled: boolean;
  messageNotificationsWhileFocused: boolean;
  autoCloseWfmOrders: boolean;
  relicRewardsOverlayEnabled: boolean;
  relicRecommendationOverlayEnabled: boolean;
  tradeNotificationOverlayEnabled: boolean;
  rivenOverlayEnabled: boolean;
  arbiSummaryOverlayEnabled: boolean;
  arbiTrackingEnabled: boolean;
  /** Save failed-scan OCR images (riven crops, reward scan-debug bundles) to disk. */
  ocrDebugImagesEnabled: boolean;
  overlayScale: number;
  /** Per-window scale override; windows without an entry use overlayScale. */
  overlayWindowScales: Partial<Record<OverlayWindowKey, number>>;
  overlayWindowBounds: Partial<Record<OverlayWindowKey, OverlaySavedWindowBounds>>;
  /** True once the user has dragged a live overlay; retires the move hint chip. */
  overlayDragHintDismissed: boolean;
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
  messageNotificationsEnabled: true,
  // Off by default: while focused you also see your own sends, so stay quiet.
  messageNotificationsWhileFocused: false,
  autoCloseWfmOrders: true,
  relicRewardsOverlayEnabled: true,
  relicRecommendationOverlayEnabled: true,
  tradeNotificationOverlayEnabled: true,
  rivenOverlayEnabled: true,
  arbiSummaryOverlayEnabled: true,
  arbiTrackingEnabled: true,
  ocrDebugImagesEnabled: false,
  overlayScale: 1,
  overlayWindowScales: Object.freeze({}),
  overlayWindowBounds: Object.freeze({}),
  overlayDragHintDismissed: false,
});

type OverlayToggleKey =
  | "relicRewardsOverlayEnabled"
  | "relicRecommendationOverlayEnabled"
  | "tradeNotificationOverlayEnabled"
  | "rivenOverlayEnabled"
  | "arbiSummaryOverlayEnabled";

type OverlayToggleSettings = Partial<Pick<OverlaySettings, OverlayToggleKey>> | null | undefined;

/** Unset -> on; only an explicit `false` disables the overlay. */
function isOverlayToggleEnabled(settings: OverlayToggleSettings, key: OverlayToggleKey): boolean {
  return settings?.[key] !== false;
}

export const isRelicRewardsOverlayEnabled = (s: OverlayToggleSettings) =>
  isOverlayToggleEnabled(s, "relicRewardsOverlayEnabled");
export const isRelicRecommendationOverlayEnabled = (s: OverlayToggleSettings) =>
  isOverlayToggleEnabled(s, "relicRecommendationOverlayEnabled");
export const isTradeNotificationOverlayEnabled = (s: OverlayToggleSettings) =>
  isOverlayToggleEnabled(s, "tradeNotificationOverlayEnabled");
export const isRivenOverlayEnabled = (s: OverlayToggleSettings) =>
  isOverlayToggleEnabled(s, "rivenOverlayEnabled");
export const isArbiSummaryOverlayEnabled = (s: OverlayToggleSettings) =>
  isOverlayToggleEnabled(s, "arbiSummaryOverlayEnabled");
