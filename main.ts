import "./config/runtime/appIdentity";

import { app, BrowserWindow, globalShortcut } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withScope } from "./services/logger";
import { MAIN_WINDOW_CSP, PERMISSIONS_POLICY } from "./config/runtime/security";
import * as windowSecurity from "./services/windowSecurity";

const log = withScope("Main");

const MAIN_WINDOW_ENTRY_FILE = path.join(app.getAppPath(), "renderer", "dist", "index.html");

import * as itemDb from "./services/itemDatabase";
import * as publicExportSource from "./services/publicExportSource";
import * as dropData from "./services/dropData";
import * as wfmCatalog from "./services/wfmCatalog";
import * as wfmSession from "./services/wfmSession";
import * as relicService from "./services/relicService";
import * as eeLogMonitor from "./services/eeLogMonitor";
import * as rewardScanner from "./services/rewardScanner";
import * as crashReporter from "./services/crashReporter";
import * as autoUpdater from "./services/autoUpdater";
import * as rivenBestAttributes from "./services/rivenBestAttributes";

import ctx from "./ipc/context";
import * as inventoryIpc from "./ipc/inventoryIpc";
import * as wfmIpc from "./ipc/wfmIpc";
import * as overlayIpc from "./ipc/overlayIpc";
import * as worldStateIpc from "./ipc/worldStateIpc";
import * as messageNotificationIpc from "./ipc/messageNotificationIpc";
import * as systemIpc from "./ipc/systemIpc";
import * as snapshotCacheIpc from "./ipc/snapshotCacheIpc";
import * as rankedHotsetIpc from "./ipc/rankedHotsetIpc";
import * as statsIpc from "./ipc/statsIpc";
import * as rivensIpc from "./ipc/rivensIpc";
import * as tradeNotificationIpc from "./ipc/tradeNotificationIpc";
import { assertMainRendererSender, handleAuthorized } from "./ipc/ipcSecurity";
import {
  HELPER_GET_STATUS, HELPER_RUN_NOW, HELPER_DOWNLOAD, HELPER_DOWNLOAD_PROGRESS,
  INVENTORY_UPDATED, ITEM_DB_UPDATED, TRADE_RECORDED, ARBI_RUN_SAVED,
} from "./config/shared/ipcChannels";
import * as statsTracker from "./services/statsTracker";
import * as arbiRunTracker from "./services/arbiRunTracker";
import { setOcrDebugDumpsEnabled } from "./services/rewardScanDebug";
import * as arbiIpc from "./ipc/arbiIpc";
import * as arbiScheduleIpc from "./ipc/arbiScheduleIpc";
import * as tradeTracker from "./services/tradeTracker";
import * as tradeWfmMatcher from "./services/tradeWfmMatcher";
import * as apiHelperRunner from "./services/apiHelperRunner";
import { isTradeNotificationOverlayEnabled } from "./config/runtime/overlaySettings";
import { WIN_APP_USER_MODEL_ID } from "./config/shared/appMeta";

// Suppress noisy Chromium/DevTools internal logging in terminal.
app.commandLine.appendSwitch("disable-logging");
app.commandLine.appendSwitch("log-level", "3");

// Disable GPU hardware acceleration to prevent Chromium's compositor from keeping
// the discrete GPU active at idle, which causes a significant temperature increase
// (~15-20°C) even with zero CPU usage.  The app's UI is simple enough that software
// rendering is indistinguishable and far more power-efficient.
app.disableHardwareAcceleration();

// Set our AUMID in all modes so toast notifications are associated with
// "WFHelper" in Windows Settings -> Notifications, and Focus Assist
// "Priority only" mode recognises us as a proper app.  A matching Start Menu
// shortcut is created in worldStateIpc.register() so Windows has the full
// AUMID -> shortcut mapping that desktop-app toasts require.
if (process.platform === "win32") {
  app.setAppUserModelId(WIN_APP_USER_MODEL_ID);
}

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
    icon: path.join(app.getAppPath(), "assets", "logo.ico"),
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

  // Block page reload shortcuts (Ctrl+R, Ctrl+Shift+R, F5) to prevent breaking app state.
  ctx.mainWindow.webContents.on(
    "before-input-event",
    (event: { preventDefault: () => void }, input: { type?: string; key?: string; control?: boolean; meta?: boolean; shift?: boolean }) => {
      if (input.type !== "keyDown") return;
      const ctrl = input.control || input.meta;
      if ((ctrl && input.key === "r") || (ctrl && input.key === "R") || input.key === "F5") {
        event.preventDefault();
      }
    },
  );

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
    log.info(`[StartupProfile][main] ${label}: ${Date.now() - startedAt}ms`);
  };

  log.info(
    `[Startup] userData: ${app.getPath("userData")}` +
      (process.env.WFHELPER_USER_DATA ? " (WFHELPER_USER_DATA override)" : ""),
  );

  const settingsStart = Date.now();
  overlayIpc.loadOverlaySettings();
  profileStage("overlay-settings:load", settingsStart);

  const statsLoadStart = Date.now();
  statsTracker.loadHistory();
  tradeTracker.loadTradeLog();
  arbiRunTracker.initArbiTracker();
  arbiRunTracker.setArbiTrackingEnabled(ctx.overlaySettings.arbiTrackingEnabled !== false);
  setOcrDebugDumpsEnabled(ctx.overlaySettings.ocrDebugImagesEnabled === true);
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
  arbiIpc.register();
  arbiScheduleIpc.register();

  const attachInventoryAfterHelperRun = (ok: boolean) => {
    if (!ok || ctx.currentInventoryPath) return;
    const discovered = inventoryIpc.findInventoryFile();
    if (!discovered) return;
    ctx.currentInventoryPath = discovered;
    inventoryIpc.watchInventoryFile(discovered);
    log.info("First inventory load detected at:", discovered);
    const data = inventoryIpc.readInventory(discovered);
    if (data && ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send(INVENTORY_UPDATED, data);
    }
  };

  // Helper runner IPC
  handleAuthorized(HELPER_GET_STATUS, assertMainRendererSender, () =>
    apiHelperRunner.getStatus(),
  );
  handleAuthorized(HELPER_RUN_NOW, assertMainRendererSender, async () => {
    const ok = await apiHelperRunner.runOnce();
    attachInventoryAfterHelperRun(ok);
    return { ok };
  });
  handleAuthorized(HELPER_DOWNLOAD, assertMainRendererSender, async () => {
    const ok = await apiHelperRunner.downloadHelper((progress) => {
      if (ctx.mainWindow) {
        ctx.mainWindow.webContents.send(HELPER_DOWNLOAD_PROGRESS, progress);
      }
    });
    if (ok) {
      apiHelperRunner.startPolling(undefined, attachInventoryAfterHelperRun);
    }
    return { ok };
  });

  profileStage("ipc:register", ipcRegisterStart);

  const itemDbStart = Date.now();
  publicExportSource.loadOverlayFromDisk();
  itemDb.buildDatabase();
  profileStage("item-db:build", itemDbStart);

  // Refresh from DE in the background; rebuild if it added anything.
  void publicExportSource
    .refreshOverlayFromDE()
    .then(({ changed }) => {
      if (changed) {
        itemDb.buildDatabase();
        if (ctx.mainWindow) ctx.mainWindow.webContents.send(ITEM_DB_UPDATED);
        log.info("[ItemDB] Rebuilt with refreshed DE public export");
      }
    })
    .catch((err: Error) => log.error("[ItemDB] DE public export refresh failed:", err));

  // Drop tables for the wiki tab: disk cache first, then refresh in background.
  dropData.loadFromDisk();
  void dropData
    .refreshFromUpstream()
    .catch((err: Error) => log.error("[Drops] refresh failed:", err));

  const catalogStart = Date.now();
  wfmCatalog
    .ensureLoaded()
    .catch((err: Error) => log.error("[WFMarket] startup fetch failed:", err));
  profileStage("wfm-catalog:ensureLoaded-dispatch", catalogStart);

  const rivenGoodRollsStart = Date.now();
  void rivenBestAttributes
    .ensureRivenGoodRollsLoaded(true)
    .catch((err: Error) => log.error("[Rivens] startup good-roll fetch failed:", err));
  profileStage("riven-good-rolls:ensureLoaded-dispatch", rivenGoodRollsStart);

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
      log.warn("[WFMSession] restore failed:", err.message);
    });
  profileStage("wfm-session:restore-dispatch", sessionRestoreStart);

  const updaterStart = Date.now();
  autoUpdater.initialize(ctx.mainWindow!);
  profileStage("auto-updater:init", updaterStart);

  const hotkeyStart = Date.now();
  overlayIpc.registerOverlayHotkey();
  profileStage("overlay-hotkey:register", hotkeyStart);

  // warm after startup so it doesn't compete with first paint
  setTimeout(() => {
    try {
      overlayIpc.warmPlannerOverlayWindow();
    } catch (err) {
      log.warn("[Overlay] planner pre-warm failed:", err);
    }
  }, 4000).unref();

  const inventoryDetectStart = Date.now();
  apiHelperRunner.init();
  const found = inventoryIpc.findInventoryFile();
  if (found) {
    ctx.currentInventoryPath = found;
    inventoryIpc.watchInventoryFile(found);
    log.info("Auto-detected inventory at:", found);

    // Auto-load inventory and send to renderer once the page is ready.
    // Guard against a race where did-finish-load fires before this point
    // (local file loads can complete in <100 ms).
    const data = inventoryIpc.readInventory(found);
    if (data && ctx.mainWindow) {
      const wc = ctx.mainWindow.webContents;
      const sendInventory = () => {
        if (ctx.mainWindow) {
          ctx.mainWindow.webContents.send(INVENTORY_UPDATED, data);
        }
      };
      if (wc.isLoading()) {
        wc.once("did-finish-load", sendInventory);
      } else {
        sendInventory();
      }
    }
  }

  // Start helper polling (runs exe every 10 min; chokidar picks up changes).
  // On a first-ever install there's no inventory.json yet, so the watcher
  // above was never installed. After each helper run, if we still have no
  // path, try discovering the freshly-written file and attach to it.
  apiHelperRunner.startPolling(undefined, attachInventoryAfterHelperRun);

  profileStage("inventory:auto-detect", inventoryDetectStart);

  const eeLogStart = Date.now();
  const eeLogPath = eeLogMonitor.startWatching({
    onRewardTrigger: () => overlayIpc.onRelicRewardTrigger("eelog"),
    onRewardUiReady: () => overlayIpc.notifyRewardUiReady(),
    onRelicSelectionOpen: () => overlayIpc.onRelicSelectionTrigger("eelog"),
    onRelicSelectionClose: () => overlayIpc.onRelicSelectionClose(),
    onInGameMessage: (playerName) => void messageNotificationIpc.notifyInGameMessage(playerName),
    onTradeConfirmed: (trade) => {
      const event = tradeTracker.recordTradeFromLog(trade);
      if (!event) return;

      // Push trade to renderer in real-time
      const win = ctx.mainWindow;
      if (win && !win.isDestroyed()) {
        win.webContents.send(TRADE_RECORDED, { trade: event, wfmMatch: null });
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
            win.webContents.send(TRADE_RECORDED, {
              trade: { ...event, wfmClosed: true },
              wfmMatch: match,
            });
          }

          // Show trade notification overlay (if enabled)
          if (isTradeNotificationOverlayEnabled(ctx.overlaySettings)) {
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
    onRivenWeaponPath: (weaponPath: string) => overlayIpc.onRivenWeaponPath(weaponPath),
    onArbiRunSaved: (run) => {
      const win = ctx.mainWindow;
      if (win && !win.isDestroyed()) win.webContents.send(ARBI_RUN_SAVED, run);
      overlayIpc.maybeShowArbiSummary(run);
    },
  });
  if (eeLogPath) log.info("[EELog] Monitoring:", eeLogPath);
  else log.info("[EELog] EE.log not found - relic overlay trigger disabled");
  profileStage("ee-log:watch-start", eeLogStart);

  const rewardItemsStart = Date.now();
  try {
    const db = relicService.getRelicDatabase();
    const seen = new Map();
    for (const group of Object.values(db.groups)) {
      for (const qualData of Object.values(group.qualities)) {
        for (const reward of qualData.rewards || []) {
          if (reward.name && !seen.has(reward.name)) {
            const resolved = itemDb.lookupItemByNameOrSlug(reward.name, reward.urlName);
            const dbEntry =
              resolved?.item || (reward.uniqueName ? itemDb.lookupItem(reward.uniqueName) : null);
            seen.set(reward.name, {
              name: reward.name,
              uniqueName: resolved?.uniqueName || reward.uniqueName || null,
              urlName: reward.urlName || null,
              rarity: reward.rarity || "Common",
              ducats: reward.ducats ?? dbEntry?.ducats ?? null,
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
  apiHelperRunner.stopPolling();
  eeLogMonitor.stopWatching();
  overlayIpc.unregisterOverlayHotkey();
  arbiScheduleIpc.shutdown();
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
