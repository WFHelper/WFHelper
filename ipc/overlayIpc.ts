import ctx from "./context";
import {
  assertAuthorizedSender,
  assertMainRendererSender,
  assertOverlayRendererSender,
  isAuthorizedSender,
} from "./ipcSecurity";
import { createOverlaySettingsController } from "./overlay/settings";
import { createRuntimeRequire } from "./runtimeRequire";
import { withScope } from "../services/logger";
import * as rewardScanner from "../services/rewardScanner";
import * as warframeStatus from "../services/warframeStatus";
import * as rivenOverlayIpc from "./rivenOverlayIpc";
import * as rewardOverlayIpc from "./rewardOverlayIpc";

const requireRuntime = createRuntimeRequire(__dirname, 1);

const log = withScope("overlayIpc");

const { ipcMain, globalShortcut } =
  require("electron") as typeof import("electron");
const fs = require("node:fs") as typeof import("node:fs");
const {
  OVERLAY_OCR_ENGINES,
  OVERLAY_SETTINGS_DEFAULTS,
  OVERLAY_SETTINGS_LIMITS,
} = requireRuntime<{
  OVERLAY_OCR_ENGINES: string[];
  OVERLAY_SETTINGS_DEFAULTS: Record<string, any>;
  OVERLAY_SETTINGS_LIMITS: Record<string, number>;
}>("config/runtime/overlaySettings");

// ── Cross-overlay helpers ────────────────────────────────────────────────────

function pushOverlayInteractionMode(): void {
  const payload = {
    interactive: !!ctx.overlayInteractiveMode,
  };
  rewardOverlayIpc.getRewardWindowsController().sendOverlayEvent("overlay-interaction-mode", payload);
  rewardOverlayIpc.getPlannerWindowsController().sendOverlayEvent("overlay-interaction-mode", payload);
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

// ── Theme management ─────────────────────────────────────────────────────────

const OVERLAY_THEME_VAR_ALLOWLIST = new Set([
  "--bg-deep",
  "--bg-base",
  "--bg-surface",
  "--bg-raised",
  "--bg-hover",
  "--accent",
  "--accent-dim",
  "--accent-bright",
  "--accent-glow",
  "--text-primary",
  "--text-secondary",
  "--text-muted",
  "--success",
  "--warning",
  "--danger",
  "--info",
  "--border",
  "--border-strong",
  "--font-display",
  "--font-body",
  "--font-heading-size",
  "--font-body-size",
  "--font-small-size",
]);

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
  rewardOverlayIpc.getRewardWindowsController().sendOverlayEvent("overlay-theme-vars", vars);
  rewardOverlayIpc.getPlannerWindowsController().sendOverlayEvent("overlay-theme-vars", vars);
  rivenOverlayIpc.forEachRivenWindow((win) => win.webContents.send("overlay-theme-vars", vars));
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

// ── Settings controller ──────────────────────────────────────────────────────

function onRelicRewardTrigger(source = "manual"): void {
  rewardOverlayIpc.onRelicRewardTrigger(
    source,
    pushOverlayInteractionMode,
    pushOverlayThemeVars,
    bringOverlayToWarframeDisplayIfAvailable,
  );
}

const { app } = require("electron") as typeof import("electron");
const path = require("node:path") as typeof import("node:path");
const OVERLAY_SETTINGS_FILE = path.join(app.getPath("userData"), "overlay-settings.json");

const settingsController = createOverlaySettingsController({
  log,
  fs,
  globalShortcut,
  ctx,
  settingsFile: OVERLAY_SETTINGS_FILE,
  defaults: OVERLAY_SETTINGS_DEFAULTS,
  limits: OVERLAY_SETTINGS_LIMITS,
  ocrEngines: OVERLAY_OCR_ENGINES,
  rewardScanner,
  onRelicRewardTrigger,
  onToggleOverlayInteractionMode: toggleOverlayInteractionMode,
});

// ── Relay callbacks (exposed to main.ts) ─────────────────────────────────────

function onRelicSelectionTrigger(source: string): void {
  const onCloseByEsc = () =>
    rewardOverlayIpc.onRelicSelectionCloseByEsc(pushOverlayInteractionMode);
  rewardOverlayIpc.onRelicSelectionTrigger(
    source,
    pushOverlayInteractionMode,
    pushOverlayThemeVars,
    bringOverlayToWarframeDisplayIfAvailable,
    onCloseByEsc,
  );
}

function onRelicSelectionClose(): void {
  rewardOverlayIpc.onRelicSelectionClose(pushOverlayInteractionMode);
}

// ── IPC registration ─────────────────────────────────────────────────────────

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
  ipcMain.handle("overlay:get-settings", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "overlay:get-settings");
    return { ...ctx.overlaySettings };
  });

  ipcMain.handle("overlay:get-theme-vars", async (event: unknown) => {
    assertAuthorizedSender(assertOverlayRendererSender, event as never, "overlay:get-theme-vars");
    return { ...(ctx.overlayThemeVars || {}) };
  });

  ipcMain.handle("overlay:set-settings", async (event: unknown, nextSettings: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "overlay:set-settings");

    const settings = settingsController.setOverlaySettings(nextSettings);
    settingsController.registerOverlayHotkey();
    return settings;
  });

  ipcMain.on("overlay-theme-updated", (event: unknown, rawVars: unknown) => {
    if (!isAuthorizedSender(assertMainRendererSender, event as never, "overlay-theme-updated")) {
      return;
    }

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

export {
  register,
  settingsController,
  onRelicRewardTrigger,
  onRelicSelectionTrigger,
  onRelicSelectionClose,
};

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
