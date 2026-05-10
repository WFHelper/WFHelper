import ctx from "./context";
import {
  assertMainRendererSender,
  assertOverlayRendererSender,
  handleAuthorized,
  onAuthorized,
} from "./ipcSecurity";
import { createOverlaySettingsController } from "./overlay/settings";
import { withScope } from "../services/logger";
import * as warframeStatus from "../services/warframeStatus";
import * as rivenOverlayIpc from "./rivenOverlayIpc";
import * as rewardOverlayIpc from "./rewardOverlayIpc";
import {
  isRelicRecommendationOverlayEnabled,
  isRelicRewardsOverlayEnabled,
  isRivenOverlayEnabled,
  isTradeNotificationOverlayEnabled,
  OVERLAY_SETTINGS_DEFAULTS,
} from "../config/runtime/overlaySettings";
import {
  OVERLAY_INTERACTION_MODE,
  OVERLAY_THEME_VARS,
  OVERLAY_GET_SETTINGS,
  OVERLAY_GET_THEME_VARS,
  OVERLAY_SET_SETTINGS,
  OVERLAY_THEME_UPDATED,
  OVERLAY_DRAG_MOVE,
  OVERLAY_READY,
} from "../config/shared/ipcChannels";
import {
  OVERLAY_FORWARDED_COLOR_VARS,
  OVERLAY_FORWARDED_CSS_VARS,
  OVERLAY_FORWARDED_EFFECT_VARS,
  OVERLAY_FORWARDED_FONT_VARS,
} from "../config/shared/themeCssVars";

const log = withScope("overlayIpc");

import { BrowserWindow, globalShortcut, app, type WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";

function pushOverlayInteractionMode(): void {
  const payload = {
    interactive: !!ctx.overlayInteractiveMode,
  };
  rewardOverlayIpc.getRewardWindowsController().sendOverlayEvent(OVERLAY_INTERACTION_MODE, payload);
  rewardOverlayIpc
    .getPlannerWindowsController()
    .sendOverlayEvent(OVERLAY_INTERACTION_MODE, payload);
}

async function bringOverlayToWarframeDisplayIfAvailable(): Promise<void> {
  try {
    const rwc = rewardOverlayIpc.getRewardWindowsController();
    const pwc = rewardOverlayIpc.getPlannerWindowsController();
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
  const rwc = rewardOverlayIpc.getRewardWindowsController();
  const pwc = rewardOverlayIpc.getPlannerWindowsController();
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
  log.log(`[OverlayInteraction] mode=${next ? "interactive" : "passive"} source=${source}`);
}

function toggleOverlayInteractionMode(source = "unknown"): void {
  const plannerWindow =
    ctx.plannerOverlayWindow && !ctx.plannerOverlayWindow.isDestroyed()
      ? ctx.plannerOverlayWindow
      : null;
  const rewardWindow =
    ctx.overlayWindow && !ctx.overlayWindow.isDestroyed() ? ctx.overlayWindow : null;

  // Check if any riven window is visible
  const rivenLeftWindow =
    ctx.rivenOverlayLeftWindow && !ctx.rivenOverlayLeftWindow.isDestroyed()
      ? ctx.rivenOverlayLeftWindow
      : null;
  const anyRivenVisible =
    (rivenLeftWindow && rivenLeftWindow.isVisible()) ||
    (ctx.rivenOverlayRightWindow &&
      !ctx.rivenOverlayRightWindow.isDestroyed() &&
      ctx.rivenOverlayRightWindow.isVisible());

  // Only consider a window "active" if it is currently visible.
  const activeWindow =
    plannerWindow && plannerWindow.isVisible()
      ? plannerWindow
      : rewardWindow && rewardWindow.isVisible()
        ? rewardWindow
        : anyRivenVisible
          ? rivenLeftWindow
          : null;

  if (!activeWindow) {
    // Nothing is visible — do nothing. This prevents the reward overlay from
    // appearing unexpectedly when Ctrl+Tab is pressed after closing the planner.
    return;
  }

  // If any riven overlay is visible, toggle interactive mode on both riven windows.
  if (anyRivenVisible) {
    rivenOverlayIpc.toggleRivenInteractiveMode();
  }

  setOverlayInteractionMode(!ctx.overlayInteractiveMode, source);
}

// Allowlist is derived from the shared list in config/shared/themeCssVars.ts so
// renderer (sender) and main (gate) cannot drift. Update that file to add a new
// themed variable.
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

function pushOverlayThemeVars(): void {
  if (!ctx.overlayThemeVars || Object.keys(ctx.overlayThemeVars).length === 0) return;
  const vars = { ...ctx.overlayThemeVars };
  rewardOverlayIpc.getRewardWindowsController().sendOverlayEvent(OVERLAY_THEME_VARS, vars);
  rewardOverlayIpc.getPlannerWindowsController().sendOverlayEvent(OVERLAY_THEME_VARS, vars);
  rivenOverlayIpc.forEachRivenWindow((win) => win.webContents.send(OVERLAY_THEME_VARS, vars));
}

function onRelicRewardTrigger(source = "manual"): void {
  rewardOverlayIpc.onRelicRewardTrigger(
    source,
    pushOverlayInteractionMode,
    pushOverlayThemeVars,
    bringOverlayToWarframeDisplayIfAvailable,
  );
}

const OVERLAY_SETTINGS_FILE = path.join(app.getPath("userData"), "overlay-settings.json");

const settingsController = createOverlaySettingsController({
  log,
  fs,
  globalShortcut,
  ctx,
  settingsFile: OVERLAY_SETTINGS_FILE,
  defaults: OVERLAY_SETTINGS_DEFAULTS,
  onRelicRewardTrigger,
  onToggleOverlayInteractionMode: toggleOverlayInteractionMode,
});

rewardOverlayIpc.configureOverlaySettingsPersistence(settingsController.saveOverlaySettings);
rivenOverlayIpc.configureOverlaySettingsPersistence(settingsController.saveOverlaySettings);

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

function applyOverlayAvailabilitySettings(): void {
  if (!isRelicRewardsOverlayEnabled(ctx.overlaySettings)) {
    rewardOverlayIpc.getRewardWindowsController().clearOverlayAutoHideTimer();
    if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) ctx.overlayWindow.hide();
  }

  if (!isRelicRecommendationOverlayEnabled(ctx.overlaySettings)) {
    rewardOverlayIpc.getPlannerWindowsController().clearOverlayAutoHideTimer();
    if (ctx.plannerOverlayWindow && !ctx.plannerOverlayWindow.isDestroyed()) {
      ctx.plannerOverlayWindow.hide();
    }
  }

  if (!isTradeNotificationOverlayEnabled(ctx.overlaySettings)) {
    if (ctx.tradeNotificationWindow && !ctx.tradeNotificationWindow.isDestroyed()) {
      ctx.tradeNotificationWindow.hide();
    }
  }

  if (!isRivenOverlayEnabled(ctx.overlaySettings)) {
    rivenOverlayIpc.onRivenSessionClose();
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

  const isRiven = isRivenOverlayWindow(win);
  if (isRiven ? !rivenOverlayIpc.isRivenInteractiveMode() : !ctx.overlayInteractiveMode) return;

  const delta = rawDelta && typeof rawDelta === "object" ? (rawDelta as Record<string, unknown>) : {};
  const dx = Math.round(Number(delta.dx));
  const dy = Math.round(Number(delta.dy));
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  if (Math.abs(dx) > 200 || Math.abs(dy) > 200) return;
  if (dx === 0 && dy === 0) return;

  const bounds = win.getBounds();
  win.setBounds({ ...bounds, x: bounds.x + dx, y: bounds.y + dy }, false);
}

function register(): void {
  // Delegate domain-specific IPC to sub-modules
  rivenOverlayIpc.register();
  rewardOverlayIpc.register(pushOverlayInteractionMode, pushOverlayThemeVars);

  // Settings & theme IPC (shared across all overlays)
  handleAuthorized(OVERLAY_GET_SETTINGS, assertMainRendererSender, async () => {
    return { ...ctx.overlaySettings };
  });

  handleAuthorized(OVERLAY_GET_THEME_VARS, assertOverlayRendererSender, async () => {
    return { ...(ctx.overlayThemeVars || {}) };
  });

  onAuthorized(OVERLAY_DRAG_MOVE, assertOverlayRendererSender, (event, rawDelta: unknown) => {
    moveInteractiveOverlayWindow(event.sender, rawDelta);
  });

  onAuthorized(OVERLAY_READY, assertOverlayRendererSender, (event) => {
    const senderId = event.sender.id;
    const rewardReady = rewardOverlayIpc.getRewardWindowsController().markRendererReady(senderId);
    const plannerReady = rewardOverlayIpc.getPlannerWindowsController().markRendererReady(senderId);
    if (!rewardReady && !plannerReady) {
      log.warn(`[OverlayWindow] ready signal from unknown overlay sender ${senderId}`);
    }
  });

  handleAuthorized(
    OVERLAY_SET_SETTINGS,
    assertMainRendererSender,
    async (_event, nextSettings: unknown) => {
      const settings = settingsController.setOverlaySettings(nextSettings);
      settingsController.registerOverlayHotkey();
      applyOverlayAvailabilitySettings();
      rewardOverlayIpc
        .getRewardWindowsController()
        .positionOverlayWindow(rewardOverlayIpc.getRewardWindowsController().getAnchorMeta());
      rewardOverlayIpc
        .getPlannerWindowsController()
        .positionOverlayWindow(rewardOverlayIpc.getPlannerWindowsController().getAnchorMeta());
      rivenOverlayIpc.positionRivenOverlayWindows();
      return settings;
    },
  );

  onAuthorized(OVERLAY_THEME_UPDATED, assertMainRendererSender, (_event, rawVars: unknown) => {
    const sanitized = sanitizeOverlayThemeVars(rawVars);
    ctx.overlayThemeVars = sanitized;
    log.log(`[OverlayTheme] updated vars=${Object.keys(sanitized).length}`);
    if (Object.keys(sanitized).length > 0) {
      pushOverlayThemeVars();
    }
  });
}

export const loadOverlaySettings = settingsController.loadOverlaySettings;
export const registerOverlayHotkey = settingsController.registerOverlayHotkey;
export const unregisterOverlayHotkey = settingsController.unregisterOverlayHotkey;

export { register, onRelicRewardTrigger, onRelicSelectionTrigger, onRelicSelectionClose };

// Re-export riven callbacks for main.ts wiring
export {
  onRivenSessionClose,
  onRivenChatView,
  onRivenSessionOpen,
  onRivenRollPending,
  onRivenRollConfirmed,
  onRivenDioramaSetup,
  onRivenChoiceConfirmed,
} from "./rivenOverlayIpc";
