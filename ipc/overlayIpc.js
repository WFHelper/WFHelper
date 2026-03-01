/**
 * Overlay IPC handlers + settings management + global hotkey.
 * Handles: overlay-close, overlay-get-relic-items, overlay:get-settings,
 *          overlay:set-settings, toggle-overlay, simulate-relic-trigger
 */

const { ipcMain, BrowserWindow, globalShortcut, app } = require('electron');
const path = require('path');
const fs = require('fs');
const relicService   = require('../services/relicService');
const rewardScanner  = require('../services/rewardScanner');
const ctx            = require('./context');

// ─── Settings config ──────────────────────────────────────────────────────────

const OVERLAY_SETTINGS_FILE = path.join(app.getPath('userData'), 'overlay-settings.json');
const OVERLAY_SETTINGS_DEFAULTS = Object.freeze({
  autoTriggerEnabled: true,
  hotkeyEnabled:      true,
  hotkey:             'F8',
  cropPreset:         'balanced',
  ocrPasses:          2,
  matchThreshold:     0.74,
  ocrTimeoutMs:       15000,
});

// ─── Settings helpers ─────────────────────────────────────────────────────────

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
      if (low === 'command')          return 'Command';
      if (low === 'control' || low === 'ctrl') return 'Control';
      if (low === 'alt')    return 'Alt';
      if (low === 'option') return 'Option';
      if (low === 'shift')  return 'Shift';
      if (low === 'super')  return 'Super';
      return part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1);
    })
    .join('+');
}

function normalizeOverlaySettings(raw) {
  const candidate = raw && typeof raw === 'object' ? raw : {};
  const cropPreset = typeof candidate.cropPreset === 'string' ? candidate.cropPreset.trim().toLowerCase() : '';
  const validCropPreset = ['balanced', 'tight', 'wide'].includes(cropPreset)
    ? cropPreset
    : OVERLAY_SETTINGS_DEFAULTS.cropPreset;

  return {
    autoTriggerEnabled: candidate.autoTriggerEnabled !== undefined
      ? !!candidate.autoTriggerEnabled
      : OVERLAY_SETTINGS_DEFAULTS.autoTriggerEnabled,
    hotkeyEnabled: candidate.hotkeyEnabled !== undefined
      ? !!candidate.hotkeyEnabled
      : OVERLAY_SETTINGS_DEFAULTS.hotkeyEnabled,
    hotkey:         normalizeHotkey(candidate.hotkey ?? OVERLAY_SETTINGS_DEFAULTS.hotkey),
    cropPreset:     validCropPreset,
    ocrPasses:      Math.floor(clampNumber(candidate.ocrPasses, 1, 6, OVERLAY_SETTINGS_DEFAULTS.ocrPasses)),
    matchThreshold: clampNumber(candidate.matchThreshold, 0.55, 0.95, OVERLAY_SETTINGS_DEFAULTS.matchThreshold),
    ocrTimeoutMs:   Math.floor(clampNumber(candidate.ocrTimeoutMs, 4000, 30000, OVERLAY_SETTINGS_DEFAULTS.ocrTimeoutMs)),
  };
}

function loadOverlaySettings() {
  try {
    if (fs.existsSync(OVERLAY_SETTINGS_FILE)) {
      const raw    = fs.readFileSync(OVERLAY_SETTINGS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      ctx.overlaySettings = normalizeOverlaySettings({ ...OVERLAY_SETTINGS_DEFAULTS, ...parsed });
    } else {
      ctx.overlaySettings = { ...OVERLAY_SETTINGS_DEFAULTS };
    }
  } catch (err) {
    console.warn('[OverlaySettings] Failed to load settings, using defaults:', err.message);
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
    console.error('[OverlaySettings] Failed to save settings:', err.message);
    return false;
  }
}

// ─── Hotkey registration ──────────────────────────────────────────────────────

function unregisterOverlayHotkey() {
  if (!ctx.overlayHotkeyRegistered) return;
  try {
    globalShortcut.unregister(ctx.overlayHotkeyRegistered);
  } catch (err) {
    console.warn('[OverlayHotkey] unregister failed:', err.message);
  }
  ctx.overlayHotkeyRegistered = null;
}

function registerOverlayHotkey() {
  unregisterOverlayHotkey();

  if (!ctx.overlaySettings.hotkeyEnabled) {
    console.log('[OverlayHotkey] disabled');
    return false;
  }

  const accelerator = ctx.overlaySettings.hotkey;
  if (!accelerator) return false;

  try {
    const ok = globalShortcut.register(accelerator, () => onRelicRewardTrigger('hotkey'));
    if (!ok) {
      console.warn('[OverlayHotkey] register failed:', accelerator);
      return false;
    }
    ctx.overlayHotkeyRegistered = accelerator;
    console.log('[OverlayHotkey] registered:', accelerator);
    return true;
  } catch (err) {
    console.warn('[OverlayHotkey] invalid shortcut:', accelerator, err.message);
    return false;
  }
}

// ─── Overlay window ───────────────────────────────────────────────────────────

function createOverlayWindow() {
  if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) {
    ctx.overlayWindow.show();
    ctx.overlayWindow.focus();
    return;
  }

  ctx.overlayWindow = new BrowserWindow({
    width:       300,
    height:      400,
    transparent: true,
    frame:       false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable:   false,
    webPreferences: {
      preload:          path.join(__dirname, '..', 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  ctx.overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  ctx.overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  ctx.overlayWindow.on('closed', () => { ctx.overlayWindow = null; });
}

// ─── Relic reward trigger ─────────────────────────────────────────────────────

/** Send scanned items to the overlay once the scan promise resolves. */
function sendItemsWhenReady(scanPromise) {
  scanPromise
    .then(items => {
      if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return;
      ctx.overlayWindow.webContents.send('relic-reward-items', items ?? []);
    })
    .catch(err => {
      console.error('[Trigger] scan error:', err.message);
      if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) {
        ctx.overlayWindow.webContents.send('relic-reward-items', []);
      }
    });
}

function onRelicRewardTrigger(source = 'manual') {
  if (source === 'eelog' && !ctx.overlaySettings.autoTriggerEnabled) return;

  // Start OCR scan immediately (runs in parallel with window creation)
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

// ─── IPC Registration ─────────────────────────────────────────────────────────

function register() {
  ipcMain.on('overlay-close', () => {
    if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) ctx.overlayWindow.hide();
  });

  // Flat list of unique relic reward items for the overlay search autocomplete
  ipcMain.handle('overlay-get-relic-items', async () => {
    const db   = relicService.getRelicDatabase();
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

  // Allow the renderer to simulate a relic reward trigger (debug / testing)
  ipcMain.on('simulate-relic-trigger', () => onRelicRewardTrigger('simulate'));
}

module.exports = { register, loadOverlaySettings, registerOverlayHotkey, unregisterOverlayHotkey, onRelicRewardTrigger };
