import { registerOverlayEditor } from "./overlay/editorIpc";
import ctx from "./context";
import {
  assertLocalizedOverlaySender,
  assertMainRendererSender,
  assertOverlayRendererSender,
  handleAuthorized,
  onAuthorized,
} from "./ipcSecurity";
import { overlayMessages, setOverlayLocale } from "./overlayI18n";
import { createTray, destroyTray, isTrayActive } from "./trayIpc";
import { disposeAppHotkeys, overlayHotkeyBackend } from "./hotkeyRegistry";
import { createOverlaySettingsController } from "./overlay/settings";
import { moveOverlayWindowBy } from "./overlay/windows";
import { getTradeNotificationPlacementRect, hideTradeNotification } from "./tradeNotificationIpc";
import { writeFileAtomicSync } from "../services/atomicFile";
import { userDataPath } from "../services/userDataPath";
import { asRecord } from "../config/shared/objectValidation";
import { withScope } from "../services/logger";
import { matchesAcceleratorInput } from "../services/acceleratorVk";
import { resolveWarframeUiScale } from "../services/eeLogPath";
import * as warframeStatus from "../services/warframeStatus";
import { configureWarframeLifecycle } from "../services/warframeLifecycle";
import * as rivenOverlayIpc from "./rivenOverlayIpc";
import * as rewardOverlayIpc from "./rewardOverlayIpc";
import * as arbiOverlayIpc from "./arbiOverlayIpc";
import * as arbiRunTracker from "../services/arbiRunTracker";
import * as ptRunTracker from "../services/profitTakerTracker";
import * as missionRewards from "../services/missionRewards";
import * as wfmPresence from "../services/wfmPresence";
import * as inventorySync from "../services/inventorySync";
import { setOcrDebugDumpsEnabled } from "../services/rewardScanDebug";
import { applyMainWindowZoom } from "./mainWindowZoom";
import {
  isArbiSummaryOverlayEnabled,
  isRelicRecommendationOverlayEnabled,
  isRelicRewardsOverlayEnabled,
  isRivenOverlayEnabled,
  isScalableOverlayWindow,
  isTradeNotificationOverlayEnabled,
  OVERLAY_SETTINGS_DEFAULTS,
  OVERLAY_SETTINGS_FILE_NAME,
  OVERLAY_WINDOW_KEYS,
  type OverlaySettings,
  type OverlayWindowKey,
} from "../config/runtime/overlaySettings";
import { clampNumber } from "../config/shared/numeric";
import {
  OVERLAY_INTERACTION_MODE,
  OVERLAY_THEME_VARS,
  OVERLAY_GET_SETTINGS,
  OVERLAY_GET_DETECTED_UI_SCALE,
  OVERLAY_GET_MESSAGES,
  OVERLAY_GET_THEME_VARS,
  OVERLAY_LOCALE_UPDATED,
  OVERLAY_MESSAGES,
  OVERLAY_SET_SETTINGS,
  OVERLAY_THEME_UPDATED,
  OVERLAY_DRAG_MOVE,
  OVERLAY_READY,
  OVERLAY_PLACEMENT_LAYOUT,
  OVERLAY_SAVE_PLACEMENT,
  OVERLAY_SAVE_SCALE,
} from "../config/shared/ipcChannels";
import {
  OVERLAY_FORWARDED_COLOR_VARS,
  OVERLAY_FORWARDED_CSS_VARS,
  OVERLAY_FORWARDED_EFFECT_VARS,
  OVERLAY_FORWARDED_FONT_VARS,
  OVERLAY_OPACITY_CSS_VARS,
} from "../config/shared/themeCssVars";
import { isOverlayOpacityPercent } from "../config/shared/overlayOpacity";

const log = withScope("overlayIpc");

import { app, BrowserWindow, screen, type WebContents } from "electron";
import fs from "node:fs";

function pushOverlayInteractionMode(): void {
  const payload = {
    interactive: !!ctx.overlayInteractiveMode,
  };
  rewardOverlayIpc.rewardWindowsController.sendOverlayEvent(OVERLAY_INTERACTION_MODE, payload);
  rewardOverlayIpc.plannerWindowsController.sendOverlayEvent(OVERLAY_INTERACTION_MODE, payload);
}

async function bringOverlayToWarframeDisplayIfAvailable(): Promise<void> {
  try {
    const rwc = rewardOverlayIpc.rewardWindowsController;
    const pwc = rewardOverlayIpc.plannerWindowsController;
    const status = await warframeStatus.getStatus({ force: true });
    if (status?.focusedDisplayId) {
      const anchor = { sourceDisplayId: String(status.focusedDisplayId) };
      rwc.setAnchorMeta(anchor);
      pwc.setAnchorMeta(anchor);
      rwc.positionOverlayWindow(rwc.getAnchorMeta());
      pwc.positionOverlayWindow(pwc.getAnchorMeta());
    }
  } catch {
    // best effort
  }
}

function setOverlayInteractionMode(enabled: boolean, source = "unknown"): void {
  const rwc = rewardOverlayIpc.rewardWindowsController;
  const pwc = rewardOverlayIpc.plannerWindowsController;
  const next = !!enabled;
  const rewardExists = !!(ctx.overlayWindow && !ctx.overlayWindow.isDestroyed());
  const plannerExists = !!(ctx.plannerOverlayWindow && !ctx.plannerOverlayWindow.isDestroyed());
  if (ctx.overlayInteractiveMode === next && (rewardExists || plannerExists)) {
    if (rewardExists) rwc.setOverlayInteractiveMode(next);
    if (plannerExists) pwc.setOverlayInteractiveMode(next);
    pushOverlayInteractionMode();
    return;
  }

  ctx.overlayInteractiveMode = next;
  if (rewardExists) rwc.setOverlayInteractiveMode(next);
  if (plannerExists) pwc.setOverlayInteractiveMode(next);
  pushOverlayInteractionMode();
  log.info(`[OverlayInteraction] mode=${next ? "interactive" : "passive"} source=${source}`);
}

function toggleOverlayInteractionMode(source = "unknown"): void {
  // The hotkey wants the overlay back even while the game is unfocused, as it
  // does for the riven panels.
  rewardOverlayIpc.rewardWindowsController.restoreAfterUnfocus();
  rewardOverlayIpc.plannerWindowsController.restoreAfterUnfocus();
  const plannerVisible = rewardOverlayIpc.plannerWindowsController.isOverlayWindowVisible();
  const rewardVisible = rewardOverlayIpc.rewardWindowsController.isOverlayWindowVisible();
  const rivenLeftExists = !!(
    ctx.rivenOverlayLeftWindow && !ctx.rivenOverlayLeftWindow.isDestroyed()
  );
  const anyRivenVisible = rivenOverlayIpc.isAnyRivenWindowVisible();

  const anyActive = plannerVisible || rewardVisible || (anyRivenVisible && rivenLeftExists);

  if (!anyActive) {
    return;
  }

  const next = anyRivenVisible
    ? !rivenOverlayIpc.isRivenInteractiveMode()
    : !ctx.overlayInteractiveMode;
  if (next) {
    warframeStatus.captureWarframeFocus();
  } else {
    const handles = [
      ctx.overlayWindow,
      ctx.plannerOverlayWindow,
      ctx.rivenOverlayLeftWindow,
      ctx.rivenOverlayRightWindow,
    ].flatMap((win) => (win && !win.isDestroyed() ? [win.getNativeWindowHandle()] : []));
    warframeStatus.restoreWarframeFocus(handles);
  }
  if (anyRivenVisible) {
    rivenOverlayIpc.setRivenInteractiveMode(next);
  }

  setOverlayInteractionMode(next, source);
}

const OVERLAY_THEME_VAR_ALLOWLIST: ReadonlySet<string> = new Set(OVERLAY_FORWARDED_CSS_VARS);
const OVERLAY_COLOR_VAR_SET: ReadonlySet<string> = new Set(OVERLAY_FORWARDED_COLOR_VARS);
const OVERLAY_FONT_VAR_SET: ReadonlySet<string> = new Set(OVERLAY_FORWARDED_FONT_VARS);
const OVERLAY_EFFECT_VAR_SET: ReadonlySet<string> = new Set(OVERLAY_FORWARDED_EFFECT_VARS);
const SAFE_COLOR_FUNCTION_RE = /^(?:rgb|rgba|hsl|hsla|oklch)\(\s*[-+0-9.%\s,/]+\)$/i;
const SAFE_HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SAFE_FONT_STACK_RE = /^[a-z0-9\s"',-]{1,120}$/i;
const SAFE_COLOR_REF_RE =
  /^var\(--(?:bg-(?:deep|base|surface|raised|hover)|accent(?:-dim|-bright|-glow)?|text-(?:primary|secondary|muted)|success|warning|danger|info|border(?:-strong)?)\)$/;
const SAFE_COLOR_MIX_RE =
  /^color-mix\(in srgb, var\(--(?:bg-(?:deep|base|surface|raised|hover)|border(?:-strong)?)\) (?:[1-9]\d?|100)%, transparent\)$/;

function boundedCssLength(value: string, min: number, max: number): boolean {
  const match = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(value);
  if (!match) return false;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= min && n <= max;
}

function isSafeOverlayColor(value: string): boolean {
  return (
    value.length <= 96 && (SAFE_HEX_COLOR_RE.test(value) || SAFE_COLOR_FUNCTION_RE.test(value))
  );
}

function isSafeOverlayFontValue(value: string): boolean {
  if (!SAFE_FONT_STACK_RE.test(value)) return false;
  return !/url|expression/i.test(value);
}

function isSafeOverlayEffectValue(key: string, value: string): boolean {
  if (key === "--overlay-opacity" || OVERLAY_OPACITY_CSS_VARS.includes(key)) {
    return isOverlayOpacityPercent(value);
  }
  if (key.startsWith("--radius-")) return boundedCssLength(value, 0, 3);
  if (key === "--ui-backdrop-blur") {
    return value === "none" || /^blur\((?:[1-9]|1\d|2[0-4])px\)$/.test(value);
  }
  if (key === "--ui-panel-shadow") return value === "none";
  if (
    key === "--ui-panel-bg" ||
    key === "--ui-panel-border" ||
    key === "--ui-control-bg" ||
    key === "--ui-control-border"
  ) {
    return (
      value === "transparent" || SAFE_COLOR_REF_RE.test(value) || SAFE_COLOR_MIX_RE.test(value)
    );
  }
  return false;
}

function isSafeOverlayThemeValue(key: string, value: string): boolean {
  if (/[;{}]/.test(value)) return false;
  if (OVERLAY_COLOR_VAR_SET.has(key)) return isSafeOverlayColor(value);
  if (OVERLAY_FONT_VAR_SET.has(key)) {
    if (
      key === "--font-heading-size" ||
      key === "--font-body-size" ||
      key === "--font-small-size"
    ) {
      return boundedCssLength(value, 0.3, 5);
    }
    return isSafeOverlayFontValue(value);
  }
  if (OVERLAY_EFFECT_VAR_SET.has(key)) return isSafeOverlayEffectValue(key, value);
  return false;
}

function sanitizeOverlayThemeVars(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};

  const input = raw as Record<string, unknown>;
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!OVERLAY_THEME_VAR_ALLOWLIST.has(key)) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (!isSafeOverlayThemeValue(key, trimmed)) continue;
    sanitized[key] = trimmed;
  }
  return sanitized;
}

function broadcastToOpenOverlays(channel: string, payload: unknown): void {
  rewardOverlayIpc.rewardWindowsController.sendOverlayEvent(channel, payload);
  rewardOverlayIpc.plannerWindowsController.sendOverlayEvent(channel, payload);
  arbiOverlayIpc.arbiSummaryWindowsController.sendOverlayEvent(channel, payload);
  rivenOverlayIpc.forEachRivenWindow((win) => win.webContents.send(channel, payload));
  const toast = ctx.tradeNotificationWindow;
  if (toast && !toast.isDestroyed()) toast.webContents.send(channel, payload);
}

function pushOverlayThemeVars(): void {
  if (!ctx.overlayThemeVars || Object.keys(ctx.overlayThemeVars).length === 0) return;
  broadcastToOpenOverlays(OVERLAY_THEME_VARS, { ...ctx.overlayThemeVars });
}

function pushOverlayMessages(): void {
  broadcastToOpenOverlays(OVERLAY_MESSAGES, overlayMessages());
}

function onRelicRewardTrigger(source = "manual", stalenessMs = 0): void {
  rewardOverlayIpc.onRelicRewardTrigger(
    source,
    stalenessMs,
    pushOverlayInteractionMode,
    pushOverlayThemeVars,
    bringOverlayToWarframeDisplayIfAvailable,
  );
}

const OVERLAY_SETTINGS_FILE = userDataPath(OVERLAY_SETTINGS_FILE_NAME);

const settingsController = createOverlaySettingsController({
  log,
  fs,
  writeFileAtomic: writeFileAtomicSync,
  globalShortcut: overlayHotkeyBackend,
  ctx,
  settingsFile: OVERLAY_SETTINGS_FILE,
  defaults: OVERLAY_SETTINGS_DEFAULTS,
  onRelicRewardTrigger,
  onToggleOverlayInteractionMode: toggleOverlayInteractionMode,
  onRivenRescanTrigger: rivenOverlayIpc.onRivenManualRescan,
  configureWarframeLifecycle,
});

rewardOverlayIpc.configureOverlaySettingsPersistence(settingsController.saveOverlaySettings);
rivenOverlayIpc.configureOverlaySettingsPersistence(settingsController.saveOverlaySettings);
arbiOverlayIpc.configureOverlaySettingsPersistence(settingsController.saveOverlaySettings);

function onRelicSelectionTrigger(source: string): void {
  rewardOverlayIpc.onRelicSelectionTrigger(
    source,
    pushOverlayInteractionMode,
    pushOverlayThemeVars,
    bringOverlayToWarframeDisplayIfAvailable,
  );
}

function onRelicSelectionClose(): void {
  rewardOverlayIpc.onRelicSelectionClose(pushOverlayInteractionMode);
}

function applyOverlayAvailabilitySettings(previousSettings: OverlaySettings): void {
  if (!isRelicRewardsOverlayEnabled(ctx.overlaySettings)) {
    rewardOverlayIpc.rewardWindowsController.clearOverlayAutoHideTimer();
    rewardOverlayIpc.rewardWindowsController.hideOverlayWindow();
  }

  if (!isRelicRecommendationOverlayEnabled(ctx.overlaySettings)) {
    rewardOverlayIpc.plannerWindowsController.clearOverlayAutoHideTimer();
    rewardOverlayIpc.plannerWindowsController.hideOverlayWindow();
  }

  const repSettingsChanged =
    previousSettings.tradeRepHotkeyEnabled !== ctx.overlaySettings.tradeRepHotkeyEnabled ||
    previousSettings.tradeRepHotkey !== ctx.overlaySettings.tradeRepHotkey;
  if (!isTradeNotificationOverlayEnabled(ctx.overlaySettings) || repSettingsChanged) {
    hideTradeNotification();
  }

  if (!isRivenOverlayEnabled(ctx.overlaySettings)) {
    rivenOverlayIpc.onRivenSessionClose();
  }

  if (!isArbiSummaryOverlayEnabled(ctx.overlaySettings)) {
    arbiOverlayIpc.arbiSummaryWindowsController.hideOverlayWindow();
  }
}

function isRivenOverlayWindow(win: BrowserWindow | null): boolean {
  return !!(
    win &&
    ((ctx.rivenOverlayLeftWindow &&
      !ctx.rivenOverlayLeftWindow.isDestroyed() &&
      win.webContents.id === ctx.rivenOverlayLeftWindow.webContents.id) ||
      (ctx.rivenOverlayRightWindow &&
        !ctx.rivenOverlayRightWindow.isDestroyed() &&
        win.webContents.id === ctx.rivenOverlayRightWindow.webContents.id))
  );
}

function moveInteractiveOverlayWindow(sender: WebContents, rawDelta: unknown): void {
  const win = BrowserWindow.fromWebContents(sender);
  if (!win || win.isDestroyed()) return;

  const dragBlocked = isRivenOverlayWindow(win)
    ? !rivenOverlayIpc.isRivenInteractiveMode()
    : arbiOverlayIpc.isArbiSummaryWindow(win)
      ? false
      : !ctx.overlayInteractiveMode;
  if (dragBlocked) return;

  const delta = asRecord(rawDelta) ?? {};
  const dx = Math.round(Number(delta.dx));
  const dy = Math.round(Number(delta.dy));
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  // Deltas arrive batched per animation frame, so a fast flick can be large.
  if (Math.abs(dx) > 1000 || Math.abs(dy) > 1000) return;
  if (dx === 0 && dy === 0) return;

  moveOverlayWindowBy(win, dx, dy);
}

function register(): void {
  if (process.platform === "win32") {
    // The game-only keyboard hook stops matching once an overlay takes focus.
    const attachInteractionShortcut = (win: BrowserWindow) => {
      win.webContents.on("before-input-event", (event, input) => {
        if (
          !win.isFocused() ||
          !ctx.overlaySettings.interactionHotkeyEnabled ||
          input.type !== "keyDown" ||
          input.isAutoRepeat ||
          (win !== ctx.overlayWindow &&
            win !== ctx.plannerOverlayWindow &&
            !isRivenOverlayWindow(win))
        )
          return;
        if (!matchesAcceleratorInput(ctx.overlaySettings.interactionHotkey, input)) return;
        event.preventDefault();
        toggleOverlayInteractionMode("overlay-keyboard");
      });
    };
    app.on("browser-window-created", (_event, win) => attachInteractionShortcut(win));
    BrowserWindow.getAllWindows().forEach(attachInteractionShortcut);
  }
  const overlayEditor = registerOverlayEditor(
    settingsController.saveOverlaySettings,
    (kind) => {
      if (kind === "reward")
        rewardOverlayIpc.rewardWindowsController.positionOverlayWindow(
          rewardOverlayIpc.rewardWindowsController.getAnchorMeta(),
        );
      else if (kind === "planner")
        rewardOverlayIpc.plannerWindowsController.positionOverlayWindow(
          rewardOverlayIpc.plannerWindowsController.getAnchorMeta(),
        );
      else if (kind === "arbiSummary") arbiOverlayIpc.positionArbiSummaryWindow();
      else if (kind === "rivenLeft" || kind === "rivenRight")
        rivenOverlayIpc.positionRivenOverlayWindows();
    },
    (kind) => {
      if (kind === "reward")
        return rewardOverlayIpc.rewardWindowsController.getOverlayBoundsForActiveDisplay();
      if (kind === "planner")
        return rewardOverlayIpc.plannerWindowsController.getOverlayBoundsForActiveDisplay();
      if (kind === "arbiSummary") return arbiOverlayIpc.getArbiSummaryPlacementRect();
      if (kind === "rivenLeft") return rivenOverlayIpc.getRivenPlacementRects().left;
      if (kind === "rivenRight") return rivenOverlayIpc.getRivenPlacementRects().right;
      return null;
    },
  );
  rivenOverlayIpc.register();
  rewardOverlayIpc.register(pushOverlayInteractionMode, pushOverlayThemeVars);
  arbiOverlayIpc.register();

  handleAuthorized(OVERLAY_GET_SETTINGS, assertMainRendererSender, async () => {
    return { ...ctx.overlaySettings };
  });

  handleAuthorized(OVERLAY_GET_DETECTED_UI_SCALE, assertMainRendererSender, async () => {
    return resolveWarframeUiScale();
  });

  handleAuthorized(OVERLAY_GET_THEME_VARS, assertLocalizedOverlaySender, async () => {
    return { ...(ctx.overlayThemeVars || {}) };
  });

  handleAuthorized(OVERLAY_GET_MESSAGES, assertLocalizedOverlaySender, async () => {
    return overlayMessages();
  });

  onAuthorized(OVERLAY_DRAG_MOVE, assertOverlayRendererSender, (event, rawDelta: unknown) => {
    moveInteractiveOverlayWindow(event.sender, rawDelta);
  });

  onAuthorized(OVERLAY_READY, assertOverlayRendererSender, (event) => {
    const senderId = event.sender.id;
    const rewardReady = rewardOverlayIpc.rewardWindowsController.markRendererReady(senderId);
    const plannerReady = rewardOverlayIpc.plannerWindowsController.markRendererReady(senderId);
    const rivenReady = rivenOverlayIpc.markRivenRendererReady(senderId);
    if (!rewardReady && !plannerReady && !rivenReady) {
      log.warn(`[OverlayWindow] ready signal from unknown overlay sender ${senderId}`);
    }
  });

  handleAuthorized(
    OVERLAY_SET_SETTINGS,
    assertMainRendererSender,
    async (_event, nextSettings: unknown) => {
      const incoming = asRecord(nextSettings);
      const importsLayouts =
        incoming && ("rewardLayout" in incoming || "overlayLayouts" in incoming);
      if (importsLayouts) overlayEditor.assertIdle();
      const nextScale = incoming ? clampNumber(incoming.overlayScale, 0.75, 1.5, NaN) : NaN;
      const scaleChanged =
        Number.isFinite(nextScale) && nextScale !== ctx.overlaySettings.overlayScale;
      const previousSettings = ctx.overlaySettings;
      const settings = await settingsController.setOverlaySettingsWithLifecycle(
        scaleChanged ? { ...(incoming ?? {}), overlayWindowScales: {} } : nextSettings,
        importsLayouts ? () => overlayEditor.assertIdle() : undefined,
      );
      settingsController.registerOverlayHotkey();
      applyOverlayAvailabilitySettings(previousSettings);
      arbiRunTracker.setArbiTrackingEnabled(settings.arbiTrackingEnabled !== false);
      ptRunTracker.setPtTrackingEnabled(settings.arbiTrackingEnabled !== false);
      missionRewards.setTrackingEnabled(settings.missionTrackingEnabled === true);
      if (settings.keepRunningOnClose === true) createTray();
      else destroyTray();
      setOcrDebugDumpsEnabled(settings.ocrDebugImagesEnabled !== false);
      inventorySync.apply("settings");
      wfmPresence.setOptions({
        autoIngameEnabled: settings.wfmAutoIngameEnabled === true,
        holdMinutes: settings.wfmStatusHoldMinutes,
        awayIdleEnabled: settings.wfmAwayIdleEnabled === true,
        awayIdleMinutes: settings.wfmAwayIdleMinutes,
        awayWhenClosedEnabled: settings.wfmAwayWhenClosedEnabled === true,
      });
      applyMainWindowZoom();
      rewardOverlayIpc.rewardWindowsController.positionOverlayWindow(
        rewardOverlayIpc.rewardWindowsController.getAnchorMeta(),
      );
      rewardOverlayIpc.plannerWindowsController.positionOverlayWindow(
        rewardOverlayIpc.plannerWindowsController.getAnchorMeta(),
      );
      rivenOverlayIpc.positionRivenOverlayWindows();
      if (importsLayouts) overlayEditor.refresh();
      return settings;
    },
  );

  onAuthorized(OVERLAY_THEME_UPDATED, assertMainRendererSender, (_event, rawVars: unknown) => {
    const sanitized = sanitizeOverlayThemeVars(rawVars);
    ctx.overlayThemeVars = sanitized;
    log.info(`[OverlayTheme] updated vars=${Object.keys(sanitized).length}`);
    if (Object.keys(sanitized).length > 0) {
      pushOverlayThemeVars();
    }
  });

  onAuthorized(OVERLAY_LOCALE_UPDATED, assertMainRendererSender, (_event, rawLocale: unknown) => {
    const locale = setOverlayLocale(rawLocale);
    if (!locale) return;
    log.info(`[OverlayI18n] locale=${locale}`);
    pushOverlayMessages();
    // The tray menu is built once and outlives the window, so it needs relabelling.
    if (isTrayActive()) createTray();
  });

  handleAuthorized(OVERLAY_PLACEMENT_LAYOUT, assertMainRendererSender, async () => {
    const area = screen.getPrimaryDisplay().workArea;
    const rel = (rect: { x: number; y: number; width: number; height: number }) => ({
      x: rect.x - area.x,
      y: rect.y - area.y,
      width: rect.width,
      height: rect.height,
    });
    const riven = rivenOverlayIpc.getRivenPlacementRects();
    const userScale = (key: OverlayWindowKey) =>
      clampNumber(
        (ctx.overlaySettings.overlayWindowScales || {})[key] ?? ctx.overlaySettings.overlayScale,
        0.75,
        1.5,
        1,
      );
    return {
      area: { width: area.width, height: area.height },
      overlays: {
        reward: {
          ...rel(rewardOverlayIpc.rewardWindowsController.getOverlayBoundsForActiveDisplay()),
          scale: userScale("reward"),
        },
        planner: {
          ...rel(rewardOverlayIpc.plannerWindowsController.getOverlayBoundsForActiveDisplay()),
          scale: userScale("planner"),
        },
        rivenLeft: { ...rel(riven.left), scale: userScale("rivenLeft") },
        rivenRight: { ...rel(riven.right), scale: userScale("rivenRight") },
        arbiSummary: {
          ...rel(arbiOverlayIpc.getArbiSummaryPlacementRect()),
          scale: userScale("arbiSummary"),
        },
        tradeNotification: { ...rel(getTradeNotificationPlacementRect()), scale: 1 },
      },
    };
  });

  const placementKeys = new Set<OverlayWindowKey>(OVERLAY_WINDOW_KEYS);
  handleAuthorized(
    OVERLAY_SAVE_PLACEMENT,
    assertMainRendererSender,
    async (_event, rawKey: unknown, rawPos: unknown) => {
      const key = placementKeys.has(rawKey as OverlayWindowKey)
        ? (rawKey as OverlayWindowKey)
        : null;
      const pos = asRecord(rawPos);
      if (!key || !pos) return { ok: false };
      const xFrac = clampNumber(pos.xFrac, 0, 1, NaN);
      const yFrac = clampNumber(pos.yFrac, 0, 1, NaN);
      if (!Number.isFinite(xFrac) || !Number.isFinite(yFrac)) return { ok: false };

      const display = screen.getPrimaryDisplay();
      const area = display.workArea;
      const bounds = {
        ...ctx.overlaySettings.overlayWindowBounds?.[key],
        x: Math.round(area.x + xFrac * area.width),
        y: Math.round(area.y + yFrac * area.height),
        displayId: String(display.id),
      };
      ctx.overlaySettings = {
        ...ctx.overlaySettings,
        overlayWindowBounds: {
          ...(ctx.overlaySettings.overlayWindowBounds || {}),
          [key]: bounds,
        },
      };
      settingsController.saveOverlaySettings();
      log.info(`[OverlayPlacement] saved ${key} -> ${bounds.x},${bounds.y}`);
      return { ok: true };
    },
  );

  handleAuthorized(
    OVERLAY_SAVE_SCALE,
    assertMainRendererSender,
    async (_event, rawKey: unknown, rawScale: unknown) => {
      const key = placementKeys.has(rawKey as OverlayWindowKey)
        ? (rawKey as OverlayWindowKey)
        : null;
      const scale = clampNumber(rawScale, 0.75, 1.5, NaN);
      if (!key || !isScalableOverlayWindow(key) || !Number.isFinite(scale)) return { ok: false };

      ctx.overlaySettings = {
        ...ctx.overlaySettings,
        overlayWindowScales: {
          ...(ctx.overlaySettings.overlayWindowScales || {}),
          [key]: Number(scale.toFixed(2)),
        },
      };
      settingsController.saveOverlaySettings();

      if (key === "reward") {
        rewardOverlayIpc.rewardWindowsController.positionOverlayWindow(
          rewardOverlayIpc.rewardWindowsController.getAnchorMeta(),
        );
      } else if (key === "planner") {
        rewardOverlayIpc.plannerWindowsController.positionOverlayWindow(
          rewardOverlayIpc.plannerWindowsController.getAnchorMeta(),
        );
      } else if (key === "rivenLeft" || key === "rivenRight") {
        rivenOverlayIpc.positionRivenOverlayWindows();
      } else {
        arbiOverlayIpc.positionArbiSummaryWindow();
      }
      log.info(`[OverlayPlacement] scale ${key} -> ${scale.toFixed(2)}`);
      return { ok: true };
    },
  );
}

export const loadOverlaySettings = settingsController.loadOverlaySettings;
export const unregisterOverlayHotkey = settingsController.unregisterOverlayHotkey;
export const setOverlayHotkeysActive = settingsController.setHotkeysActive;

export function disposeOverlayHotkeys(): void {
  disposeAppHotkeys();
}

export { register, onRelicRewardTrigger, onRelicSelectionTrigger, onRelicSelectionClose };
