const log = require('../services/logger').withScope('overlayIpc');
/**
 * Overlay IPC handlers + settings management + global hotkeys.
 * Handles: overlay-close, overlay-get-relic-items, overlay:get-settings,
 *          overlay:set-settings, overlay:open-crop-debugger,
 *          overlay:apply-crop-selection, toggle-overlay, simulate-relic-trigger
 */

const { ipcMain, BrowserWindow, globalShortcut, app } = require('electron');
const path = require('path');
const fs = require('fs');
const relicService = require('../services/relicService');
const rewardScanner = require('../services/rewardScanner');
const ctx = require('./context');
const {
  OVERLAY_CROP_PRESETS,
  OVERLAY_OCR_ENGINES,
  OVERLAY_SETTINGS_DEFAULTS,
  OVERLAY_SETTINGS_LIMITS,
} = require('../config/runtime/overlaySettings');

const OVERLAY_SETTINGS_FILE = path.join(app.getPath('userData'), 'overlay-settings.json');

function getElectronBuildFile(fileName) {
  return path.join(app.getAppPath(), '.electron-build', fileName);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeHotkey(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return OVERLAY_SETTINGS_DEFAULTS.hotkey;
  if (!raw.includes('+')) return raw.toUpperCase();
  return raw
    .split('+')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const low = part.toLowerCase();
      if (low === 'commandorcontrol') return 'CommandOrControl';
      if (low === 'command') return 'Command';
      if (low === 'control' || low === 'ctrl') return 'Control';
      if (low === 'alt') return 'Alt';
      if (low === 'option') return 'Option';
      if (low === 'shift') return 'Shift';
      if (low === 'super') return 'Super';
      return part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1);
    })
    .join('+');
}

function normalizeOcrEngine(value) {
  const engine = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return OVERLAY_OCR_ENGINES.includes(engine)
    ? engine
    : OVERLAY_SETTINGS_DEFAULTS.ocrEngine;
}

function normalizeCropRatios(topInput, heightInput) {
  const minTop = OVERLAY_SETTINGS_LIMITS.cropTopRatioMin;
  const maxTop = OVERLAY_SETTINGS_LIMITS.cropTopRatioMax;
  const minHeight = OVERLAY_SETTINGS_LIMITS.cropHeightRatioMin;
  const maxHeight = OVERLAY_SETTINGS_LIMITS.cropHeightRatioMax;

  let top = clampNumber(topInput, minTop, maxTop, OVERLAY_SETTINGS_DEFAULTS.cropTopRatio);
  let height = clampNumber(heightInput, minHeight, maxHeight, OVERLAY_SETTINGS_DEFAULTS.cropHeightRatio);

  if ((top + height) > 1.0) {
    height = Math.max(minHeight, 1.0 - top);
  }
  if ((top + height) > 1.0) {
    top = Math.max(minTop, 1.0 - height);
  }

  return {
    top: Number(top.toFixed(4)),
    height: Number(height.toFixed(4)),
  };
}

function normalizeOverlaySettings(raw) {
  const candidate = raw && typeof raw === 'object' ? raw : {};
  const cropPreset = typeof candidate.cropPreset === 'string' ? candidate.cropPreset.trim().toLowerCase() : '';
  const validCropPreset = OVERLAY_CROP_PRESETS.includes(cropPreset)
    ? cropPreset
    : OVERLAY_SETTINGS_DEFAULTS.cropPreset;

  const cropRatios = normalizeCropRatios(candidate.cropTopRatio, candidate.cropHeightRatio);

  return {
    autoTriggerEnabled: candidate.autoTriggerEnabled !== undefined
      ? !!candidate.autoTriggerEnabled
      : OVERLAY_SETTINGS_DEFAULTS.autoTriggerEnabled,
    hotkeyEnabled: candidate.hotkeyEnabled !== undefined
      ? !!candidate.hotkeyEnabled
      : OVERLAY_SETTINGS_DEFAULTS.hotkeyEnabled,
    hotkey: normalizeHotkey(candidate.hotkey ?? OVERLAY_SETTINGS_DEFAULTS.hotkey),
    cropDebugHotkeyEnabled: candidate.cropDebugHotkeyEnabled !== undefined
      ? !!candidate.cropDebugHotkeyEnabled
      : OVERLAY_SETTINGS_DEFAULTS.cropDebugHotkeyEnabled,
    cropDebugHotkey: normalizeHotkey(candidate.cropDebugHotkey ?? OVERLAY_SETTINGS_DEFAULTS.cropDebugHotkey),
    cropPreset: validCropPreset,
    cropTopRatio: cropRatios.top,
    cropHeightRatio: cropRatios.height,
    ocrEngine: normalizeOcrEngine(candidate.ocrEngine),
    ocrPasses: Math.floor(clampNumber(
      candidate.ocrPasses,
      OVERLAY_SETTINGS_LIMITS.ocrPassesMin,
      OVERLAY_SETTINGS_LIMITS.ocrPassesMax,
      OVERLAY_SETTINGS_DEFAULTS.ocrPasses,
    )),
    matchThreshold: clampNumber(
      candidate.matchThreshold,
      OVERLAY_SETTINGS_LIMITS.matchThresholdMin,
      OVERLAY_SETTINGS_LIMITS.matchThresholdMax,
      OVERLAY_SETTINGS_DEFAULTS.matchThreshold,
    ),
    ocrTimeoutMs: Math.floor(clampNumber(
      candidate.ocrTimeoutMs,
      OVERLAY_SETTINGS_LIMITS.ocrTimeoutMsMin,
      OVERLAY_SETTINGS_LIMITS.ocrTimeoutMsMax,
      OVERLAY_SETTINGS_DEFAULTS.ocrTimeoutMs,
    )),
    worldNotificationsEnabled: candidate.worldNotificationsEnabled !== undefined
      ? !!candidate.worldNotificationsEnabled
      : OVERLAY_SETTINGS_DEFAULTS.worldNotificationsEnabled,
  };
}

function loadOverlaySettings() {
  try {
    if (fs.existsSync(OVERLAY_SETTINGS_FILE)) {
      const raw = fs.readFileSync(OVERLAY_SETTINGS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      ctx.overlaySettings = normalizeOverlaySettings({ ...OVERLAY_SETTINGS_DEFAULTS, ...parsed });
    } else {
      ctx.overlaySettings = { ...OVERLAY_SETTINGS_DEFAULTS };
    }
  } catch (err) {
    log.warn('[OverlaySettings] Failed to load settings, using defaults:', err.message);
    ctx.overlaySettings = { ...OVERLAY_SETTINGS_DEFAULTS };
  }
  rewardScanner.setSettings(ctx.overlaySettings);
  return ctx.overlaySettings;
}

function saveOverlaySettings() {
  try {
    fs.writeFileSync(OVERLAY_SETTINGS_FILE, JSON.stringify(ctx.overlaySettings, null, 2), 'utf8');
    return true;
  } catch (err) {
    log.error('[OverlaySettings] Failed to save settings:', err.message);
    return false;
  }
}

function unregisterOverlayTriggerHotkey() {
  if (!ctx.overlayHotkeyRegistered) return;
  try {
    globalShortcut.unregister(ctx.overlayHotkeyRegistered);
  } catch (err) {
    log.warn('[OverlayHotkey] unregister failed:', err.message);
  }
  ctx.overlayHotkeyRegistered = null;
}

function unregisterCropDebugHotkey() {
  if (!ctx.overlayCropHotkeyRegistered) return;
  try {
    globalShortcut.unregister(ctx.overlayCropHotkeyRegistered);
  } catch (err) {
    log.warn('[CropHotkey] unregister failed:', err.message);
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
    log.log('[OverlayHotkey] disabled');
    return false;
  }

  const accelerator = ctx.overlaySettings.hotkey;
  if (!accelerator) return false;

  try {
    const ok = globalShortcut.register(accelerator, () => onRelicRewardTrigger('hotkey'));
    if (!ok) {
      log.warn('[OverlayHotkey] register failed:', accelerator);
      return false;
    }
    ctx.overlayHotkeyRegistered = accelerator;
    log.log('[OverlayHotkey] registered:', accelerator);
    return true;
  } catch (err) {
    log.warn('[OverlayHotkey] invalid shortcut:', accelerator, err.message);
    return false;
  }
}

async function openOcrCropDebugger(source = 'manual') {
  const frame = await rewardScanner.captureDebugFrame();
  if (!frame) {
    const msg = 'Could not capture Warframe screen for crop debug.';
    log.warn('[CropDebug] open failed:', msg);
    return { ok: false, error: msg };
  }

  createCropDebugWindow(frame);
  log.log(`[CropDebug] opened from ${source}`);
  return { ok: true, settings: { ...ctx.overlaySettings } };
}

function registerCropDebugHotkey() {
  unregisterCropDebugHotkey();

  if (!ctx.overlaySettings.cropDebugHotkeyEnabled) {
    log.log('[CropHotkey] disabled');
    return false;
  }

  const accelerator = ctx.overlaySettings.cropDebugHotkey;
  if (!accelerator) return false;

  try {
    const ok = globalShortcut.register(accelerator, () => {
      void openOcrCropDebugger('hotkey').catch((err) => {
        log.error('[CropHotkey] open debug failed:', err.message);
      });
    });
    if (!ok) {
      log.warn('[CropHotkey] register failed:', accelerator);
      return false;
    }
    ctx.overlayCropHotkeyRegistered = accelerator;
    log.log('[CropHotkey] registered:', accelerator);
    return true;
  } catch (err) {
    log.warn('[CropHotkey] invalid shortcut:', accelerator, err.message);
    return false;
  }
}

function registerOverlayHotkey() {
  const triggerOk = registerOverlayTriggerHotkey();
  const cropOk = registerCropDebugHotkey();
  return triggerOk || cropOk;
}

function createOverlayWindow() {
  if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) {
    ctx.overlayWindow.show();
    ctx.overlayWindow.focus();
    return;
  }

  ctx.overlayWindow = new BrowserWindow({
    width: 300,
    height: 400,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      preload: getElectronBuildFile('preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  ctx.overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  ctx.overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  ctx.overlayWindow.on('closed', () => { ctx.overlayWindow = null; });
}

function createCropDebugWindow(frame) {
  if (ctx.cropDebugWindow && !ctx.cropDebugWindow.isDestroyed()) {
    ctx.cropDebugWindow.show();
    ctx.cropDebugWindow.focus();
    ctx.cropDebugWindow.webContents.send('crop-debug:init', {
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
    title: 'OCR Crop Debugger',
    backgroundColor: '#0b1320',
    webPreferences: {
      preload: getElectronBuildFile('preload-crop.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  ctx.cropDebugWindow.loadFile(path.join(__dirname, '..', 'renderer', 'crop-debug.html'));

  ctx.cropDebugWindow.webContents.once('did-finish-load', () => {
    if (ctx.cropDebugWindow && !ctx.cropDebugWindow.isDestroyed()) {
      ctx.cropDebugWindow.webContents.send('crop-debug:init', {
        ...frame,
        cropTopRatio: ctx.overlaySettings.cropTopRatio,
        cropHeightRatio: ctx.overlaySettings.cropHeightRatio,
      });
    }
  });

  ctx.cropDebugWindow.on('closed', () => {
    ctx.cropDebugWindow = null;
  });
}

function sendItemsWhenReady(scanPromise) {
  scanPromise
    .then(items => {
      if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return;
      ctx.overlayWindow.webContents.send('relic-reward-items', items ?? []);
    })
    .catch(err => {
      log.error('[Trigger] scan error:', err.message);
      if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) {
        ctx.overlayWindow.webContents.send('relic-reward-items', []);
      }
    });
}

function onRelicRewardTrigger(source = 'manual') {
  if (source === 'eelog' && !ctx.overlaySettings.autoTriggerEnabled) return;

  const scanPromise = rewardScanner.scanRewards();

  const isNew = !ctx.overlayWindow || ctx.overlayWindow.isDestroyed();
  createOverlayWindow();
  if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return;

  if (isNew) {
    ctx.overlayWindow.webContents.once('did-finish-load', () => {
      if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) {
        ctx.overlayWindow.webContents.send('relic-reward-trigger');
        sendItemsWhenReady(scanPromise);
      }
    });
  } else {
    ctx.overlayWindow.webContents.send('relic-reward-trigger');
    sendItemsWhenReady(scanPromise);
  }
}

function applyCropSelection(selection) {
  const cropTopRatio = selection && typeof selection === 'object' ? selection.cropTopRatio : undefined;
  const cropHeightRatio = selection && typeof selection === 'object' ? selection.cropHeightRatio : undefined;
  const crop = normalizeCropRatios(cropTopRatio, cropHeightRatio);

  ctx.overlaySettings = normalizeOverlaySettings({
    ...ctx.overlaySettings,
    cropPreset: 'custom',
    cropTopRatio: crop.top,
    cropHeightRatio: crop.height,
  });

  rewardScanner.setSettings(ctx.overlaySettings);
  saveOverlaySettings();

  if (ctx.cropDebugWindow && !ctx.cropDebugWindow.isDestroyed()) {
    ctx.cropDebugWindow.webContents.send('crop-debug:applied', {
      cropTopRatio: ctx.overlaySettings.cropTopRatio,
      cropHeightRatio: ctx.overlaySettings.cropHeightRatio,
    });
  }

  return { ...ctx.overlaySettings };
}

function register() {
  ipcMain.on('overlay-close', () => {
    if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) ctx.overlayWindow.hide();
  });

  ipcMain.on('crop-debug-close', () => {
    if (ctx.cropDebugWindow && !ctx.cropDebugWindow.isDestroyed()) {
      ctx.cropDebugWindow.close();
    }
  });

  ipcMain.handle('overlay-get-relic-items', async () => {
    const db = relicService.getRelicDatabase();
    const seen = new Map();
    for (const group of Object.values(db.groups)) {
      for (const qualData of Object.values(group.qualities)) {
        for (const r of qualData.rewards) {
          if (r.name && !seen.has(r.name)) {
            seen.set(r.name, { name: r.name, urlName: r.urlName || null, rarity: r.rarity || 'Common' });
          }
        }
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  ipcMain.handle('overlay:get-settings', async () => ({ ...ctx.overlaySettings }));

  ipcMain.handle('overlay:set-settings', async (_event, nextSettings) => {
    ctx.overlaySettings = normalizeOverlaySettings({
      ...ctx.overlaySettings,
      ...(nextSettings && typeof nextSettings === 'object' ? nextSettings : {}),
    });
    rewardScanner.setSettings(ctx.overlaySettings);
    saveOverlaySettings();
    registerOverlayHotkey();
    return { ...ctx.overlaySettings };
  });

  ipcMain.handle('overlay:open-crop-debugger', async () => openOcrCropDebugger('ipc'));

  ipcMain.handle('overlay:apply-crop-selection', async (_event, selection) => {
    try {
      const settings = applyCropSelection(selection);
      return { ok: true, settings };
    } catch (err) {
      log.error('[CropDebug] apply selection failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on('toggle-overlay', () => {
    if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) {
      createOverlayWindow();
    } else if (ctx.overlayWindow.isVisible()) {
      ctx.overlayWindow.hide();
    } else {
      ctx.overlayWindow.show();
      ctx.overlayWindow.focus();
    }
  });

  ipcMain.on('simulate-relic-trigger', () => onRelicRewardTrigger('simulate'));
}

module.exports = {
  register,
  loadOverlaySettings,
  registerOverlayHotkey,
  unregisterOverlayHotkey,
  onRelicRewardTrigger,
  openOcrCropDebugger,
};