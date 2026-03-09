import { app, BrowserWindow, globalShortcut } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type * as WfmSessionTypes from "./services/wfmSession";

const APP_ROOT = path.resolve(__dirname, "..");

function fromAppRoot(relPath: string): any {
  const unwrapDefault = (loaded: any): any => {
    if (!loaded || typeof loaded !== "object") return loaded;
    if (!Object.prototype.hasOwnProperty.call(loaded, "default")) return loaded;
    const keys = Object.keys(loaded);
    const defaultOnly = keys.every((key) => key === "default" || key === "__esModule");
    return defaultOnly ? loaded.default : loaded;
  };

  const buildPath = path.join(__dirname, relPath);
  try {
    const resolved = require.resolve(buildPath);
    return unwrapDefault(require(resolved));
  } catch {
    return unwrapDefault(require(path.join(APP_ROOT, relPath)));
  }
}

const log = fromAppRoot("services/logger").withScope("Main");
const { MAIN_WINDOW_CSP, PERMISSIONS_POLICY } = fromAppRoot("config/runtime/security");
const windowSecurity = fromAppRoot("services/windowSecurity");

const MAIN_WINDOW_ENTRY_FILE = path.join(APP_ROOT, "renderer", "dist", "index.html");

// Services
const itemDb = fromAppRoot("services/itemDatabase");
const wfmCatalog = fromAppRoot("services/wfmCatalog");
const wfmSession: typeof WfmSessionTypes = fromAppRoot("services/wfmSession");
const relicService = fromAppRoot("services/relicService");
const eeLogMonitor = fromAppRoot("services/eeLogMonitor");
const rewardScanner = fromAppRoot("services/rewardScanner");
const crashReporter = fromAppRoot("services/crashReporter");
const autoUpdater = fromAppRoot("services/autoUpdater");

// IPC modules
const ctx = fromAppRoot("ipc/context");
const inventoryIpc = fromAppRoot("ipc/inventoryIpc");
const wfmIpc = fromAppRoot("ipc/wfmIpc");
const overlayIpc = fromAppRoot("ipc/overlayIpc");
const worldStateIpc = fromAppRoot("ipc/worldStateIpc");
const systemIpc = fromAppRoot("ipc/systemIpc");
const priceCacheIpc = fromAppRoot("ipc/priceCacheIpc");
const orderCacheIpc = fromAppRoot("ipc/orderCacheIpc");

// Suppress noisy Chromium/DevTools internal logging in terminal.
app.commandLine.appendSwitch("disable-logging");
app.commandLine.appendSwitch("log-level", "3");

crashReporter.initCrashReporting();

process.on("uncaughtException", (err: Error) => {
  log.error("[Main] uncaughtException:", err);
  crashReporter.captureMainException(err, { source: "uncaughtException" });
});

process.on("unhandledRejection", (reason: unknown) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  log.error("[Main] unhandledRejection:", error);
  crashReporter.captureMainException(error, { source: "unhandledRejection" });
});

function createWindow(): void {
  ctx.mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0e17",
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? { titleBarOverlay: false } : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  windowSecurity.hardenBrowserWindowNavigation(ctx.mainWindow, {
    label: "main renderer",
    allowedFilePaths: [MAIN_WINDOW_ENTRY_FILE],
    log,
  });

  ctx.mainWindow.loadFile(MAIN_WINDOW_ENTRY_FILE);

  if (!app.isPackaged) {
    ctx.mainWindow.webContents.on(
      "before-input-event",
      (_event: unknown, input: { type?: string; key?: string }) => {
        if (input.type === "keyDown" && input.key === "F12") {
          if (ctx.mainWindow.webContents.isDevToolsOpened()) {
            ctx.mainWindow.webContents.closeDevTools();
          } else {
            ctx.mainWindow.webContents.openDevTools({ mode: "detach" });
          }
        }
      },
    );
  }

  ctx.mainWindow.webContents.session.webRequest.onHeadersReceived(
    (
      details: { responseHeaders?: Record<string, string[]> },
      callback: (arg0: { responseHeaders: Record<string, string[]> }) => void,
    ) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [MAIN_WINDOW_CSP],
          "Permissions-Policy": [PERMISSIONS_POLICY],
        },
      });
    },
  );

  if (process.env.NODE_ENV === "development") {
    ctx.mainWindow.webContents.openDevTools();
  }

  ctx.mainWindow.on("closed", () => {
    ctx.mainWindow = null;
    if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) ctx.overlayWindow.destroy();
    app.quit();
  });
}

app.whenReady().then(async () => {
  const startupStartedAt = Date.now();
  const profileStage = (label: string, startedAt: number): void => {
    log.log(`[StartupProfile][main] ${label}: ${Date.now() - startedAt}ms`);
  };

  const settingsStart = Date.now();
  overlayIpc.loadOverlaySettings();
  profileStage("overlay-settings:load", settingsStart);

  const ipcRegisterStart = Date.now();
  inventoryIpc.register();
  wfmIpc.register();
  overlayIpc.register();
  worldStateIpc.register();
  systemIpc.register();
  priceCacheIpc.register();
  orderCacheIpc.register();
  profileStage("ipc:register", ipcRegisterStart);

  const itemDbStart = Date.now();
  itemDb.buildDatabase();
  profileStage("item-db:build", itemDbStart);

  const catalogStart = Date.now();
  wfmCatalog
    .ensureLoaded()
    .catch((err: Error) => log.error("[WFMarket] startup fetch failed:", err));
  profileStage("wfm-catalog:ensureLoaded-dispatch", catalogStart);

  const windowStart = Date.now();
  createWindow();
  profileStage("window:create", windowStart);

  const sessionRestoreStart = Date.now();
  void wfmSession.restoreSession().catch((err: Error) => {
    log.warn("[WFMSession] restore failed:", err?.message || String(err));
  });
  profileStage("wfm-session:restore-dispatch", sessionRestoreStart);

  const updaterStart = Date.now();
  autoUpdater.initialize(ctx.mainWindow);
  profileStage("auto-updater:init", updaterStart);

  const hotkeyStart = Date.now();
  overlayIpc.registerOverlayHotkey();
  profileStage("overlay-hotkey:register", hotkeyStart);

  const inventoryDetectStart = Date.now();
  const found = inventoryIpc.findInventoryFile();
  if (found) {
    ctx.currentInventoryPath = found;
    inventoryIpc.watchInventoryFile(found);
    log.log("Auto-detected inventory at:", found);
  }
  profileStage("inventory:auto-detect", inventoryDetectStart);

  const eeLogStart = Date.now();
  const eeLogPath = eeLogMonitor.startWatching({
    onRewardTrigger: () => overlayIpc.onRelicRewardTrigger("eelog"),
    onRelicSelectionOpen: () => overlayIpc.onRelicSelectionTrigger("eelog"),
    onRelicSelectionClose: () => overlayIpc.onRelicSelectionClose(),
  });
  if (eeLogPath) log.log("[EELog] Monitoring:", eeLogPath);
  else log.log("[EELog] EE.log not found - relic overlay trigger disabled");
  profileStage("ee-log:watch-start", eeLogStart);

  const rewardItemsStart = Date.now();
  try {
    const db = relicService.getRelicDatabase();
    const seen = new Map();
    for (const group of Object.values(db.groups as Record<string, any>)) {
      for (const qualData of Object.values((group as any).qualities as Record<string, any>)) {
        for (const reward of (qualData as any).rewards || []) {
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
    rewardScanner.setRelicItems([...seen.values()]);
  } catch (err) {
    log.error("[RewardScanner] Failed to load relic items:", (err as Error).message);
  }
  profileStage("relic-reward-items:prepare", rewardItemsStart);

  profileStage("total-main-startup-sequence", startupStartedAt);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (ctx.watcher) ctx.watcher.close();
  eeLogMonitor.stopWatching();
  overlayIpc.unregisterOverlayHotkey();
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  try {
    globalShortcut.unregisterAll();
  } catch {
    // ignore
  }

  const tempOcrPath = path.join(os.tmpdir(), "wf-companion-reward-ocr.png");
  try {
    fs.unlinkSync(tempOcrPath);
  } catch {
    // ignore missing temp file
  }
});
