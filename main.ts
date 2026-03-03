import { app, BrowserWindow, globalShortcut } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_ROOT = path.resolve(__dirname, "..");

function fromAppRoot(relPath: string): any {
  return require(path.join(APP_ROOT, relPath));
}

const log = fromAppRoot("services/logger").withScope("Main");
const { MAIN_WINDOW_CSP } = fromAppRoot("config/runtime/security");

// Services
const itemDb = fromAppRoot("services/itemDatabase");
const wfMarket = fromAppRoot("services/warframeMarket");
const wfmSession = fromAppRoot("services/wfmSession");
const wfmCatalog = fromAppRoot("services/wfmCatalog");
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
    },
  });

  ctx.mainWindow.loadFile(path.join(APP_ROOT, "renderer", "dist", "index.html"));

  ctx.mainWindow.webContents.on("before-input-event", (_event: unknown, input: { type?: string; key?: string }) => {
    if (input.type === "keyDown" && input.key === "F12") {
      if (ctx.mainWindow.webContents.isDevToolsOpened()) {
        ctx.mainWindow.webContents.closeDevTools();
      } else {
        ctx.mainWindow.webContents.openDevTools({ mode: "detach" });
      }
    }
  });

  ctx.mainWindow.webContents.session.webRequest.onHeadersReceived((details: { responseHeaders?: Record<string, string[]> }, callback: (arg0: { responseHeaders: Record<string, string[]> }) => void) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [MAIN_WINDOW_CSP],
      },
    });
  });

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
  overlayIpc.loadOverlaySettings();

  inventoryIpc.register();
  wfmIpc.register();
  overlayIpc.register();
  worldStateIpc.register();
  systemIpc.register();

  itemDb.buildDatabase();

  await inventoryIpc.fetchAlecaKeys();

  wfMarket.fetchItemList().catch((err: Error) => log.error("[WFMarket] startup fetch failed:", err));

  await wfmSession.restoreSession();

  wfmCatalog.prefetch();

  createWindow();
  autoUpdater.initialize(ctx.mainWindow);
  overlayIpc.registerOverlayHotkey();

  const found = inventoryIpc.findInventoryFile();
  if (found) {
    ctx.currentInventoryPath = found;
    inventoryIpc.watchInventoryFile(found);
    log.log("Auto-detected inventory at:", found);
  }

  const eeLogPath = eeLogMonitor.startWatching(() => overlayIpc.onRelicRewardTrigger("eelog"));
  if (eeLogPath) log.log("[EELog] Monitoring:", eeLogPath);
  else log.log("[EELog] EE.log not found - relic overlay trigger disabled");

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

