const { app, BrowserWindow, globalShortcut } = require('electron');
const path = require('path');

// Services
const itemDb         = require('./services/itemDatabase');
const wfMarket       = require('./services/warframeMarket');
const wfmSession     = require('./services/wfmSession');
const wfmCatalog     = require('./services/wfmCatalog');
const relicService   = require('./services/relicService');
const eeLogMonitor   = require('./services/eeLogMonitor');
const rewardScanner  = require('./services/rewardScanner');

// IPC modules
const ctx            = require('./ipc/context');
const inventoryIpc   = require('./ipc/inventoryIpc');
const wfmIpc         = require('./ipc/wfmIpc');
const overlayIpc     = require('./ipc/overlayIpc');
const worldStateIpc  = require('./ipc/worldStateIpc');
const systemIpc      = require('./ipc/systemIpc');

// Suppress noisy Chromium/DevTools internal logging in terminal.
app.commandLine.appendSwitch('disable-logging');
app.commandLine.appendSwitch('log-level', '3');

// ─── Main Window ─────────────────────────────────────────────────────────────

function createWindow() {
  ctx.mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0e17',
    titleBarStyle: 'hidden',
    // Custom titlebar on Windows; native traffic lights on macOS
    ...(process.platform === 'darwin' ? { titleBarOverlay: false } : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load Svelte build output
  ctx.mainWindow.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'));

  // Toggle DevTools with F12
  ctx.mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      if (ctx.mainWindow.webContents.isDevToolsOpened()) {
        ctx.mainWindow.webContents.closeDevTools();
      } else {
        ctx.mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });

  // Allow external images (Google Fonts for UI, warframe.market CDN for item images)
  ctx.mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https: http:; connect-src 'self' https:;"
        ],
      },
    });
  });

  if (process.env.NODE_ENV === 'development') {
    ctx.mainWindow.webContents.openDevTools();
  }

  // When the main window closes, destroy any orphaned overlay and quit.
  // Without this, a hidden overlay keeps the Electron process alive forever.
  ctx.mainWindow.on('closed', () => {
    ctx.mainWindow = null;
    if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) ctx.overlayWindow.destroy();
    app.quit();
  });
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Load and apply persisted overlay settings before registering IPC handlers
  overlayIpc.loadOverlaySettings();

  // Register all IPC channels
  inventoryIpc.register();
  wfmIpc.register();
  overlayIpc.register();
  worldStateIpc.register();
  systemIpc.register();

  // Build item DB (maps internal Warframe item names → display names/images)
  itemDb.buildDatabase();

  // Fetch AlecaFrame decryption keys from nrbdev's gists
  await inventoryIpc.fetchAlecaKeys();

  // Fetch warframe.market item list (used by mastery helper for trade links)
  wfMarket.fetchItemList().catch(err => console.error('[WFMarket] startup fetch failed:', err));

  // Restore persisted WFM session (safeStorage requires app to be ready first)
  await wfmSession.restoreSession();

  // Prefetch WFM catalog in background so item search is instant
  wfmCatalog.prefetch();

  createWindow();
  overlayIpc.registerOverlayHotkey();

  // Auto-detect inventory file and start watching it
  const found = inventoryIpc.findInventoryFile();
  if (found) {
    ctx.currentInventoryPath = found;
    inventoryIpc.watchInventoryFile(found);
    console.log('Auto-detected inventory at:', found);
  }

  // Start EE.log monitor for automatic relic overlay trigger
  const eeLogPath = eeLogMonitor.startWatching(() => overlayIpc.onRelicRewardTrigger('eelog'));
  if (eeLogPath) console.log('[EELog] Monitoring:', eeLogPath);
  else           console.log('[EELog] EE.log not found — relic overlay trigger disabled');

  // Feed reward scanner the full relic item list once at startup
  try {
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
    rewardScanner.setRelicItems([...seen.values()]);
  } catch (err) {
    console.error('[RewardScanner] Failed to load relic items:', err.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (ctx.watcher) ctx.watcher.close();
  eeLogMonitor.stopWatching();
  overlayIpc.unregisterOverlayHotkey();
  if (process.platform !== 'darwin') app.quit();
});

// Clean up temp OCR screenshot on exit
app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
  const os  = require('os');
  const tmp = path.join(os.tmpdir(), 'wf-companion-reward-ocr.png');
  try { require('fs').unlinkSync(tmp); } catch { /* not present, ignore */ }
});
