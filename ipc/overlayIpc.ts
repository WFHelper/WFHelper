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
} from "../config/shared/ipcChannels";
import { OVERLAY_FORWARDED_CSS_VARS } from "../config/shared/themeCssVars";

const log = withScope("overlayIpc");

import { globalShortcut, app } from "electron";
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

function sanitizeOverlayThemeVars(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};

  const input = raw as Record<string, unknown>;
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!OVERLAY_THEME_VAR_ALLOWLIST.has(key)) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
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

function ensureOverlayWindowPrimed(): void {
  const rwc = rewardOverlayIpc.getRewardWindowsController();
  const pwc = rewardOverlayIpc.getPlannerWindowsController();
  rwc.createOverlayWindow({ show: false });
  pwc.createOverlayWindow({ show: false });
  rwc.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
  pwc.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
  pushOverlayInteractionMode();
  pushOverlayThemeVars();
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

function register(): void {
  ensureOverlayWindowPrimed();
  setTimeout(() => {
    if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) {
      ctx.overlayWindow.hide();
    }
    if (ctx.plannerOverlayWindow && !ctx.plannerOverlayWindow.isDestroyed()) {
      ctx.plannerOverlayWindow.hide();
    }
  }, 150);

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

  handleAuthorized(
    OVERLAY_SET_SETTINGS,
    assertMainRendererSender,
    async (_event, nextSettings: unknown) => {
      const settings = settingsController.setOverlaySettings(nextSettings);
      settingsController.registerOverlayHotkey();
      applyOverlayAvailabilitySettings();
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
