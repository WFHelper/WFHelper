const log = require("../services/logger").withScope("overlayIpc");

const { ipcMain, BrowserWindow, globalShortcut, app, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const relicService = require("../services/relicService");
const rewardScanner = require("../services/rewardScanner");
const wfmStatsPrice = require("../services/wfmStatsPrice");
const { hardenBrowserWindowNavigation } = require("../services/windowSecurity");
const ctx = require("./context");
const {
  assertMainRendererSender,
  assertOverlayRendererSender,
  assertCropDebugRendererSender,
  assertAuthorizedSender,
  isAuthorizedSender,
} = require("./ipcSecurity");
const {
  OVERLAY_CROP_PRESETS,
  OVERLAY_OCR_ENGINES,
  OVERLAY_SETTINGS_DEFAULTS,
  OVERLAY_SETTINGS_LIMITS,
} = require("../config/runtime/overlaySettings");
const { createOverlaySettingsController } = require("./overlay/settings");
const { createOverlayWindowsController } = require("./overlay/windows");
const { createOverlayScanController } = require("./overlay/scan");

const OVERLAY_SETTINGS_FILE = path.join(app.getPath("userData"), "overlay-settings.json");
const OVERLAY_WINDOW_FILE = path.join(__dirname, "..", "renderer", "overlay.html");
const CROP_DEBUG_WINDOW_FILE = path.join(__dirname, "..", "renderer", "crop-debug.html");

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

let scanController;

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

function onRelicRewardTrigger(source = "manual") {
  scanController.onRelicRewardTrigger(source);
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
});

function register() {
  ipcMain.on("overlay-close", (event) => {
    if (!isAuthorizedSender(assertOverlayRendererSender, event, "overlay-close")) return;
    windowsController.clearOverlayAutoHideTimer();
    if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) ctx.overlayWindow.hide();
  });

  ipcMain.on("crop-debug-close", (event) => {
    if (!isAuthorizedSender(assertCropDebugRendererSender, event, "crop-debug-close")) return;
    if (ctx.cropDebugWindow && !ctx.cropDebugWindow.isDestroyed()) {
      ctx.cropDebugWindow.close();
    }
  });

  ipcMain.handle("overlay-get-relic-items", async (event) => {
    assertAuthorizedSender(assertOverlayRendererSender, event, "overlay-get-relic-items");

    const db = relicService.getRelicDatabase();
    const seen = new Map();
    for (const group of Object.values(db.groups)) {
      for (const qualData of Object.values(group.qualities)) {
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

  ipcMain.handle("overlay:get-settings", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "overlay:get-settings");
    return { ...ctx.overlaySettings };
  });

  ipcMain.handle("overlay:get-price", async (event, slug) => {
    assertAuthorizedSender(assertOverlayRendererSender, event, "overlay:get-price");
    return wfmStatsPrice.fetchPriceBySlug(slug);
  });

  ipcMain.handle("overlay:set-settings", async (event, nextSettings) => {
    assertAuthorizedSender(assertMainRendererSender, event, "overlay:set-settings");

    const settings = settingsController.setOverlaySettings(nextSettings);
    settingsController.registerOverlayHotkey();
    return settings;
  });

  ipcMain.handle("overlay:open-crop-debugger", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "overlay:open-crop-debugger");
    return openOcrCropDebugger("ipc");
  });

  ipcMain.handle("overlay:apply-crop-selection", async (event, selection) => {
    assertAuthorizedSender(assertCropDebugRendererSender, event, "overlay:apply-crop-selection");

    try {
      const settings = settingsController.applyCropSelection(selection);
      return { ok: true, settings };
    } catch (err) {
      log.error("[CropDebug] apply selection failed:", err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on("toggle-overlay", (event) => {
    if (!isAuthorizedSender(assertMainRendererSender, event, "toggle-overlay")) return;

    windowsController.clearOverlayAutoHideTimer();
    if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) {
      windowsController.createOverlayWindow();
    } else if (ctx.overlayWindow.isVisible()) {
      ctx.overlayWindow.hide();
    } else {
      windowsController.positionOverlayWindow(windowsController.getAnchorMeta());
      ctx.overlayWindow.show();
      ctx.overlayWindow.focus();
    }
  });

  ipcMain.on("simulate-relic-trigger", (event) => {
    if (!isAuthorizedSender(assertMainRendererSender, event, "simulate-relic-trigger")) return;
    onRelicRewardTrigger("simulate");
  });
}

module.exports = {
  register,
  loadOverlaySettings: settingsController.loadOverlaySettings,
  registerOverlayHotkey: settingsController.registerOverlayHotkey,
  unregisterOverlayHotkey: settingsController.unregisterOverlayHotkey,
  onRelicRewardTrigger,
  openOcrCropDebugger,
};
