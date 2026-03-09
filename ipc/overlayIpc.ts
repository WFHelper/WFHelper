import ctx from "./context";
import {
  assertAuthorizedSender,
  assertCropDebugRendererSender,
  assertMainRendererSender,
  assertOverlayRendererSender,
  isAuthorizedSender,
} from "./ipcSecurity";
import { createOverlayScanController } from "./overlay/scan";
import { createRelicSelectionController } from "./overlay/relicSelection";
import { createOverlaySettingsController } from "./overlay/settings";
import { createOverlayWindowsController } from "./overlay/windows";
import { createRuntimeRequire } from "./runtimeRequire";
import { withScope } from "../services/logger";
import * as relicService from "../services/relicService";
import * as rewardScanner from "../services/rewardScanner";
import * as wfmStatsPrice from "../services/wfmStatsPrice";
import * as warframeStatus from "../services/warframeStatus";
import { hardenBrowserWindowNavigation } from "../services/windowSecurity";
import { startEscMonitor, stopEscMonitor } from "../services/keyboardMonitor";


const requireRuntime = createRuntimeRequire(__dirname, 1);

const log = withScope("overlayIpc");

const { normalizeErrorMessage } = requireRuntime<{
  normalizeErrorMessage: (err: unknown, fallback?: string) => string;
}>("config/shared/errors.cjs");

const { ipcMain, BrowserWindow, globalShortcut, app, screen } =
  require("electron") as typeof import("electron");
const path = require("node:path") as typeof import("node:path");
const fs = require("node:fs") as typeof import("node:fs");
const {
  OVERLAY_CROP_PRESETS,
  OVERLAY_OCR_ENGINES,
  OVERLAY_SETTINGS_DEFAULTS,
  OVERLAY_SETTINGS_LIMITS,
} = requireRuntime<{
  OVERLAY_CROP_PRESETS: string[];
  OVERLAY_OCR_ENGINES: string[];
  OVERLAY_SETTINGS_DEFAULTS: Record<string, any>;
  OVERLAY_SETTINGS_LIMITS: Record<string, number>;
}>("config/runtime/overlaySettings");

const OVERLAY_SETTINGS_FILE = path.join(app.getPath("userData"), "overlay-settings.json");
const PRICE_CACHE_FILE = path.join(app.getPath("userData"), "price-cache.json");
const APP_ROOT = app.getAppPath();
const OVERLAY_WINDOW_FILE = path.join(APP_ROOT, "renderer", "overlay.html");
const PLANNER_WINDOW_FILE = path.join(APP_ROOT, "renderer", "overlay.html");
const CROP_DEBUG_WINDOW_FILE = path.join(APP_ROOT, "renderer", "crop-debug.html");

const rewardWindowsController = createOverlayWindowsController({
  app,
  BrowserWindow,
  screen,
  ctx,
  log,
  hardenBrowserWindowNavigation,
  overlayWindowFile: OVERLAY_WINDOW_FILE,
  cropDebugWindowFile: CROP_DEBUG_WINDOW_FILE,
});

const plannerWindowsController = createOverlayWindowsController({
  app,
  BrowserWindow,
  screen,
  ctx,
  getOverlayWindow: () => ctx.plannerOverlayWindow,
  setOverlayWindow: (window) => {
    ctx.plannerOverlayWindow = window;
  },
  getOverlayInteractiveMode: () => ctx.overlayInteractiveMode,
  setOverlayInteractiveModeState: (enabled) => {
    ctx.overlayInteractiveMode = !!enabled;
  },
  log,
  hardenBrowserWindowNavigation,
  overlayWindowFile: PLANNER_WINDOW_FILE,
  cropDebugWindowFile: CROP_DEBUG_WINDOW_FILE,
  placement: "top-right",
  windowWidth: 460,
  windowHeight: 320,
});

function pushOverlayInteractionMode(): void {
  const payload = {
    interactive: !!ctx.overlayInteractiveMode,
  };
  rewardWindowsController.sendOverlayEvent("overlay-interaction-mode", payload);
  plannerWindowsController.sendOverlayEvent("overlay-interaction-mode", payload);
}

async function bringOverlayToWarframeDisplayIfAvailable(): Promise<void> {
  try {
    const status = await warframeStatus.getStatus({ force: true });
    if (status?.focusedDisplayId) {
      const anchor = { sourceDisplayId: String(status.focusedDisplayId) };
      rewardWindowsController.setAnchorMeta(anchor);
      plannerWindowsController.setAnchorMeta(anchor);
      rewardWindowsController.positionOverlayWindow(rewardWindowsController.getAnchorMeta());
      plannerWindowsController.positionOverlayWindow(plannerWindowsController.getAnchorMeta());
    }
  } catch {
    // best effort
  }
}

function setOverlayInteractionMode(enabled: boolean, source = "unknown"): void {
  const next = !!enabled;
  const rewardExists = !!(ctx.overlayWindow && !ctx.overlayWindow.isDestroyed());
  const plannerExists = !!(ctx.plannerOverlayWindow && !ctx.plannerOverlayWindow.isDestroyed());
  if (ctx.overlayInteractiveMode === next && (rewardExists || plannerExists)) {
    if (rewardExists) rewardWindowsController.setOverlayInteractiveMode(next);
    if (plannerExists) plannerWindowsController.setOverlayInteractiveMode(next);
    pushOverlayInteractionMode();
    return;
  }

  ctx.overlayInteractiveMode = next;
  if (rewardExists) rewardWindowsController.setOverlayInteractiveMode(next);
  if (plannerExists) plannerWindowsController.setOverlayInteractiveMode(next);
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

  // Only consider a window "active" if it is currently visible.
  const activeWindow =
    plannerWindow && plannerWindow.isVisible()
      ? plannerWindow
      : rewardWindow && rewardWindow.isVisible()
        ? rewardWindow
        : null;

  if (!activeWindow) {
    // Nothing is visible — do nothing. This prevents the reward overlay from
    // appearing unexpectedly when Ctrl+Tab is pressed after closing the planner.
    return;
  }

  setOverlayInteractionMode(!ctx.overlayInteractiveMode, source);
}

function ensureOverlayWindowPrimed(): void {
  rewardWindowsController.createOverlayWindow({ show: false });
  plannerWindowsController.createOverlayWindow({ show: false });
  rewardWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
  plannerWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
  pushOverlayInteractionMode();
  pushOverlayThemeVars();
}

let scanController = createOverlayScanController({
  log,
  rewardScanner,
  ctx,
  windows: rewardWindowsController,
  warframeStatus,
});

async function openOcrCropDebugger(source = "manual") {
  const frame = await rewardScanner.captureDebugFrame();
  if (!frame) {
    const msg = "Could not capture Warframe screen for crop debug.";
    log.warn("[CropDebug] open failed:", msg);
    return { ok: false, error: msg };
  }

  rewardWindowsController.createCropDebugWindow(frame);
  log.log(`[CropDebug] opened from ${source}`);
  return { ok: true, settings: { ...ctx.overlaySettings } };
}

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

function pushOverlayThemeVars() {
  if (!ctx.overlayThemeVars || Object.keys(ctx.overlayThemeVars).length === 0) return;
  const vars = { ...ctx.overlayThemeVars };
  rewardWindowsController.sendOverlayEvent("overlay-theme-vars", vars);
  plannerWindowsController.sendOverlayEvent("overlay-theme-vars", vars);
}

function onRelicRewardTrigger(source = "manual") {
  log.log(`[OverlayRoute] trigger=reward source=${source}`);
  void bringOverlayToWarframeDisplayIfAvailable();
  rewardWindowsController.createOverlayWindow();
  rewardWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
  pushOverlayInteractionMode();
  pushOverlayThemeVars();
  scanController.onRelicRewardTrigger(source);
}

function onRelicSelectionTrigger(source: string) {
  log.log(`[OverlayRoute] trigger=planner source=${source}`);
  void bringOverlayToWarframeDisplayIfAvailable();
  plannerWindowsController.createOverlayWindow();
  plannerWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
  pushOverlayInteractionMode();
  pushOverlayThemeVars();
  void relicSelectionController.onRelicSelectionTrigger(source);
  startEscMonitor(onRelicSelectionClose);
}

const settingsController = createOverlaySettingsController({
  log,
  fs,
  globalShortcut,
  ctx,
  settingsFile: OVERLAY_SETTINGS_FILE,
  defaults: OVERLAY_SETTINGS_DEFAULTS,
  limits: OVERLAY_SETTINGS_LIMITS,
  cropPresets: OVERLAY_CROP_PRESETS,
  ocrEngines: OVERLAY_OCR_ENGINES,
  rewardScanner,
  onRelicRewardTrigger,
  onToggleOverlayInteractionMode: toggleOverlayInteractionMode,
  onOpenCropDebugger: openOcrCropDebugger,
});

scanController = createOverlayScanController({
  log,
  rewardScanner,
  ctx,
  windows: rewardWindowsController,
  warframeStatus,
});

const relicSelectionController = createRelicSelectionController({
  log,
  ctx,
  windows: plannerWindowsController,
  relicService,
  rewardScanner,
  wfmStatsPrice,
  warframeStatus,
  fs,
  cacheFilePath: PRICE_CACHE_FILE,
});

function onRelicSelectionClose(): void {
  stopEscMonitor();
  const win = ctx.plannerOverlayWindow;
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  // Do NOT call suppressReopenForClose here — the EE.log-based close fires for
  // dialog navigation (including entering the relic selection area), so suppressing
  // reopen would block the overlay on the very next PopulateInventoryGrid event.
  // suppressReopenForClose is reserved for explicit user close (the X button / overlay-close IPC).
  plannerWindowsController.clearOverlayAutoHideTimer();
  ctx.overlayInteractiveMode = false;
  pushOverlayInteractionMode();
  win.hide();
  log.log("[OverlayClose] planner closed via ESC / Dialog::SendResult");
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

  ipcMain.on("overlay-close", (event: unknown) => {
    if (!isAuthorizedSender(assertOverlayRendererSender, event as never, "overlay-close")) return;
    stopEscMonitor();
    rewardWindowsController.clearOverlayAutoHideTimer();
    plannerWindowsController.clearOverlayAutoHideTimer();
    relicSelectionController.suppressReopenForClose?.();

    // Reset interactive mode so the next trigger opens the overlay in passive mode.
    ctx.overlayInteractiveMode = false;
    pushOverlayInteractionMode();

    const senderId = Number((event as { sender?: { id?: number } } | null)?.sender?.id || 0);
    if (
      ctx.plannerOverlayWindow &&
      !ctx.plannerOverlayWindow.isDestroyed() &&
      senderId === ctx.plannerOverlayWindow.webContents.id
    ) {
      ctx.plannerOverlayWindow.hide();
      return;
    }

    if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) {
      ctx.overlayWindow.hide();
    }
  });

  ipcMain.on("crop-debug-close", (event: unknown) => {
    if (!isAuthorizedSender(assertCropDebugRendererSender, event as never, "crop-debug-close")) {
      return;
    }
    if (ctx.cropDebugWindow && !ctx.cropDebugWindow.isDestroyed()) {
      ctx.cropDebugWindow.close();
    }
  });

  ipcMain.handle("overlay-get-relic-items", async (event: unknown) => {
    assertAuthorizedSender(assertOverlayRendererSender, event as never, "overlay-get-relic-items");

    const db = relicService.getRelicDatabase();
    const seen = new Map<string, { name: string; urlName: string | null; rarity: string }>();
    for (const group of Object.values(db.groups)) {
      if (!group.qualities) continue;
      for (const qualData of Object.values(group.qualities)) {
        if (!qualData?.rewards) continue;
        for (const reward of qualData.rewards) {
          if (reward.name && !seen.has(reward.name)) {
            seen.set(reward.name, {
              name: reward.name,
              urlName: reward.urlName || null,
              rarity: reward.rarity || "Common",
            });
          }
        }
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  ipcMain.handle("overlay:get-settings", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "overlay:get-settings");
    return { ...ctx.overlaySettings };
  });

  ipcMain.handle("overlay:get-price", async (event: unknown, slug: string) => {
    assertAuthorizedSender(assertOverlayRendererSender, event as never, "overlay:get-price");
    return wfmStatsPrice.fetchPriceBySlug(slug);
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

  ipcMain.handle("overlay:open-crop-debugger", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "overlay:open-crop-debugger");
    return openOcrCropDebugger("ipc");
  });

  ipcMain.handle("overlay:apply-crop-selection", async (event: unknown, selection: unknown) => {
    assertAuthorizedSender(
      assertCropDebugRendererSender,
      event as never,
      "overlay:apply-crop-selection",
    );

    try {
      const settings = settingsController.applyCropSelection(selection);
      return { ok: true, settings };
    } catch (err) {
      log.error("[CropDebug] apply selection failed:", normalizeErrorMessage(err));
      return {
        ok: false,
        error: normalizeErrorMessage(err),
      };
    }
  });

  ipcMain.on("toggle-overlay", (event: unknown) => {
    if (!isAuthorizedSender(assertMainRendererSender, event as never, "toggle-overlay")) return;

    rewardWindowsController.clearOverlayAutoHideTimer();
    if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) {
      rewardWindowsController.createOverlayWindow();
      rewardWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
      pushOverlayInteractionMode();
      pushOverlayThemeVars();
    } else if (ctx.overlayWindow.isVisible()) {
      ctx.overlayWindow.hide();
    } else {
      rewardWindowsController.positionOverlayWindow(rewardWindowsController.getAnchorMeta());
      rewardWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
      pushOverlayInteractionMode();
      pushOverlayThemeVars();
      ctx.overlayWindow.showInactive();
    }
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

  ipcMain.on("simulate-relic-trigger", (event: unknown) => {
    if (!isAuthorizedSender(assertMainRendererSender, event as never, "simulate-relic-trigger")) {
      return;
    }
    onRelicRewardTrigger("simulate");
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
  openOcrCropDebugger,
};
