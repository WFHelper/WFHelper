import { WFM_AWAY_IDLE_MINUTES_DEFAULT } from "../shared/wfm";

interface CycleAlerts {
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
  /** Play the Windows notification sound instead of the app's own clip. The
   *  system sound obeys the System Sounds volume; the clip obeys WFHelper's. */
  notificationSoundUsesSystem: boolean;
  wfmNotificationsEnabled: boolean;
  messageNotificationsEnabled: boolean;
  messageNotificationsWhileFocused: boolean;
  autoCloseWfmOrders: boolean;
  /** Flip WFM presence to "In Game" while Warframe runs, restore it on exit. */
  wfmAutoIngameEnabled: boolean;
  /** Minutes an online/ingame presence is held before dropping to invisible; 0 = no expiry. */
  wfmStatusHoldMinutes: number;
  /** Go invisible after `wfmAwayIdleMinutes` without keyboard or mouse input. */
  wfmAwayIdleEnabled: boolean;
  wfmAwayIdleMinutes: number;
  /** Hold invisible whenever Warframe is not running. */
  wfmAwayWhenClosedEnabled: boolean;
  tradeRepHotkeyEnabled: boolean;
  tradeRepHotkey: string;
  /** Seconds the trade toast holds. A +rep offer overrides anything shorter,
   *  so the user can still reach the keybind. */
  tradeNotificationSeconds: number;
  /** Also raise an OS notification on a trade; the in-game toast shows either way. */
  tradeDesktopNotificationsEnabled: boolean;
  /** Seconds a Windows notification stays on screen. Windows only: the toast is
   *  raised as incomingCall so it holds until we pull it back. */
  windowsNotificationSeconds: number;
  relicRewardsOverlayEnabled: boolean;
  relicRecommendationOverlayEnabled: boolean;
  tradeNotificationOverlayEnabled: boolean;
  rivenOverlayEnabled: boolean;
  arbiSummaryOverlayEnabled: boolean;
  arbiTrackingEnabled: boolean;
  /** Refresh inventory in the background; only applies to the helper source. */
  autoInventorySyncEnabled: boolean;
  /** Save failed-scan OCR images (riven crops, reward scan-debug bundles); on unless opted out. */
  ocrDebugImagesEnabled: boolean;
  /** Refuse the legacy Windows injection vectors audio and overlay suites use.
   *  Takes effect on the next start; also blocks legacy IMEs. */
  blockThirdPartyInjection: boolean;
  /** Closing the window hides it to the system tray instead of quitting, so
   *  alerts, notifications and EE.log watching keep running. */
  keepRunningOnClose: boolean;
  /** Warframe's in-game interface scale, used to align reward OCR crops. */
  warframeUiScale: number;
  /** Prefer the EE.cfg-detected scale; off makes the manual slider authoritative. */
  warframeUiScaleAuto: boolean;
  /** Main-window zoom multiplier applied on top of the display-derived base. */
  uiScale: number;
  overlayScale: number;
  /** Per-window scale override; windows without an entry use overlayScale. */
  overlayWindowScales: Partial<Record<OverlayWindowKey, number>>;
  overlayWindowBounds: Partial<Record<OverlayWindowKey, OverlaySavedWindowBounds>>;
  /** True once the user has dragged a live overlay; retires the move hint chip. */
  overlayDragHintDismissed: boolean;
}

// The injection guard reads this file straight off disk before the settings
// controller exists, so the name has two readers and must only be typed once.
export const OVERLAY_SETTINGS_FILE_NAME = "overlay-settings.json";

// The reward crop ratios were measured at 99% in-game interface scale, so this
// default keeps the scale correction an exact no-op for untouched settings.
export const REFERENCE_WARFRAME_UI_SCALE = 0.99;

export const OVERLAY_SETTINGS_DEFAULTS = Object.freeze({
  autoTriggerEnabled: true,
  hotkeyEnabled: true,
  hotkey: "F8",
  interactionHotkeyEnabled: true,
  interactionHotkey: "F7",
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
  notificationSoundUsesSystem: false,
  wfmNotificationsEnabled: false,
  messageNotificationsEnabled: true,
  // Off by default: while focused you also see your own sends, so stay quiet.
  messageNotificationsWhileFocused: false,
  autoCloseWfmOrders: true,
  // Off by default: it changes how other traders see you.
  wfmAutoIngameEnabled: false,
  wfmStatusHoldMinutes: 0,
  // Both off by default: they change how other traders see you.
  wfmAwayIdleEnabled: false,
  wfmAwayIdleMinutes: WFM_AWAY_IDLE_MINUTES_DEFAULT,
  wfmAwayWhenClosedEnabled: false,
  tradeRepHotkeyEnabled: true,
  tradeRepHotkey: "F9",
  tradeNotificationSeconds: 5,
  // Off by default: the in-game toast already covers the common case.
  tradeDesktopNotificationsEnabled: false,
  windowsNotificationSeconds: 5,
  relicRewardsOverlayEnabled: true,
  relicRecommendationOverlayEnabled: true,
  tradeNotificationOverlayEnabled: true,
  rivenOverlayEnabled: true,
  arbiSummaryOverlayEnabled: true,
  arbiTrackingEnabled: true,
  autoInventorySyncEnabled: true,
  ocrDebugImagesEnabled: true,
  blockThirdPartyInjection: true,
  // Off by default: closing the window has always quit, and an app that stays
  // alive in the tray unannounced reads as one that failed to exit.
  keepRunningOnClose: false,
  warframeUiScale: REFERENCE_WARFRAME_UI_SCALE,
  warframeUiScaleAuto: true,
  uiScale: 1,
  overlayScale: 1,
  overlayWindowScales: Object.freeze({}),
  overlayWindowBounds: Object.freeze({}),
  overlayDragHintDismissed: false,
});

// Migrate the old default because its global grab steals the standard tab shortcut.
export const LEGACY_INTERACTION_HOTKEY = "Control+Tab";

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
