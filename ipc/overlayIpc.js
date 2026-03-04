const log = require("../services/logger").withScope("overlayIpc");
/**
 * Overlay IPC handlers + settings management + global hotkeys.
 * Handles: overlay-close, overlay-get-relic-items, overlay:get-settings,
 *          overlay:set-settings, overlay:open-crop-debugger,
 *          overlay:apply-crop-selection, toggle-overlay, simulate-relic-trigger
 */

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

const OVERLAY_SETTINGS_FILE = path.join(app.getPath("userData"), "overlay-settings.json");
const OVERLAY_WINDOW_FILE = path.join(__dirname, "..", "renderer", "overlay.html");
const CROP_DEBUG_WINDOW_FILE = path.join(__dirname, "..", "renderer", "crop-debug.html");

const OVERLAY_WINDOW_BOUNDS = Object.freeze({
  width: 980,
  height: 220,
  horizontalMargin: 16,
  bottomMargin: 18,
  topMargin: 8,
  defaultYRatio: 0.47,
  anchorGapRatio: 0.018,
  anchorMinRatio: 0.22,
  anchorMaxRatio: 0.82,
});

const SCAN_RETRY_WINDOW_MS = 5_000;
const SCAN_RETRY_INTERVAL_MS = 450;
const SCAN_MAX_ATTEMPTS = 10;
const MAX_REWARD_ITEMS = 4;

const OVERLAY_AUTO_HIDE_SUCCESS_MS = 12_000;
const OVERLAY_AUTO_HIDE_FAILURE_MS = 3_500;
const OVERLAY_AUTO_HIDE_DETECTING_MAX_MS = 20_000;

const UI_READY_GATE_TIMEOUT_MS = 2_200;
const UI_READY_GATE_POLL_MS = 120;
const UI_READY_GATE_REQUIRED_HITS = 2;
const UI_READY_GATE_SCORE_THRESHOLD = 0.58;

let rewardScanInFlight = false;
let lastOverlayAnchorMeta = null;
let overlayAutoHideTimer = null;

function getElectronBuildFile(fileName) {
  return path.join(app.getAppPath(), ".electron-build", fileName);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHotkey(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return OVERLAY_SETTINGS_DEFAULTS.hotkey;
  if (!raw.includes("+")) return raw.toUpperCase();
  return raw
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const low = part.toLowerCase();
      if (low === "commandorcontrol") return "CommandOrControl";
      if (low === "command") return "Command";
      if (low === "control" || low === "ctrl") return "Control";
      if (low === "alt") return "Alt";
      if (low === "option") return "Option";
      if (low === "shift") return "Shift";
      if (low === "super") return "Super";
      return part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1);
    })
    .join("+");
}

function normalizeOcrEngine(value) {
  const engine = typeof value === "string" ? value.trim().toLowerCase() : "";
  return OVERLAY_OCR_ENGINES.includes(engine) ? engine : OVERLAY_SETTINGS_DEFAULTS.ocrEngine;
}

function normalizeCropRatios(topInput, heightInput) {
  const minTop = OVERLAY_SETTINGS_LIMITS.cropTopRatioMin;
  const maxTop = OVERLAY_SETTINGS_LIMITS.cropTopRatioMax;
  const minHeight = OVERLAY_SETTINGS_LIMITS.cropHeightRatioMin;
  const maxHeight = OVERLAY_SETTINGS_LIMITS.cropHeightRatioMax;

  let top = clampNumber(topInput, minTop, maxTop, OVERLAY_SETTINGS_DEFAULTS.cropTopRatio);
  let height = clampNumber(
    heightInput,
    minHeight,
    maxHeight,
    OVERLAY_SETTINGS_DEFAULTS.cropHeightRatio,
  );

  if (top + height > 1.0) {
    height = Math.max(minHeight, 1.0 - top);
  }
  if (top + height > 1.0) {
    top = Math.max(minTop, 1.0 - height);
  }

  return {
    top: Number(top.toFixed(4)),
    height: Number(height.toFixed(4)),
  };
}

function normalizeOverlaySettings(raw) {
  const candidate = raw && typeof raw === "object" ? raw : {};
  const cropPreset =
    typeof candidate.cropPreset === "string" ? candidate.cropPreset.trim().toLowerCase() : "";
  const validCropPreset = OVERLAY_CROP_PRESETS.includes(cropPreset)
    ? cropPreset
    : OVERLAY_SETTINGS_DEFAULTS.cropPreset;

  const cropRatios = normalizeCropRatios(candidate.cropTopRatio, candidate.cropHeightRatio);

  return {
    autoTriggerEnabled:
      candidate.autoTriggerEnabled !== undefined
        ? !!candidate.autoTriggerEnabled
        : OVERLAY_SETTINGS_DEFAULTS.autoTriggerEnabled,
    hotkeyEnabled:
      candidate.hotkeyEnabled !== undefined
        ? !!candidate.hotkeyEnabled
        : OVERLAY_SETTINGS_DEFAULTS.hotkeyEnabled,
    hotkey: normalizeHotkey(candidate.hotkey ?? OVERLAY_SETTINGS_DEFAULTS.hotkey),
    cropDebugHotkeyEnabled:
      candidate.cropDebugHotkeyEnabled !== undefined
        ? !!candidate.cropDebugHotkeyEnabled
        : OVERLAY_SETTINGS_DEFAULTS.cropDebugHotkeyEnabled,
    cropDebugHotkey: normalizeHotkey(
      candidate.cropDebugHotkey ?? OVERLAY_SETTINGS_DEFAULTS.cropDebugHotkey,
    ),
    cropPreset: validCropPreset,
    cropTopRatio: cropRatios.top,
    cropHeightRatio: cropRatios.height,
    ocrEngine: normalizeOcrEngine(candidate.ocrEngine),
    ocrPasses: Math.floor(
      clampNumber(
        candidate.ocrPasses,
        OVERLAY_SETTINGS_LIMITS.ocrPassesMin,
        OVERLAY_SETTINGS_LIMITS.ocrPassesMax,
        OVERLAY_SETTINGS_DEFAULTS.ocrPasses,
      ),
    ),
    matchThreshold: clampNumber(
      candidate.matchThreshold,
      OVERLAY_SETTINGS_LIMITS.matchThresholdMin,
      OVERLAY_SETTINGS_LIMITS.matchThresholdMax,
      OVERLAY_SETTINGS_DEFAULTS.matchThreshold,
    ),
    ocrTimeoutMs: Math.floor(
      clampNumber(
        candidate.ocrTimeoutMs,
        OVERLAY_SETTINGS_LIMITS.ocrTimeoutMsMin,
        OVERLAY_SETTINGS_LIMITS.ocrTimeoutMsMax,
        OVERLAY_SETTINGS_DEFAULTS.ocrTimeoutMs,
      ),
    ),
    worldNotificationsEnabled:
      candidate.worldNotificationsEnabled !== undefined
        ? !!candidate.worldNotificationsEnabled
        : OVERLAY_SETTINGS_DEFAULTS.worldNotificationsEnabled,
  };
}

function loadOverlaySettings() {
  try {
    if (fs.existsSync(OVERLAY_SETTINGS_FILE)) {
      const raw = fs.readFileSync(OVERLAY_SETTINGS_FILE, "utf8");
      const parsed = JSON.parse(raw);
      ctx.overlaySettings = normalizeOverlaySettings({ ...OVERLAY_SETTINGS_DEFAULTS, ...parsed });
    } else {
      ctx.overlaySettings = { ...OVERLAY_SETTINGS_DEFAULTS };
    }
  } catch (err) {
    log.warn("[OverlaySettings] Failed to load settings, using defaults:", err.message);
    ctx.overlaySettings = { ...OVERLAY_SETTINGS_DEFAULTS };
  }
  rewardScanner.setSettings(ctx.overlaySettings);
  return ctx.overlaySettings;
}

function saveOverlaySettings() {
  try {
    fs.writeFileSync(OVERLAY_SETTINGS_FILE, JSON.stringify(ctx.overlaySettings, null, 2), "utf8");
    return true;
  } catch (err) {
    log.error("[OverlaySettings] Failed to save settings:", err.message);
    return false;
  }
}

function unregisterOverlayTriggerHotkey() {
  if (!ctx.overlayHotkeyRegistered) return;
  try {
    globalShortcut.unregister(ctx.overlayHotkeyRegistered);
  } catch (err) {
    log.warn("[OverlayHotkey] unregister failed:", err.message);
  }
  ctx.overlayHotkeyRegistered = null;
}

function unregisterCropDebugHotkey() {
  if (!ctx.overlayCropHotkeyRegistered) return;
  try {
    globalShortcut.unregister(ctx.overlayCropHotkeyRegistered);
  } catch (err) {
    log.warn("[CropHotkey] unregister failed:", err.message);
  }
  ctx.overlayCropHotkeyRegistered = null;
}

function unregisterOverlayHotkey() {
  unregisterOverlayTriggerHotkey();
  unregisterCropDebugHotkey();
}

function registerOverlayTriggerHotkey() {
  unregisterOverlayTriggerHotkey();

  if (!ctx.overlaySettings.hotkeyEnabled) {
    log.log("[OverlayHotkey] disabled");
    return false;
  }

  const accelerator = ctx.overlaySettings.hotkey;
  if (!accelerator) return false;

  try {
    const ok = globalShortcut.register(accelerator, () => onRelicRewardTrigger("hotkey"));
    if (!ok) {
      log.warn("[OverlayHotkey] register failed:", accelerator);
      return false;
    }
    ctx.overlayHotkeyRegistered = accelerator;
    log.log("[OverlayHotkey] registered:", accelerator);
    return true;
  } catch (err) {
    log.warn("[OverlayHotkey] invalid shortcut:", accelerator, err.message);
    return false;
  }
}

async function openOcrCropDebugger(source = "manual") {
  const frame = await rewardScanner.captureDebugFrame();
  if (!frame) {
    const msg = "Could not capture Warframe screen for crop debug.";
    log.warn("[CropDebug] open failed:", msg);
    return { ok: false, error: msg };
  }

  createCropDebugWindow(frame);
  log.log(`[CropDebug] opened from ${source}`);
  return { ok: true, settings: { ...ctx.overlaySettings } };
}

function registerCropDebugHotkey() {
  unregisterCropDebugHotkey();

  if (!ctx.overlaySettings.cropDebugHotkeyEnabled) {
    log.log("[CropHotkey] disabled");
    return false;
  }

  const accelerator = ctx.overlaySettings.cropDebugHotkey;
  if (!accelerator) return false;

  try {
    const ok = globalShortcut.register(accelerator, () => {
      void openOcrCropDebugger("hotkey").catch((err) => {
        log.error("[CropHotkey] open debug failed:", err.message);
      });
    });
    if (!ok) {
      log.warn("[CropHotkey] register failed:", accelerator);
      return false;
    }
    ctx.overlayCropHotkeyRegistered = accelerator;
    log.log("[CropHotkey] registered:", accelerator);
    return true;
  } catch (err) {
    log.warn("[CropHotkey] invalid shortcut:", accelerator, err.message);
    return false;
  }
}

function registerOverlayHotkey() {
  const triggerOk = registerOverlayTriggerHotkey();
  const cropOk = registerCropDebugHotkey();
  return triggerOk || cropOk;
}

function findDisplayById(displayId) {
  if (!displayId) return null;
  const wanted = String(displayId);
  return screen.getAllDisplays().find((display) => String(display.id) === wanted) || null;
}

function getDisplayForOverlay(anchorMeta) {
  const metaDisplayId =
    anchorMeta && typeof anchorMeta === "object" ? anchorMeta.sourceDisplayId : null;

  const byMeta = findDisplayById(metaDisplayId);
  if (byMeta) return byMeta;

  try {
    const point = screen.getCursorScreenPoint();
    return screen.getDisplayNearestPoint(point);
  } catch {
    return screen.getPrimaryDisplay();
  }
}

function getAnchorRatio(anchorMeta) {
  if (!anchorMeta || typeof anchorMeta !== "object") {
    return OVERLAY_WINDOW_BOUNDS.defaultYRatio;
  }

  const bandBottom = Number(anchorMeta.bandBottomRatio);
  if (!Number.isFinite(bandBottom)) {
    return OVERLAY_WINDOW_BOUNDS.defaultYRatio;
  }

  const anchoredRatio = bandBottom + OVERLAY_WINDOW_BOUNDS.anchorGapRatio;
  return clampNumber(
    anchoredRatio,
    OVERLAY_WINDOW_BOUNDS.anchorMinRatio,
    OVERLAY_WINDOW_BOUNDS.anchorMaxRatio,
    OVERLAY_WINDOW_BOUNDS.defaultYRatio,
  );
}

function getOverlayBoundsForActiveDisplay(anchorMeta = lastOverlayAnchorMeta) {
  const display = getDisplayForOverlay(anchorMeta);
  const area = display?.workArea || {
    x: 0,
    y: 0,
    width: OVERLAY_WINDOW_BOUNDS.width,
    height: OVERLAY_WINDOW_BOUNDS.height,
  };

  const maxAllowedWidth = Math.max(760, area.width - OVERLAY_WINDOW_BOUNDS.horizontalMargin * 2);
  const width = Math.min(OVERLAY_WINDOW_BOUNDS.width, maxAllowedWidth);
  const height = Math.min(OVERLAY_WINDOW_BOUNDS.height, Math.max(160, area.height - 20));

  const x = Math.round(area.x + (area.width - width) / 2);
  const preferredY = Math.round(area.y + area.height * getAnchorRatio(anchorMeta));
  const maxY = area.y + area.height - height - OVERLAY_WINDOW_BOUNDS.bottomMargin;
  const minY = area.y + OVERLAY_WINDOW_BOUNDS.topMargin;
  const y = Math.max(minY, Math.min(maxY, preferredY));

  return { x, y, width, height };
}

function positionOverlayWindow(anchorMeta = lastOverlayAnchorMeta) {
  if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return;
  const bounds = getOverlayBoundsForActiveDisplay(anchorMeta);
  ctx.overlayWindow.setBounds(bounds, false);
}

function createOverlayWindow() {
  if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) {
    positionOverlayWindow(lastOverlayAnchorMeta);
    ctx.overlayWindow.show();
    ctx.overlayWindow.focus();
    return;
  }

  const initialBounds = getOverlayBoundsForActiveDisplay(lastOverlayAnchorMeta);

  ctx.overlayWindow = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,
    x: initialBounds.x,
    y: initialBounds.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      preload: getElectronBuildFile("preload-overlay.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  hardenBrowserWindowNavigation(ctx.overlayWindow, {
    label: "overlay window",
    allowedFilePaths: [OVERLAY_WINDOW_FILE],
    log,
  });

  ctx.overlayWindow.loadFile(OVERLAY_WINDOW_FILE);
  ctx.overlayWindow.setAlwaysOnTop(true, "screen-saver");
  positionOverlayWindow(lastOverlayAnchorMeta);
  ctx.overlayWindow.on("closed", () => {
    clearOverlayAutoHideTimer();
    ctx.overlayWindow = null;
  });
}

function createCropDebugWindow(frame) {
  if (ctx.cropDebugWindow && !ctx.cropDebugWindow.isDestroyed()) {
    ctx.cropDebugWindow.show();
    ctx.cropDebugWindow.focus();
    ctx.cropDebugWindow.webContents.send("crop-debug:init", {
      ...frame,
      cropTopRatio: ctx.overlaySettings.cropTopRatio,
      cropHeightRatio: ctx.overlaySettings.cropHeightRatio,
    });
    return;
  }

  ctx.cropDebugWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    title: "OCR Crop Debugger",
    backgroundColor: "#0b1320",
    webPreferences: {
      preload: getElectronBuildFile("preload-crop.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  hardenBrowserWindowNavigation(ctx.cropDebugWindow, {
    label: "crop debug window",
    allowedFilePaths: [CROP_DEBUG_WINDOW_FILE],
    log,
  });

  ctx.cropDebugWindow.loadFile(CROP_DEBUG_WINDOW_FILE);

  ctx.cropDebugWindow.webContents.once("did-finish-load", () => {
    if (ctx.cropDebugWindow && !ctx.cropDebugWindow.isDestroyed()) {
      ctx.cropDebugWindow.webContents.send("crop-debug:init", {
        ...frame,
        cropTopRatio: ctx.overlaySettings.cropTopRatio,
        cropHeightRatio: ctx.overlaySettings.cropHeightRatio,
      });
    }
  });

  ctx.cropDebugWindow.on("closed", () => {
    ctx.cropDebugWindow = null;
  });
}

function clearOverlayAutoHideTimer() {
  if (!overlayAutoHideTimer) return;
  clearTimeout(overlayAutoHideTimer);
  overlayAutoHideTimer = null;
}

function scheduleOverlayAutoHide(delayMs) {
  clearOverlayAutoHideTimer();

  const delay = Math.max(250, Math.floor(Number(delayMs) || 0));
  if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return;

  overlayAutoHideTimer = setTimeout(() => {
    overlayAutoHideTimer = null;
    if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return;
    if (ctx.overlayWindow.isVisible()) {
      ctx.overlayWindow.hide();
    }
  }, delay);
}

function sendOverlayEvent(channel, payload) {
  if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return;

  const targetWindow = ctx.overlayWindow;
  const sendNow = () => {
    if (!targetWindow || targetWindow.isDestroyed()) return;
    targetWindow.webContents.send(channel, payload);
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", sendNow);
    return;
  }

  sendNow();
}

function chooseBetterScanResult(currentBest, candidate) {
  if (!candidate) return currentBest;
  if (!currentBest) return candidate;

  const currentCount = Array.isArray(currentBest.items) ? currentBest.items.length : 0;
  const candidateCount = Array.isArray(candidate.items) ? candidate.items.length : 0;
  if (candidateCount !== currentCount) {
    return candidateCount > currentCount ? candidate : currentBest;
  }

  const currentScore = Number(currentBest.meta?.score || 0);
  const candidateScore = Number(candidate.meta?.score || 0);
  return candidateScore > currentScore ? candidate : currentBest;
}

async function runRewardScanWithRetries(triggerSource) {
  const startedAt = Date.now();
  let attempts = 0;
  let bestResult = null;

  while (attempts < SCAN_MAX_ATTEMPTS && Date.now() - startedAt < SCAN_RETRY_WINDOW_MS) {
    attempts += 1;

    let result;
    try {
      result = await rewardScanner.scanRewardsDetailed();
    } catch (err) {
      log.error(`[Trigger] scan attempt ${attempts} failed:`, err.message);
    }

    bestResult = chooseBetterScanResult(bestResult, result);

    const itemCount = Array.isArray(result?.items) ? result.items.length : 0;
    if (itemCount > 0) {
      return {
        ...result,
        attempts,
        elapsedMs: Date.now() - startedAt,
        timedOut: false,
      };
    }

    const elapsed = Date.now() - startedAt;
    const remaining = SCAN_RETRY_WINDOW_MS - elapsed;
    if (remaining <= 0 || attempts >= SCAN_MAX_ATTEMPTS) {
      break;
    }

    await sleep(Math.min(SCAN_RETRY_INTERVAL_MS, remaining));
  }

  const fallback = bestResult || { items: [], meta: null };
  return {
    ...fallback,
    attempts,
    elapsedMs: Date.now() - startedAt,
    timedOut: true,
    triggerSource,
  };
}

async function dispatchRewardScan(source) {
  if (rewardScanInFlight) {
    log.log(`[Trigger] scan already running, ignored duplicate trigger (${source})`);
    return;
  }

  rewardScanInFlight = true;

  try {
    if (typeof rewardScanner.waitForRewardUiReady === "function") {
      const gate = await rewardScanner.waitForRewardUiReady({
        timeoutMs: UI_READY_GATE_TIMEOUT_MS,
        pollMs: UI_READY_GATE_POLL_MS,
        requiredHits: UI_READY_GATE_REQUIRED_HITS,
        scoreThreshold: UI_READY_GATE_SCORE_THRESHOLD,
      });

      if (gate?.best && Number.isFinite(gate.best.bandBottomRatio)) {
        lastOverlayAnchorMeta = {
          sourceDisplayId: gate.best.sourceDisplayId || null,
          bandBottomRatio: gate.best.bandBottomRatio,
        };
        positionOverlayWindow(lastOverlayAnchorMeta);
      }

      if (gate?.ready) {
        log.log(
          "[Trigger] UI-ready gate passed in " +
            gate.elapsedMs +
            "ms (" +
            gate.attempts +
            " samples, score " +
            Number(gate.best?.score || 0).toFixed(3) +
            ")",
        );
      } else {
        log.log(
          "[Trigger] UI-ready gate timed out after " +
            (gate?.elapsedMs ?? 0) +
            "ms; continuing scan pipeline (best score " +
            Number(gate?.best?.score || 0).toFixed(3) +
            ")",
        );
      }
    }

    const result = await runRewardScanWithRetries(source);
    const items = Array.isArray(result?.items) ? result.items.slice(0, MAX_REWARD_ITEMS) : [];

    if (result?.meta) {
      lastOverlayAnchorMeta = result.meta;
      positionOverlayWindow(lastOverlayAnchorMeta);
    }

    if (items.length === 0 && result?.timedOut) {
      log.warn(
        `[Trigger] no reward items found after ${result.attempts} attempt(s) in ${result.elapsedMs}ms`,
      );
    } else {
      log.log(
        `[Trigger] reward scan resolved in ${result.elapsedMs}ms after ${result.attempts} attempt(s); ` +
          `${items.length} item(s)`,
      );
    }

    sendOverlayEvent("relic-reward-items", items);
    scheduleOverlayAutoHide(
      items.length > 0 ? OVERLAY_AUTO_HIDE_SUCCESS_MS : OVERLAY_AUTO_HIDE_FAILURE_MS,
    );
  } catch (err) {
    log.error("[Trigger] scan pipeline error:", err.message);
    sendOverlayEvent("relic-reward-items", []);
    scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_FAILURE_MS);
  } finally {
    rewardScanInFlight = false;
  }
}

function onRelicRewardTrigger(source = "manual") {
  if (source === "eelog" && !ctx.overlaySettings.autoTriggerEnabled) return;

  clearOverlayAutoHideTimer();
  createOverlayWindow();
  if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return;

  positionOverlayWindow(lastOverlayAnchorMeta);
  sendOverlayEvent("relic-reward-trigger");
  scheduleOverlayAutoHide(OVERLAY_AUTO_HIDE_DETECTING_MAX_MS);

  void dispatchRewardScan(source);
}

function applyCropSelection(selection) {
  const cropTopRatio =
    selection && typeof selection === "object" ? selection.cropTopRatio : undefined;
  const cropHeightRatio =
    selection && typeof selection === "object" ? selection.cropHeightRatio : undefined;
  const crop = normalizeCropRatios(cropTopRatio, cropHeightRatio);

  ctx.overlaySettings = normalizeOverlaySettings({
    ...ctx.overlaySettings,
    cropPreset: "custom",
    cropTopRatio: crop.top,
    cropHeightRatio: crop.height,
  });

  rewardScanner.setSettings(ctx.overlaySettings);
  saveOverlaySettings();

  if (ctx.cropDebugWindow && !ctx.cropDebugWindow.isDestroyed()) {
    ctx.cropDebugWindow.webContents.send("crop-debug:applied", {
      cropTopRatio: ctx.overlaySettings.cropTopRatio,
      cropHeightRatio: ctx.overlaySettings.cropHeightRatio,
    });
  }

  return { ...ctx.overlaySettings };
}

function register() {
  ipcMain.on("overlay-close", (event) => {
    if (!isAuthorizedSender(assertOverlayRendererSender, event, "overlay-close")) return;
    clearOverlayAutoHideTimer();
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

    ctx.overlaySettings = normalizeOverlaySettings({
      ...ctx.overlaySettings,
      ...(nextSettings && typeof nextSettings === "object" ? nextSettings : {}),
    });
    rewardScanner.setSettings(ctx.overlaySettings);
    saveOverlaySettings();
    registerOverlayHotkey();
    return { ...ctx.overlaySettings };
  });

  ipcMain.handle("overlay:open-crop-debugger", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "overlay:open-crop-debugger");
    return openOcrCropDebugger("ipc");
  });

  ipcMain.handle("overlay:apply-crop-selection", async (event, selection) => {
    assertAuthorizedSender(assertCropDebugRendererSender, event, "overlay:apply-crop-selection");

    try {
      const settings = applyCropSelection(selection);
      return { ok: true, settings };
    } catch (err) {
      log.error("[CropDebug] apply selection failed:", err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on("toggle-overlay", (event) => {
    if (!isAuthorizedSender(assertMainRendererSender, event, "toggle-overlay")) return;

    clearOverlayAutoHideTimer();
    if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) {
      createOverlayWindow();
    } else if (ctx.overlayWindow.isVisible()) {
      ctx.overlayWindow.hide();
    } else {
      positionOverlayWindow(lastOverlayAnchorMeta);
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
  loadOverlaySettings,
  registerOverlayHotkey,
  unregisterOverlayHotkey,
  onRelicRewardTrigger,
  openOcrCropDebugger,
};
