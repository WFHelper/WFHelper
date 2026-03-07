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

export {};

const requireRuntime = createRuntimeRequire(__dirname, 1);

const log = requireRuntime<{
  withScope: (scope: string) => {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}>("services/logger").withScope("overlayIpc");

const { normalizeErrorMessage } = requireRuntime<{
  normalizeErrorMessage: (err: unknown, fallback?: string) => string;
}>("config/shared/errors.cjs");

const { ipcMain, BrowserWindow, globalShortcut, app, screen } =
  require("electron") as typeof import("electron");
const path = require("node:path") as typeof import("node:path");
const fs = require("node:fs") as typeof import("node:fs");
const relicService = requireRuntime<{
  getRelicDatabase: () => {
    groups: Record<
      string,
      {
        key: string;
        name: string;
        tier?: string;
        qualities?: Record<
          string,
          { rewards?: Array<{ name?: string; urlName?: string; rarity?: string }> } | undefined
        >;
      }
    >;
    byUniqueName: Record<
      string,
      { groupKey: string; quality: "intact" | "exceptional" | "flawless" | "radiant" }
    >;
  };
}>("services/relicService");
const rewardScanner = requireRuntime<{
  captureDebugFrame: () => Promise<Record<string, unknown> | null>;
  captureSourceMeta?: () => Promise<{
    sourceType?: string | null;
    sourceName?: string | null;
    sourceId?: string | null;
    sourceDisplayId?: string | null;
  } | null>;
  setSettings: (settings: Record<string, unknown>) => void;
  scanRewardsDetailed: () => Promise<{ items?: unknown[]; meta?: Record<string, unknown> | null }>;
  detectRelicSelectionEra?: (options?: { timeoutMs?: number }) => Promise<{
    era?: string | null;
    confidence?: number;
    textPreview?: string;
    elapsedMs?: number;
    sourceType?: string | null;
    sourceDisplayId?: string | null;
    candidateId?: string | null;
  }>;
  waitForRewardUiReady?: (options: {
    timeoutMs: number;
    pollMs: number;
    requiredHits: number;
    scoreThreshold: number;
  }) => Promise<
    | {
        ready?: boolean;
        elapsedMs?: number;
        attempts?: number;
        best?: {
          sourceDisplayId?: string | null;
          bandBottomRatio?: number;
          score?: number;
        };
      }
    | undefined
  >;
}>("services/rewardScanner");
const wfmStatsPrice = requireRuntime<{
  fetchPriceBySlug: (slug: string, options?: { timeoutMs?: number }) => Promise<number | null>;
  getCachedPriceBySlug?: (slug: string) => number | null;
}>("services/wfmStatsPrice");
const warframeStatus = requireRuntime<{
  getStatus: (options?: { force?: boolean }) => Promise<{
    isOpen: boolean;
    isFocused: boolean;
    focusedProcessName?: string | null;
  }>;
}>("services/warframeStatus");
const { hardenBrowserWindowNavigation } = requireRuntime<{
  hardenBrowserWindowNavigation: (
    browserWindow: import("electron").BrowserWindow,
    options: {
      label: string;
      allowedFilePaths: string[];
      log: { warn: (...args: unknown[]) => void };
    },
  ) => void;
}>("services/windowSecurity");
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
const CROP_DEBUG_WINDOW_FILE = path.join(APP_ROOT, "renderer", "crop-debug.html");

const windowsController = createOverlayWindowsController({
  app,
  BrowserWindow,
  screen,
  ctx,
  log,
  hardenBrowserWindowNavigation,
  overlayWindowFile: OVERLAY_WINDOW_FILE,
  cropDebugWindowFile: CROP_DEBUG_WINDOW_FILE,
});

let scanController = createOverlayScanController({
  log,
  rewardScanner,
  ctx,
  windows: windowsController,
  warframeStatus,
});

async function openOcrCropDebugger(source = "manual") {
  const frame = await rewardScanner.captureDebugFrame();
  if (!frame) {
    const msg = "Could not capture Warframe screen for crop debug.";
    log.warn("[CropDebug] open failed:", msg);
    return { ok: false, error: msg };
  }

  windowsController.createCropDebugWindow(frame);
  log.log(`[CropDebug] opened from ${source}`);
  return { ok: true, settings: { ...ctx.overlaySettings } };
}

const OVERLAY_THEME_VAR_ALLOWLIST = new Set([
  "--bg-deep",
  "--bg-base",
  "--bg-surface",
  "--bg-raised",
  "--accent",
  "--accent-dim",
  "--accent-bright",
  "--accent-glow",
  "--text-primary",
  "--text-secondary",
  "--text-muted",
  "--border",
  "--border-strong",
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
  windowsController.sendOverlayEvent("overlay-theme-vars", { ...ctx.overlayThemeVars });
}

function onRelicRewardTrigger(source = "manual") {
  pushOverlayThemeVars();
  scanController.onRelicRewardTrigger(source);
}

function onRelicSelectionTrigger(source = "manual") {
  pushOverlayThemeVars();
  void relicSelectionController.onRelicSelectionTrigger(source);
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
  onOpenCropDebugger: openOcrCropDebugger,
});

scanController = createOverlayScanController({
  log,
  rewardScanner,
  ctx,
  windows: windowsController,
  warframeStatus,
});

const relicSelectionController = createRelicSelectionController({
  log,
  ctx,
  windows: windowsController,
  relicService,
  rewardScanner,
  wfmStatsPrice,
  warframeStatus,
  fs,
  cacheFilePath: PRICE_CACHE_FILE,
});

function register(): void {
  ipcMain.on("overlay-close", (event: unknown) => {
    if (!isAuthorizedSender(assertOverlayRendererSender, event as never, "overlay-close")) return;
    windowsController.clearOverlayAutoHideTimer();
    if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) ctx.overlayWindow.hide();
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

    windowsController.clearOverlayAutoHideTimer();
    if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) {
      windowsController.createOverlayWindow();
      pushOverlayThemeVars();
    } else if (ctx.overlayWindow.isVisible()) {
      ctx.overlayWindow.hide();
    } else {
      windowsController.positionOverlayWindow(windowsController.getAnchorMeta());
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

export {
  register,
  settingsController,
  onRelicRewardTrigger,
  onRelicSelectionTrigger,
  openOcrCropDebugger,
};

module.exports = {
  register,
  loadOverlaySettings: settingsController.loadOverlaySettings,
  registerOverlayHotkey: settingsController.registerOverlayHotkey,
  unregisterOverlayHotkey: settingsController.unregisterOverlayHotkey,
  onRelicRewardTrigger,
  onRelicSelectionTrigger,
  openOcrCropDebugger,
};
