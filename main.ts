import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withScope } from "./services/logger";
import { MAIN_WINDOW_CSP, PERMISSIONS_POLICY } from "./config/runtime/security";
import * as windowSecurity from "./services/windowSecurity";

const log = withScope("Main");

const MAIN_WINDOW_ENTRY_FILE = path.join(app.getAppPath(), "renderer", "dist", "index.html");

// Services
import * as itemDb from "./services/itemDatabase";
import * as wfmCatalog from "./services/wfmCatalog";
import * as wfmSession from "./services/wfmSession";
import * as relicService from "./services/relicService";
import * as eeLogMonitor from "./services/eeLogMonitor";
import * as keyboardMonitor from "./services/keyboardMonitor";
import * as rewardScanner from "./services/rewardScanner";
import * as ocrServer from "./services/ocrServer";
import * as crashReporter from "./services/crashReporter";
import * as autoUpdater from "./services/autoUpdater";

// IPC modules
import ctx from "./ipc/context";
import * as inventoryIpc from "./ipc/inventoryIpc";
import * as wfmIpc from "./ipc/wfmIpc";
import * as overlayIpc from "./ipc/overlayIpc";
import * as worldStateIpc from "./ipc/worldStateIpc";
import * as systemIpc from "./ipc/systemIpc";
import * as snapshotCacheIpc from "./ipc/snapshotCacheIpc";
import * as rankedHotsetIpc from "./ipc/rankedHotsetIpc";
import * as statsIpc from "./ipc/statsIpc";
import * as rivensIpc from "./ipc/rivensIpc";
import * as tradeNotificationIpc from "./ipc/tradeNotificationIpc";
import { assertAuthorizedSender, assertMainRendererSender } from "./ipc/ipcSecurity";
import * as statsTracker from "./services/statsTracker";
import * as tradeTracker from "./services/tradeTracker";
import * as tradeWfmMatcher from "./services/tradeWfmMatcher";
import * as apiHelperRunner from "./services/apiHelperRunner";

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
  ipcMain.handle("helper:get-status", (event: unknown) => {
    assertAuthorizedSender(
      assertMainRendererSender,
      event as never,
      "helper:get-status",
    );
    return apiHelperRunner.getStatus();
  });
  ipcMain.handle("helper:run-now", async (event: unknown) => {
    assertAuthorizedSender(
      assertMainRendererSender,
      event as never,
      "helper:run-now",
    );
    const ok = await apiHelperRunner.runOnce();
    return { ok };
  });
  ipcMain.handle("helper:download", async (event: unknown) => {
    assertAuthorizedSender(
      assertMainRendererSender,
      event as never,
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
    onTradeConfirmed: (trade: import("./services/eeLogMonitor").ParsedLogTrade) => {
      const event = tradeTracker.recordTradeFromLog(trade);
      if (!event) return;

      // Push trade to renderer in real-time
      const win = ctx.mainWindow;
      if (win && !win.isDestroyed()) {
        win.webContents.send("trade-recorded", { trade: event, wfmMatch: null });
      }

      // Attempt WFM auto-close (async, fire-and-forget)
      if (!ctx.overlaySettings.autoCloseWfmOrders) return;

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
          if (ctx.overlaySettings.showTradeNotification !== false) {
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
