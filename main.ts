import "./config/runtime/appIdentity";

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow, crashReporter, globalShortcut, powerMonitor } from "electron";

import * as linuxDisplay from "./services/linuxDisplayBackend";
import { layerOutputRects, probeLayerShell } from "./services/layerShell";

const DISPLAY_BACKEND = linuxDisplay.initialize(
  app.getPath("userData"),
  process.env,
  process.platform,
  app.getVersion(),
  process.argv,
);
// Ozone reads its platform before this script runs, so appendSwitch alone never
// joins XWayland; re-exec once with the flag in argv instead.
const OZONE_X11_ARG = "--ozone-platform=x11";
// A platform already in argv wins, so it also decides whether we re-exec: adding
// a second one would leave the real platform up to chromium's argument order.
const OZONE_PLATFORM_ARG = process.argv.find((arg) => arg.startsWith("--ozone-platform="));
const JOINED_XWAYLAND = OZONE_PLATFORM_ARG === OZONE_X11_ARG;
// Only a re-exec that should have happened and did not is a failure. A platform
// the caller pinned by hand is their choice, not this machine refusing XWayland.
const XWAYLAND_REEXEC_FAILED = DISPLAY_BACKEND === "x11" && OZONE_PLATFORM_ARG === undefined;
if (DISPLAY_BACKEND === "x11") {
  app.commandLine.appendSwitch("ozone-platform", "x11");
  if (!OZONE_PLATFORM_ARG) {
    // app.relaunch() is a no-op this early, and the AppImage mount dies with us.
    const selfPath = process.env.APPIMAGE || process.execPath;
    try {
      // spawn reports a bad path asynchronously, after exit - so probe it first.
      if (fs.existsSync(selfPath)) {
        spawn(selfPath, [...process.argv.slice(1), OZONE_X11_ARG], {
          detached: true,
          stdio: "inherit",
        }).unref();
        app.exit(0);
      }
    } catch {
      // Starting on the wayland default beats not starting at all.
    }
  }
}

import { getLogFilePath, withScope } from "./services/logger";
import { resolveWarframeUiScale } from "./services/eeLogPath";
import { MAIN_WINDOW_CSP, PERMISSIONS_POLICY } from "./config/runtime/security";
import * as windowSecurity from "./services/windowSecurity";

const log = withScope("Main");

const MAIN_WINDOW_ENTRY_FILE = path.join(app.getAppPath(), "renderer", "dist", "index.html");

// Safe mode drops every user-authored layer (custom CSS, stored layouts) for one
// load, so a broken customisation cannot lock the user out of Settings. The env
// var is the same switch for tests, which cannot add argv to a packaged launch.
const SAFE_MODE_LAUNCH =
  process.argv.includes("--safe-mode") || process.env.WFHELPER_SAFE_MODE === "1";

import * as itemDb from "./services/itemDatabase";
import * as publicExportSource from "./services/publicExportSource";
import * as dropData from "./services/dropData";
import * as wfmCatalog from "./services/wfmCatalog";
import * as wfmSession from "./services/wfmSession";
import * as wfmPresence from "./services/wfmPresence";
import * as relicService from "./services/relicService";
import * as eeLogMonitor from "./services/eeLogMonitor";
import * as rewardScanner from "./services/rewardScanner";
import * as rewardOcrOnnx from "./services/rewardOcrOnnx";
import * as autoUpdater from "./services/autoUpdater";
import * as rivenBestAttributes from "./services/rivenBestAttributes";
import * as warframeStatus from "./services/warframeStatus";
import * as marketAlerts from "./services/marketAlerts";

import ctx from "./ipc/context";
import * as inventoryIpc from "./ipc/inventoryIpc";
import * as wfmIpc from "./ipc/wfmIpc";
import * as overlayIpc from "./ipc/overlayIpc";
import * as rewardOverlayIpc from "./ipc/rewardOverlayIpc";
import * as rivenOverlayIpc from "./ipc/rivenOverlayIpc";
import * as arbiOverlayIpc from "./ipc/arbiOverlayIpc";
import * as worldStateIpc from "./ipc/worldStateIpc";
import * as messageNotificationIpc from "./ipc/messageNotificationIpc";
import * as systemIpc from "./ipc/systemIpc";
import * as snapshotCacheIpc from "./ipc/snapshotCacheIpc";
import * as rankedHotsetIpc from "./ipc/rankedHotsetIpc";
import * as statsIpc from "./ipc/statsIpc";
import * as rivensIpc from "./ipc/rivensIpc";
import * as tradeNotificationIpc from "./ipc/tradeNotificationIpc";
import * as notificationLogIpc from "./ipc/notificationLogIpc";
import * as notificationChannelsIpc from "./ipc/notificationChannelsIpc";
import * as marketAlertsIpc from "./ipc/marketAlertsIpc";
import * as inventorySelectionIpc from "./ipc/inventorySelectionIpc";
import * as tradeWorkflow from "./ipc/tradeWorkflow";
import * as tradeWorkbenchIpc from "./ipc/tradeWorkbenchIpc";
import * as tradeLedgerIpc from "./ipc/tradeLedgerIpc";
import * as popoutIpc from "./ipc/popoutIpc";
import * as trayIpc from "./ipc/trayIpc";
import { isQuitting, markQuitting, shouldHideOnClose } from "./services/appLifecycle";
import { applyMainWindowZoom } from "./ipc/mainWindowZoom";
import { assertMainRendererSender, handleAuthorized } from "./ipc/ipcSecurity";
import {
  HELPER_GET_STATUS,
  HELPER_RUN_NOW,
  HELPER_DOWNLOAD,
  HELPER_DOWNLOAD_PROGRESS,
  INVENTORY_UPDATED,
  ITEM_DB_UPDATED,
  ARBI_RUN_SAVED,
  PT_RUN_SAVED,
  WARFRAME_UI_SCALE_UPDATED,
} from "./config/shared/ipcChannels";
import * as statsTracker from "./services/statsTracker";
import * as arbiRunTracker from "./services/arbiRunTracker";
import * as ptRunTracker from "./services/profitTakerTracker";
import { setOcrDebugDumpsEnabled } from "./services/rewardScanDebug";
import * as arbiIpc from "./ipc/arbiIpc";
import * as profitTakerIpc from "./ipc/profitTakerIpc";
import * as arbiScheduleIpc from "./ipc/arbiScheduleIpc";
import * as tradeTracker from "./services/tradeTracker";
import * as apiHelperRunner from "./services/apiHelperRunner";
import * as inventorySync from "./services/inventorySync";
import { disposeLinuxStreamCapture } from "./services/linuxStreamCapture";
import { loadMainWindowState, saveMainWindowState } from "./services/mainWindowState";
import { WIN_APP_USER_MODEL_ID } from "./config/shared/appMeta";
import {
  applyInjectionGuardForStartup,
  describeKnownInjectors,
  listForeignModules,
  type InjectionGuardResult,
} from "./services/processMitigation";
import {
  beginSession,
  crashDumpsFromPreviousSession,
  endSessionCleanly,
} from "./services/sessionHealth";

// Keep native crash dumps local under userData\Crashes.
crashReporter.start({ uploadToServer: false });

// Applied at the top of the ready handler, before any window: a hooked DLL that
// is already inside cannot be evicted. A second instance never gets here, and
// must not, since loading koffi only to quit again fast-fails on teardown.
let injectionGuard: InjectionGuardResult = "off";

// Suppress noisy Chromium/DevTools internal logging in terminal.
app.commandLine.appendSwitch("disable-logging");
app.commandLine.appendSwitch("log-level", "3");

// Software compositing avoids idle GPU use; grayscale text avoids LCD color fringes.
// Its X11 presenter can fail under XWayland, so WFHELPER_ENABLE_GPU=1 keeps the GPU path.
app.commandLine.appendSwitch("disable-lcd-text");
const GPU_ACCELERATION_ENABLED = process.env.WFHELPER_ENABLE_GPU === "1";
if (!GPU_ACCELERATION_ENABLED) app.disableHardwareAcceleration();

// Windows uses the AUMID for notification settings and Focus Assist.
if (process.platform === "win32") {
  app.setAppUserModelId(WIN_APP_USER_MODEL_ID);
}

process.on("uncaughtException", (err: Error) => {
  log.error("[Main] uncaughtException:", err);
});

process.on("unhandledRejection", (reason: unknown) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  log.error("[Main] unhandledRejection:", error);
});

// Grace after the renderer loads, then an absolute cap, before showing anyway.
const MAIN_WINDOW_SHOW_GRACE_MS = 2_000;
const MAIN_WINDOW_SHOW_DEADLINE_MS = 15_000;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  // A second launch means "bring the app up", so a destroyed window is recreated.
  app.on("second-instance", () => revealMainWindow());
}

const MAIN_WINDOW_MIN_SIZE = { width: 900, height: 600 };

// Shared by the tray's Show item, a second launch and macOS activate: after a
// hide-on-close the window is only hidden, but it can also have been destroyed
// since.
function revealMainWindow(): void {
  const window = ctx.mainWindow;
  if (!window || window.isDestroyed()) {
    createWindow();
    // The updater keeps the window it was handed at startup; without this the
    // recreated one never receives an update state.
    if (ctx.mainWindow) autoUpdater.initialize(ctx.mainWindow);
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

// Hiding keeps the main process alive, so its watchers and notifications carry
// on. The hidden renderer is background-throttled, so its timers do not.
function keepRunningInTray(): boolean {
  return shouldHideOnClose({
    keepRunning: ctx.overlaySettings.keepRunningOnClose === true,
    quitting: isQuitting(),
    trayAvailable: trayIpc.isTrayActive(),
  });
}

function createWindow(): void {
  const savedState = loadMainWindowState(MAIN_WINDOW_MIN_SIZE);
  ctx.mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: MAIN_WINDOW_MIN_SIZE.width,
    minHeight: MAIN_WINDOW_MIN_SIZE.height,
    ...(savedState
      ? { x: savedState.x, y: savedState.y, width: savedState.width, height: savedState.height }
      : {}),
    show: false,
    backgroundColor: "#060a12",
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

  const mainWindow = ctx.mainWindow;
  // ready-to-show can silently never fire on Linux, leaving the window hidden
  // forever, so first load and a hard deadline show it too.
  let mainWindowShowTimer: ReturnType<typeof setTimeout> | null = null;
  let windowShown = false;
  const showMainWindow = (via: string): void => {
    if (windowShown || mainWindow.isDestroyed()) return;
    windowShown = true;
    if (mainWindowShowTimer) clearTimeout(mainWindowShowTimer);
    mainWindowShowTimer = null;
    if (via !== "ready-to-show") log.warn(`[Main] window shown via ${via} fallback`);
    if (savedState?.maximized) mainWindow.maximize();
    mainWindow.show();
  };
  const scheduleShow = (delayMs: number, via: string): void => {
    if (windowShown) return;
    if (mainWindowShowTimer) clearTimeout(mainWindowShowTimer);
    mainWindowShowTimer = setTimeout(() => showMainWindow(via), delayMs);
  };

  scheduleShow(MAIN_WINDOW_SHOW_DEADLINE_MS, "deadline");
  mainWindow.once("ready-to-show", () => showMainWindow("ready-to-show"));
  mainWindow.webContents.once("did-finish-load", () => {
    scheduleShow(MAIN_WINDOW_SHOW_GRACE_MS, "did-finish-load");
  });
  void mainWindow
    .loadFile(MAIN_WINDOW_ENTRY_FILE, SAFE_MODE_LAUNCH ? { query: { safe: "1" } } : {})
    .catch((error: unknown) => {
      log.error("[Main] Failed to load the renderer:", error);
      showMainWindow("load-error");
    });

  // Zoom resets on navigation, so re-apply on load; on move, to re-fit per display.
  ctx.mainWindow.webContents.on("did-finish-load", applyMainWindowZoom);
  ctx.mainWindow.on("moved", applyMainWindowZoom);

  // Debounced saves cover crashes; close catches the final position.
  let stateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  const queueStateSave = (): void => {
    if (stateSaveTimer) clearTimeout(stateSaveTimer);
    stateSaveTimer = setTimeout(() => saveMainWindowState(mainWindow), 1000);
  };
  mainWindow.on("move", queueStateSave);
  mainWindow.on("resize", queueStateSave);
  mainWindow.on("close", (event) => {
    if (stateSaveTimer) clearTimeout(stateSaveTimer);
    stateSaveTimer = null;
    saveMainWindowState(mainWindow);
    if (!keepRunningInTray()) return;
    event.preventDefault();
    mainWindow.hide();
  });

  // Block page reload shortcuts (Ctrl+R, Ctrl+Shift+R, F5) to prevent breaking app state.
  ctx.mainWindow.webContents.on(
    "before-input-event",
    (
      event: { preventDefault: () => void },
      input: { type?: string; key?: string; control?: boolean; meta?: boolean; shift?: boolean },
    ) => {
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
    if (mainWindowShowTimer) clearTimeout(mainWindowShowTimer);
    mainWindowShowTimer = null;
    ctx.mainWindow = null;
    if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) ctx.overlayWindow.destroy();
    if (ctx.rivenOverlayLeftWindow && !ctx.rivenOverlayLeftWindow.isDestroyed())
      ctx.rivenOverlayLeftWindow.destroy();
    if (ctx.rivenOverlayRightWindow && !ctx.rivenOverlayRightWindow.isDestroyed())
      ctx.rivenOverlayRightWindow.destroy();
    disposeLinuxStreamCapture();
    app.quit();
  });
}

type ProfileStage = (label: string, startedAt: number) => void;

function logStartupPaths(profileStage: ProfileStage): void {
  log.info(
    `[Startup] userData: ${app.getPath("userData")}` +
      (process.env.WFHELPER_USER_DATA ? " (WFHELPER_USER_DATA override)" : ""),
  );
  log.info(`[Startup] crashDumps: ${app.getPath("crashDumps")}`);
  // Printed so a support request can name the exact file instead of guessing.
  log.info(`[Startup] logFile: ${getLogFilePath() || "unknown"}`);
  if (process.platform === "linux") {
    // Tiling decides whether overlays unmap or stay mapped, so the startup
    // line carries it.
    log.info(
      `[Startup] display=${DISPLAY_BACKEND} gpu=${GPU_ACCELERATION_ENABLED ? "on" : "off"}` +
        ` tiling=${linuxDisplay.isTilingCompositor()}`,
    );
  }
  reportSessionHealth(profileStage);
}

// A native crash leaves no error and no log line, so the previous run is judged
// by what it left behind; injectors are only worth naming once something died.
function reportSessionHealth(profileStage: ProfileStage): void {
  log.info(`[Startup] injection guard: ${injectionGuard}`);

  const foreignStart = Date.now();
  const foreign = listForeignModules();
  profileStage("foreign-modules:scan", foreignStart);
  // Names only here: a full path carries the Windows username and main.log gets
  // pasted into support threads. The crash path below keeps full paths on purpose.
  if (foreign.length > 0) {
    log.info(
      `[Startup] foreign modules loaded: ${foreign.map((f) => path.basename(f)).join(", ")}`,
    );
  }

  const previous = beginSession(app.getPath("userData"));
  if (previous !== "unclean") return;

  const dumps = crashDumpsFromPreviousSession(app.getPath("crashDumps"));
  log.warn(
    `[Startup] previous session ended without shutting down` +
      (dumps.length > 0 ? `; crash dump: ${dumps[0]}` : " (no crash dump)"),
  );
  if (foreign.length > 0) log.warn(`[Startup] foreign module paths: ${foreign.join(", ")}`);

  const injectors = describeKnownInjectors(foreign);
  if (injectors.length > 0) {
    log.warn(
      `[Startup] software known to crash its host is injected here: ${injectors.join(", ")}. ` +
        "Disabling its overlay, or excluding WFHelper from it, is the fix.",
    );
  }
}

function initTrackersAndSettings(profileStage: ProfileStage): void {
  const settingsStart = Date.now();
  overlayIpc.loadOverlaySettings();
  profileStage("overlay-settings:load", settingsStart);

  const statsLoadStart = Date.now();
  statsTracker.loadHistory();
  tradeTracker.loadTradeLog();
  arbiRunTracker.initArbiTracker();
  arbiRunTracker.setArbiTrackingEnabled(ctx.overlaySettings.arbiTrackingEnabled !== false);
  ptRunTracker.initPtTracker();
  // One user-facing toggle covers both EE.log run trackers.
  ptRunTracker.setPtTrackingEnabled(ctx.overlaySettings.arbiTrackingEnabled !== false);
  trayIpc.configureTray(revealMainWindow);
  if (ctx.overlaySettings.keepRunningOnClose === true) trayIpc.createTray();
  setOcrDebugDumpsEnabled(ctx.overlaySettings.ocrDebugImagesEnabled !== false);
  wfmPresence.setOptions({
    autoIngameEnabled: ctx.overlaySettings.wfmAutoIngameEnabled === true,
    holdMinutes: ctx.overlaySettings.wfmStatusHoldMinutes,
    awayIdleEnabled: ctx.overlaySettings.wfmAwayIdleEnabled === true,
    awayIdleMinutes: ctx.overlaySettings.wfmAwayIdleMinutes,
    awayWhenClosedEnabled: ctx.overlaySettings.wfmAwayWhenClosedEnabled === true,
  });
  inventoryIpc.addInventoryListener((data: Record<string, unknown>) => {
    statsTracker.onInventoryData(data);
  });
  profileStage("stats:load-history", statsLoadStart);
}

function registerIpcHandlers(profileStage: ProfileStage): void {
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
  profitTakerIpc.register();
  arbiScheduleIpc.register();
  notificationLogIpc.register();
  notificationChannelsIpc.register();
  marketAlertsIpc.register();
  tradeWorkbenchIpc.register();
  tradeLedgerIpc.register();
  popoutIpc.register();
  inventorySelectionIpc.register();

  const attachInventoryAfterHelperRun = (ok: boolean) => {
    if (!ok || ctx.currentInventoryPath) return;
    const discovered = inventoryIpc.findInventoryFile();
    if (!discovered) return;
    ctx.currentInventoryPath = discovered;
    inventoryIpc.watchInventoryFile(discovered);
    log.info("First inventory load detected at:", discovered);
    const data = inventoryIpc.readInventory(discovered);
    if (data) popoutIpc.broadcastToRenderers(INVENTORY_UPDATED, data);
  };

  inventorySync.init({
    // Named members, not the namespace: the runner surface stays visible to
    // static analysis instead of looking like dead code.
    runner: {
      startPolling: apiHelperRunner.startPolling,
      stopPolling: apiHelperRunner.stopPolling,
      runAfterGameLogin: apiHelperRunner.runAfterGameLogin,
    },
    getSource: () => inventoryIpc.getInventorySource(),
    isAutoSyncEnabled: () => ctx.overlaySettings.autoInventorySyncEnabled !== false,
    onRunComplete: attachInventoryAfterHelperRun,
  });

  // Helper runner IPC
  handleAuthorized(HELPER_GET_STATUS, assertMainRendererSender, () => ({
    ...apiHelperRunner.getStatus(),
    inventoryLastModified: inventoryIpc.getLoadedInventoryModifiedAt(),
  }));
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
    if (ok) inventorySync.apply("helper download");
    return { ok };
  });

  profileStage("ipc:register", ipcRegisterStart);
}

function initDataSources(profileStage: ProfileStage): void {
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
        popoutIpc.broadcastToRenderers(ITEM_DB_UPDATED);
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
}

function initGameMonitoring(profileStage: ProfileStage): void {
  const inventoryDetectStart = Date.now();
  apiHelperRunner.init();
  const loadedInventory = inventoryIpc.loadInitialInventory();
  if (loadedInventory) {
    log.info("Loaded inventory at:", loadedInventory.path);

    // The renderer may finish loading before inventory discovery completes.
    // (local file loads can complete in <100 ms).
    const data = loadedInventory.data;
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

  // The first helper run can create inventory.json after initial discovery.
  // Re-run discovery after polling so the watcher attaches.
  inventorySync.apply("startup");

  profileStage("inventory:auto-detect", inventoryDetectStart);

  const eeLogStart = Date.now();
  const eeLogPath = eeLogMonitor.startWatching({
    onLoginComplete: () => inventorySync.onGameLogin(),
    onRewardTrigger: (stalenessMs) => overlayIpc.onRelicRewardTrigger("eelog", stalenessMs),
    onRewardUiReady: () => rewardOverlayIpc.notifyRewardUiReady(),
    onEeConfigSaved: () => {
      const win = ctx.mainWindow;
      if (win && !win.isDestroyed()) {
        win.webContents.send(WARFRAME_UI_SCALE_UPDATED, resolveWarframeUiScale());
      }
    },
    onRewardScreenClose: (stalenessMs) => rewardOverlayIpc.notifyRewardScreenClosed(stalenessMs),
    onRelicSelectionOpen: () => overlayIpc.onRelicSelectionTrigger("eelog"),
    onRelicSelectionClose: () => overlayIpc.onRelicSelectionClose(),
    onActiveMissionTag: (tag) => rewardOverlayIpc.setActiveMissionTag(tag),
    onInGameMessage: (playerName) => void messageNotificationIpc.notifyInGameMessage(playerName),
    onTradeConfirmed: (trade) => tradeWorkflow.handleConfirmedTrade(trade),
    onRivenSessionOpen: () => rivenOverlayIpc.onRivenSessionOpen(),
    onRivenSessionClose: () => rivenOverlayIpc.onRivenSessionClose(),
    onRivenRollPending: (weapon: string, cost: number) =>
      rivenOverlayIpc.onRivenRollPending(weapon, cost),
    onRivenRollConfirmed: () => rivenOverlayIpc.onRivenRollConfirmed(),
    onRivenDioramaSetup: () => rivenOverlayIpc.onRivenDioramaSetup(),
    onRivenChoiceConfirmed: () => rivenOverlayIpc.onRivenChoiceConfirmed(),
    onRivenChatView: () => rivenOverlayIpc.onRivenChatView(),
    onRivenWeaponPath: (weaponPath: string) => rivenOverlayIpc.onRivenWeaponPath(weaponPath),
    onArbiRunSaved: (run) => {
      popoutIpc.broadcastToRenderers(ARBI_RUN_SAVED, run);
      arbiOverlayIpc.maybeShowArbiSummary(run);
    },
    onPtRunSaved: (run) => popoutIpc.broadcastToRenderers(PT_RUN_SAVED, run),
  });
  if (eeLogPath) log.info("[EELog] Monitoring:", eeLogPath);
  else log.info("[EELog] EE.log not found - relic overlay trigger disabled");
  profileStage("ee-log:watch-start", eeLogStart);

  const rewardItemsStart = Date.now();
  try {
    rewardScanner.setRelicItems(relicService.getRelicRewardItems());
  } catch (err) {
    log.error("[RewardScanner] Failed to load relic items:", (err as Error).message);
  }
  profileStage("relic-reward-items:prepare", rewardItemsStart);
}

void app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  const startupStartedAt = Date.now();
  const profileStage = (label: string, startedAt: number): void => {
    log.info(`[StartupProfile][main] ${label}: ${Date.now() - startedAt}ms`);
  };

  // Reads the previous outcome without claiming it, so it still has to run ahead
  // of the beginSession() inside logStartupPaths().
  injectionGuard = applyInjectionGuardForStartup(app.getPath("userData"));
  logStartupPaths(profileStage);
  initTrackersAndSettings(profileStage);
  registerIpcHandlers(profileStage);
  initDataSources(profileStage);

  const windowStart = Date.now();
  createWindow();
  profileStage("window:create", windowStart);

  if (DISPLAY_BACKEND === "x11") {
    if (XWAYLAND_REEXEC_FAILED) {
      log.error("[Display] XWayland re-exec did not happen - relaunching on native Wayland");
      linuxDisplay.rememberXWaylandFailure();
      // app.exit() skips will-quit, so the session marker has to be closed here
      // or the relaunched instance reports this restart as a crash. The tray is
      // already up when keepRunningOnClose is set and would outlive the relaunch.
      endSessionAndTray();
      app.relaunch();
      app.exit(0);
    } else if (JOINED_XWAYLAND) {
      log.info("[Display] joined XWayland");
      linuxDisplay.forgetXWaylandFailure();
    } else {
      log.warn(`[Display] running on the platform pinned in argv: ${OZONE_PLATFORM_ARG}`);
    }
  } else if (linuxDisplay.info().fallbackActive) {
    log.warn(
      "[Display] native Wayland fallback active - overlays may misbehave; pin XWayland in Settings to retry",
    );
  } else if (linuxDisplay.info().noXServer) {
    log.warn("[Display] no X server to join - the compositor owns overlay placement and stacking");
  }

  if (process.platform === "linux") {
    // Connects to the compositor, so it is a real startup cost and gets a label.
    // The answer also decides whether overlays present as layer surfaces at all.
    const layerShellStart = Date.now();
    const layerShell = probeLayerShell();
    if (!layerShell) log.info("[LayerShell] addon not present in this build");
    else if (!layerShell.available) log.info("[LayerShell] compositor does not offer the protocol");
    else {
      // Geometry, not just names: picking the game's monitor depends on it, and
      // an unplaced output is why an overlay would land on the wrong screen.
      const rects = layerOutputRects().map(
        (rect) =>
          `${rect.name} ${rect.width}x${rect.height}+${rect.x}+${rect.y}@${rect.scale}x` +
          `${rect.placed ? "" : " (unplaced)"}`,
      );
      log.info(
        `[LayerShell] available, outputs: ${rects.join(", ") || layerShell.outputs.join(", ") || "none"}`,
      );
    }
    profileStage("layer-shell:probe", layerShellStart);
  }

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
  startOverlayHotkeyGate();
  profileStage("overlay-hotkey:register", hotkeyStart);

  // Keep prewarming off the first-paint path.
  setTimeout(() => {
    try {
      rewardOverlayIpc.warmPlannerOverlayWindow();
    } catch (err) {
      log.warn("[Overlay] planner pre-warm failed:", err);
    }
  }, 4000).unref();

  // Load Paddle before the first reward scan needs it.
  setTimeout(() => {
    void rewardOcrOnnx.warmupRewardStripOnnx();
  }, 6000).unref();

  initGameMonitoring(profileStage);

  profileStage("total-main-startup-sequence", startupStartedAt);

  app.on("activate", () => {
    revealMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (keepRunningInTray()) return;
  app.quit();
});

// Release global shortcuts when Warframe exits so they do not affect other apps.
let _hotkeyGateTimer: ReturnType<typeof setInterval> | null = null;
let _hotkeyGameActive = false;

async function syncOverlayHotkeyGate(): Promise<void> {
  try {
    const { isOpen } = await warframeStatus.getStatus();
    if (isOpen === _hotkeyGameActive) return;
    _hotkeyGameActive = isOpen;
    overlayIpc.setOverlayHotkeysActive(isOpen);
    void wfmPresence.syncGameRunning(isOpen);
  } catch {
    // best effort; keep the gate in its current state
  }
}

// The shortest away delay the setting allows is a minute, so a 30s sample is
// fine-grained enough; presence itself decides whether the reading is wanted.
const IDLE_POLL_MS = 30_000;
let _idlePollTimer: ReturnType<typeof setInterval> | null = null;

function startIdlePoll(): void {
  _idlePollTimer = setInterval(() => {
    if (!wfmPresence.needsIdlePolling()) return;
    try {
      wfmPresence.syncIdle(powerMonitor.getSystemIdleTime());
    } catch {
      // best effort; a session without an idle source keeps the last reading
    }
  }, IDLE_POLL_MS);
  _idlePollTimer.unref();
}

function startOverlayHotkeyGate(): void {
  void syncOverlayHotkeyGate();
  _hotkeyGateTimer = setInterval(() => void syncOverlayHotkeyGate(), 3000);
  startIdlePoll();
}

function stopOverlayHotkeyGate(): void {
  if (_hotkeyGateTimer) clearInterval(_hotkeyGateTimer);
  _hotkeyGateTimer = null;
  if (_idlePollTimer) clearInterval(_idlePollTimer);
  _idlePollTimer = null;
}

let _dbwinQuitDone = false;
app.on("before-quit", (event) => {
  // Ahead of every teardown step: the close handler below must not read this
  // quit as a request to hide the window.
  markQuitting();
  inventoryIpc.stopInventoryWatcher();
  apiHelperRunner.stopPolling();
  eeLogMonitor.stopWatching();
  marketAlerts.stopMarketAlerts();
  stopOverlayHotkeyGate();
  overlayIpc.unregisterOverlayHotkey();
  overlayIpc.disposeOverlayHotkeys();
  arbiScheduleIpc.shutdown();
  disposeLinuxStreamCapture();
  // Exiting while the DBWIN worker sits in a koffi wait is a fatal napi error;
  // hold quit until the thread has exited (bounded).
  if (!_dbwinQuitDone) {
    event.preventDefault();
    void eeLogMonitor.dbwinWorkerStopped().finally(() => {
      _dbwinQuitDone = true;
      app.quit();
    });
  }
});

/** Every exit path has to close the session marker (an open one is read as a
 * crash on the next launch) and drop a tray icon that would outlive the process. */
function endSessionAndTray(): void {
  endSessionCleanly();
  trayIpc.destroyTray();
}

app.on("will-quit", () => {
  endSessionAndTray();
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
