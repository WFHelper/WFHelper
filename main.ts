import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const log = (fromAppRoot("services/logger") as typeof import("./services/logger")).withScope("Main");
const { MAIN_WINDOW_CSP, PERMISSIONS_POLICY } = fromAppRoot("config/runtime/security") as {
  MAIN_WINDOW_CSP: string;
  PERMISSIONS_POLICY: string;
};
const windowSecurity = fromAppRoot("services/windowSecurity") as typeof import("./services/windowSecurity");

const MAIN_WINDOW_ENTRY_FILE = path.join(APP_ROOT, "renderer", "dist", "index.html");

// Services
const itemDb = fromAppRoot("services/itemDatabase") as typeof import("./services/itemDatabase");
const wfmCatalog = fromAppRoot("services/wfmCatalog") as typeof import("./services/wfmCatalog");
const wfmSession = fromAppRoot("services/wfmSession") as typeof import("./services/wfmSession");
const relicService = fromAppRoot("services/relicService") as typeof import("./services/relicService");
const eeLogMonitor = fromAppRoot("services/eeLogMonitor") as typeof import("./services/eeLogMonitor");
const keyboardMonitor = fromAppRoot("services/keyboardMonitor") as typeof import("./services/keyboardMonitor");
const rewardScanner = fromAppRoot("services/rewardScanner") as typeof import("./services/rewardScanner");
const ocrServer = fromAppRoot("services/ocrServer") as typeof import("./services/ocrServer");
const crashReporter = fromAppRoot("services/crashReporter") as typeof import("./services/crashReporter");
const autoUpdater = fromAppRoot("services/autoUpdater") as typeof import("./services/autoUpdater");

// IPC modules
const ctx = fromAppRoot("ipc/context") as typeof import("./ipc/context")["default"];
const inventoryIpc = fromAppRoot("ipc/inventoryIpc") as typeof import("./ipc/inventoryIpc");
const wfmIpc = fromAppRoot("ipc/wfmIpc") as typeof import("./ipc/wfmIpc");
const overlayIpc = fromAppRoot("ipc/overlayIpc") as typeof import("./ipc/overlayIpc");
const worldStateIpc = fromAppRoot("ipc/worldStateIpc") as typeof import("./ipc/worldStateIpc");
const systemIpc = fromAppRoot("ipc/systemIpc") as typeof import("./ipc/systemIpc");
const snapshotCacheIpc = fromAppRoot("ipc/snapshotCacheIpc") as typeof import("./ipc/snapshotCacheIpc");
const rankedHotsetIpc = fromAppRoot("ipc/rankedHotsetIpc") as typeof import("./ipc/rankedHotsetIpc");
const statsIpc = fromAppRoot("ipc/statsIpc") as typeof import("./ipc/statsIpc");
const rivensIpc = fromAppRoot("ipc/rivensIpc") as typeof import("./ipc/rivensIpc");
const tradeNotificationIpc = fromAppRoot("ipc/tradeNotificationIpc") as typeof import("./ipc/tradeNotificationIpc");
const statsTracker = fromAppRoot("services/statsTracker") as typeof import("./services/statsTracker");
const tradeTracker = fromAppRoot("services/tradeTracker") as typeof import("./services/tradeTracker");
const tradeWfmMatcher = fromAppRoot("services/tradeWfmMatcher") as typeof import("./services/tradeWfmMatcher");
const apiHelperRunner = fromAppRoot("services/apiHelperRunner") as typeof import("./services/apiHelperRunner");

// Suppress noisy Chromium/DevTools internal logging in terminal.
app.commandLine.appendSwitch("disable-logging");
app.commandLine.appendSwitch("log-level", "3");

// Disable GPU hardware acceleration to prevent Chromium's compositor from keeping
// the discrete GPU active at idle, which causes a significant temperature increase
// (~15-20°C) even with zero CPU usage.  The app's UI is simple enough that software
// rendering is indistinguishable and far more power-efficient.
app.disableHardwareAcceleration();

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
          if (ctx.mainWindow?.webContents.isDevToolsOpened()) {
            ctx.mainWindow.webContents.closeDevTools();
          } else {
            ctx.mainWindow?.webContents.openDevTools({ mode: "detach" });
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
    if (ctx.rivenOverlayLeftWindow && !ctx.rivenOverlayLeftWindow.isDestroyed())
      ctx.rivenOverlayLeftWindow.destroy();
    if (ctx.rivenOverlayRightWindow && !ctx.rivenOverlayRightWindow.isDestroyed())
      ctx.rivenOverlayRightWindow.destroy();
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

  const statsLoadStart = Date.now();
  statsTracker.loadHistory();
  tradeTracker.loadTradeLog();
  inventoryIpc.addInventoryListener((data: Record<string, unknown>) => {
    statsTracker.onInventoryData(data);
  });
  profileStage("stats:load-history", statsLoadStart);

  const ipcRegisterStart = Date.now();
  inventoryIpc.register();
  wfmIpc.register();
  overlayIpc.register();
  worldStateIpc.register();
  systemIpc.register();
  snapshotCacheIpc.register();
  rankedHotsetIpc.register();
  statsIpc.register();
  rivensIpc.register();
  tradeNotificationIpc.register();

  // Helper runner IPC
  const ipcSecurityMod = fromAppRoot("ipc/ipcSecurity");
  ipcMain.handle("helper:get-status", (event: unknown) => {
    ipcSecurityMod.assertAuthorizedSender(
      ipcSecurityMod.assertMainRendererSender,
      event,
      "helper:get-status",
    );
    return apiHelperRunner.getStatus();
  });
  ipcMain.handle("helper:run-now", async (event: unknown) => {
    ipcSecurityMod.assertAuthorizedSender(
      ipcSecurityMod.assertMainRendererSender,
      event,
      "helper:run-now",
    );
    const ok = await apiHelperRunner.runOnce();
    return { ok };
  });
  ipcMain.handle("helper:download", async (event: unknown) => {
    ipcSecurityMod.assertAuthorizedSender(
      ipcSecurityMod.assertMainRendererSender,
      event,
      "helper:download",
    );
    const ok = await apiHelperRunner.downloadHelper((progress) => {
      if (ctx.mainWindow) {
        ctx.mainWindow.webContents.send("helper-download-progress", progress);
      }
    });
    return { ok };
  });

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
  void wfmSession
    .restoreSession()
    .then(() => {
      wfmIpc.startListenerIfLoggedIn();
    })
    .catch((err: Error) => {
      log.warn("[WFMSession] restore failed:", err?.message || String(err));
    });
  profileStage("wfm-session:restore-dispatch", sessionRestoreStart);

  const updaterStart = Date.now();
  autoUpdater.initialize(ctx.mainWindow!);
  profileStage("auto-updater:init", updaterStart);

  const hotkeyStart = Date.now();
  overlayIpc.registerOverlayHotkey();
  profileStage("overlay-hotkey:register", hotkeyStart);

  const inventoryDetectStart = Date.now();
  apiHelperRunner.init();
  const found = inventoryIpc.findInventoryFile();
  if (found) {
    ctx.currentInventoryPath = found;
    inventoryIpc.watchInventoryFile(found);
    log.log("Auto-detected inventory at:", found);

    // Auto-load inventory and send to renderer once the page is ready
    const data = inventoryIpc.readInventory(found);
    if (data && ctx.mainWindow) {
      ctx.mainWindow.webContents.once("did-finish-load", () => {
        if (ctx.mainWindow) {
          ctx.mainWindow.webContents.send("inventory-updated", data);
        }
      });
    }
  }

  // Start helper polling (runs exe every 10 min; chokidar picks up changes)
  apiHelperRunner.startPolling();

  profileStage("inventory:auto-detect", inventoryDetectStart);

  const eeLogStart = Date.now();
  const eeLogPath = eeLogMonitor.startWatching({
    onRewardTrigger: () => overlayIpc.onRelicRewardTrigger("eelog"),
    onRelicSelectionOpen: () => overlayIpc.onRelicSelectionTrigger("eelog"),
    onRelicSelectionClose: () => overlayIpc.onRelicSelectionClose(),
    onTradeConfirmed: (trade: any) => {
      const event = tradeTracker.recordTradeFromLog(trade);
      if (!event) return;

      // Push trade to renderer in real-time
      const win = ctx.mainWindow;
      if (win && !win.isDestroyed()) {
        win.webContents.send("trade-recorded", { trade: event, wfmMatch: null });
      }

      // Attempt WFM auto-close (async, fire-and-forget)
      const settings = ctx.overlaySettings as Record<string, unknown>;
      if (settings?.autoCloseWfmOrders === false) return;

      void (async () => {
        try {
          const match = await tradeWfmMatcher.matchTradeToOrder(trade);
          if (!match) return;

          const closed = await tradeWfmMatcher.closeMatchedOrder(match);
          if (!closed) return;

          tradeTracker.markTradeWfmClosed(event.id);

          // Update renderer with the WFM match info
          if (win && !win.isDestroyed()) {
            win.webContents.send("trade-recorded", {
              trade: { ...event, wfmClosed: true },
              wfmMatch: match,
            });
          }

          // Show trade notification overlay (if enabled)
          if (settings?.showTradeNotification !== false) {
            tradeNotificationIpc.showTradeNotification(match);
          }
        } catch (err) {
          log.warn("[Trade] Auto-close error:", String(err));
        }
      })();
    },
    onRivenSessionOpen: () => overlayIpc.onRivenSessionOpen(),
    onRivenSessionClose: () => overlayIpc.onRivenSessionClose(),
    onRivenRollPending: (weapon: string, cost: number) =>
      overlayIpc.onRivenRollPending(weapon, cost),
    onRivenRollConfirmed: () => overlayIpc.onRivenRollConfirmed(),
    onRivenDioramaSetup: () => overlayIpc.onRivenDioramaSetup(),
    onRivenChoiceConfirmed: () => overlayIpc.onRivenChoiceConfirmed(),
    onRivenChatView: () => overlayIpc.onRivenChatView(),
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

  // NOTE: ocrServer.warmup() was intentionally removed.
  // Spawning PowerShell WinRT OCR processes at startup causes a ~15°C CPU
  // temperature spike when Warframe is running (DWM/compositor interaction).
  // The pool starts on first actual use (first riven/relic scan), adding one
  // ~450 ms warmup delay only if the native @napi-rs/system-ocr engine is
  // unavailable. That one-time cost is acceptable.

  // Pre-warm the Tesseract WASM worker in the background (Change 4).
  // Unlike the PowerShell OCR pool, the Tesseract WASM worker is pure JS/WASM
  // with no external process spawn, so it is safe to initialise at startup.
  // This eliminates the ~500 ms first-scan cold-start for riven roll scanning.
  if (ocrServer.tesseractWorkerAvailable) {
    ocrServer.getTesseractWorker(); // fire-and-forget; rejects are swallowed inside _initTesseractWorker
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (ctx.watcher) ctx.watcher.close();
  apiHelperRunner.stopPolling();
  eeLogMonitor.stopWatching();
  keyboardMonitor.stopEscMonitor();
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
