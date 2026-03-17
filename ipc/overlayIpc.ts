import ctx from "./context";
import {
  assertAuthorizedSender,
  assertCropDebugRendererSender,
  assertMainRendererSender,
  assertOverlayRendererSender,
  assertRivenOverlayRendererSender,
  isAuthorizedSender,
} from "./ipcSecurity";
import { createOverlayScanController } from "./overlay/scan";
import { createRelicSelectionController } from "./overlay/relicSelection";
import { createOverlaySettingsController } from "./overlay/settings";
import { createOverlayWindowsController } from "./overlay/windows";
import * as rivenSession from "./overlay/rivenSession";
import * as rivenScan from "./overlay/rivenScan";
import * as rivenGrading from "../services/rivenGrading";
import * as rivenDataSvc from "../services/rivenData";
import * as rivenBestAttributes from "../services/rivenBestAttributes";
import * as wfmRivenSearch from "../services/wfmRivenSearch";
import { createRuntimeRequire } from "./runtimeRequire";
import { withScope } from "../services/logger";
import * as relicService from "../services/relicService";
import * as rewardScanner from "../services/rewardScanner";
import * as wfmStatsPrice from "../services/wfmStatsPrice";
import * as warframeStatus from "../services/warframeStatus";
import { hardenBrowserWindowNavigation } from "../services/windowSecurity";
import { startEscMonitor, stopEscMonitor } from "../services/keyboardMonitor";


const requireRuntime = createRuntimeRequire(__dirname, 1);

const log = withScope("overlayIpc");

const { normalizeErrorMessage } = requireRuntime<{
  normalizeErrorMessage: (err: unknown, fallback?: string) => string;
}>("config/shared/errors.cjs");

const { ipcMain, BrowserWindow, globalShortcut, app, screen, shell } =
  require("electron") as typeof import("electron");
const path = require("node:path") as typeof import("node:path");
const fs = require("node:fs") as typeof import("node:fs");
const {
  OVERLAY_CROP_PRESETS,
  OVERLAY_OCR_ENGINES,
  OVERLAY_SETTINGS_DEFAULTS,
  OVERLAY_SETTINGS_LIMITS,
} = requireRuntime<{
  OVERLAY_CROP_PRESETS: string[];
  OVERLAY_OCR_ENGINES: string[];
  OVERLAY_SETTINGS_DEFAULTS: Record<string, any>;
  OVERLAY_SETTINGS_LIMITS: Record<string, number>;
}>("config/runtime/overlaySettings");

const OVERLAY_SETTINGS_FILE = path.join(app.getPath("userData"), "overlay-settings.json");
const PRICE_CACHE_FILE = path.join(app.getPath("userData"), "price-cache.json");
const APP_ROOT = app.getAppPath();
const OVERLAY_WINDOW_FILE = path.join(APP_ROOT, "renderer", "overlay.html");
const PLANNER_WINDOW_FILE = path.join(APP_ROOT, "renderer", "overlay.html");
const RIVEN_WINDOW_FILE = path.join(APP_ROOT, "renderer", "riven-overlay.html");
const CROP_DEBUG_WINDOW_FILE = path.join(APP_ROOT, "renderer", "crop-debug.html");

const rewardWindowsController = createOverlayWindowsController({
  app,
  BrowserWindow,
  screen,
  ctx,
  log,
  hardenBrowserWindowNavigation,
  overlayWindowFile: OVERLAY_WINDOW_FILE,
  cropDebugWindowFile: CROP_DEBUG_WINDOW_FILE,
});

const plannerWindowsController = createOverlayWindowsController({
  app,
  BrowserWindow,
  screen,
  ctx,
  getOverlayWindow: () => ctx.plannerOverlayWindow,
  setOverlayWindow: (window) => {
    ctx.plannerOverlayWindow = window;
  },
  getOverlayInteractiveMode: () => ctx.overlayInteractiveMode,
  setOverlayInteractiveModeState: (enabled) => {
    ctx.overlayInteractiveMode = !!enabled;
  },
  log,
  hardenBrowserWindowNavigation,
  overlayWindowFile: PLANNER_WINDOW_FILE,
  cropDebugWindowFile: CROP_DEBUG_WINDOW_FILE,
  placement: "top-right",
  windowWidth: 460,
  windowHeight: 320,
});

// ── Riven overlay windows (left = current, right = new roll) ─────────────────

let _rivenInteractive = false;

const RIVEN_WIN_W = 420;
const RIVEN_WIN_H = 640;

/** Returns both riven windows as an array for broadcasting IPC events. */
function getRivenWindows(): (InstanceType<typeof BrowserWindow> | null)[] {
  return [ctx.rivenOverlayLeftWindow, ctx.rivenOverlayRightWindow];
}

/** Run a callback on each live riven window. */
function forEachRivenWindow(fn: (win: InstanceType<typeof BrowserWindow>) => void): void {
  for (const win of getRivenWindows()) {
    if (win && !win.isDestroyed()) fn(win);
  }
}

function toggleRivenInteractiveMode(): void {
  _rivenInteractive = !_rivenInteractive;
  forEachRivenWindow((win) => {
    if (_rivenInteractive) {
      win.setIgnoreMouseEvents(false);
      win.setFocusable(true);
      win.moveTop();
      win.focus();
    } else {
      win.setIgnoreMouseEvents(true);
      win.moveTop();
      win.showInactive();
    }
    win.webContents.send("overlay-interaction-mode", { interactive: _rivenInteractive });
  });
}

function createSingleRivenWindow(
  side: "left" | "right",
  x: number,
  y: number,
  options: { show?: boolean },
): InstanceType<typeof BrowserWindow> {
  const preloadPath = path.join(app.getAppPath(), ".electron-build", "preload-riven.js");
  const win = new BrowserWindow({
    width: RIVEN_WIN_W,
    height: RIVEN_WIN_H,
    x,
    y,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  hardenBrowserWindowNavigation(win, {
    label: `riven overlay ${side} window`,
    allowedFilePaths: [RIVEN_WINDOW_FILE],
    log,
  });

  void win.loadFile(RIVEN_WINDOW_FILE, { search: `side=${side}` });
  win.setAlwaysOnTop(true, "screen-saver");
  win.moveTop();
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // No { forward: true } — forwarding mouse events through a message hook
  // can cause DWM/GPU stalls when combined with fullscreen DirectX games.
  // The riven panels are positioned at screen edges, away from game UI.
  win.setIgnoreMouseEvents(true);

  if (options.show !== false) win.showInactive();

  return win;
}

function createRivenOverlayWindows(options: { show?: boolean } = {}): void {
  // If both already exist, just bring them to front
  const existLeft = ctx.rivenOverlayLeftWindow;
  const existRight = ctx.rivenOverlayRightWindow;
  if (existLeft && !existLeft.isDestroyed() && existRight && !existRight.isDestroyed()) {
    forEachRivenWindow((win) => {
      win.setAlwaysOnTop(true, "screen-saver");
      win.moveTop();
      if (options.show !== false) win.showInactive();
    });
    return;
  }

  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw } = display.workArea;
  const PAD = 16;

  // Destroy stale windows
  if (existLeft && !existLeft.isDestroyed()) existLeft.destroy();
  if (existRight && !existRight.isDestroyed()) existRight.destroy();

  _rivenInteractive = false;

  // Left panel at top-left edge, pushed down to avoid game HUD
  const leftWin = createSingleRivenWindow("left", dx + PAD, dy + 80, options);
  ctx.rivenOverlayLeftWindow = leftWin;
  leftWin.on("closed", () => {
    ctx.rivenOverlayLeftWindow = null;
  });

  // Right panel at top-right edge, pushed down to avoid game HUD
  const rightWin = createSingleRivenWindow("right", dx + dw - RIVEN_WIN_W - PAD, dy + 80, options);
  ctx.rivenOverlayRightWindow = rightWin;
  rightWin.on("closed", () => {
    ctx.rivenOverlayRightWindow = null;
  });
}

// Tracks whether the current session has produced at least one roll result.
let _rivenHasRollResult = false;

// OCR scan timers — scans run after a short delay to let the UI animate.
let _rivenInitialScanTimer: ReturnType<typeof setTimeout> | null = null;
let _rivenRollScanTimer: ReturnType<typeof setTimeout> | null = null;

// Delay before OCR scan (ms) — gives the riven card animation time to settle.
// INITIAL: The riven card is already visible when OmegaRerollSelection.swf loads;
// a short delay is enough for the UI to finish rendering.
// ROLL: The roll animation is slow (card flip, particle effects) — needs a generous delay.
// CHOICE_RESCAN: After the "Cycle Riven into current selection?" confirm, the game
// quickly transitions back to the single-card view — shorter delay than a full roll.
const INITIAL_SCAN_DELAY_MS = 800;
const ROLL_SCAN_DELAY_MS = 3000;
const CHOICE_RESCAN_DELAY_MS = 1200;

// Last known stats for choice detection (old vs new)
let _rivenInitialStats: rivenScan.RivenStat[] = [];
let _rivenNewRollStats: rivenScan.RivenStat[] = [];

// Weapon name — starts as "Riven" placeholder, updated when cycle dialog reveals it
let _rivenWeaponName = "";

// ── Riven grading + enrichment ──────────────────────────────────────────────

/**
 * Try to grade stats using the current weapon name.
 * Returns the grading result or null if weapon is unknown/unresolvable.
 */
function tryGradeStats(stats: rivenScan.RivenStat[]): rivenGrading.RivenGradeResult | null {
  if (!_rivenWeaponName || _rivenWeaponName === "Riven" || stats.length === 0) return null;
  return rivenGrading.gradeRiven(_rivenWeaponName, stats);
}

/**
 * Send grading data for initial stats to the overlay.
 * Called when we have both weapon name AND initial stats.
 */
function sendGradedInitialStats(): void {
  const graded = tryGradeStats(_rivenInitialStats);
  if (graded) {
    forEachRivenWindow((win) => {
      if (!win.isDestroyed()) win.webContents.send("riven-grading-initial", graded);
    });
  }
}

/**
 * Send best attributes and trigger WFM search when weapon name becomes available.
 */
function sendWeaponEnrichment(): void {
  if (!_rivenWeaponName || _rivenWeaponName === "Riven") return;

  // Send best attributes to both panels
  const category = rivenDataSvc.getWeaponCategory(_rivenWeaponName);
  const weaponInfo = category ? rivenBestAttributes.getBestAttributes(category) : null;
  if (weaponInfo) {
    forEachRivenWindow((win) => {
      if (!win.isDestroyed()) win.webContents.send("riven-best-attributes", weaponInfo);
    });
  }

  // Trigger WFM search in background (both panels)
  const slug = rivenDataSvc.getRivenFamilySlug(_rivenWeaponName);
  wfmRivenSearch
    .searchSimilarRivens(slug, { limit: 6 })
    .then((listings) => {
      if (listings.length > 0) {
        forEachRivenWindow((win) => {
          if (!win.isDestroyed()) win.webContents.send("riven-similar-listings", listings);
        });
      }
    })
    .catch((err) => {
      log.warn("[WfmRivenSearch] search failed:", String(err));
    });
}

function clearRivenScanTimers(): void {
  if (_rivenInitialScanTimer) { clearTimeout(_rivenInitialScanTimer); _rivenInitialScanTimer = null; }
  if (_rivenRollScanTimer) { clearTimeout(_rivenRollScanTimer); _rivenRollScanTimer = null; }
}

function triggerInitialScan(): void {
  if (_rivenInitialScanTimer) clearTimeout(_rivenInitialScanTimer);
  _rivenInitialScanTimer = setTimeout(async () => {
    _rivenInitialScanTimer = null;
    try {
      const { stats, rawText } = await rivenScan.scanInitialCard();
      _rivenInitialStats = stats;

      // Try to extract weapon name from OCR text if not already known
      if (rawText && (!_rivenWeaponName || _rivenWeaponName === "Riven")) {
        const detected = rivenDataSvc.findWeaponInText(rawText);
        if (detected) {
          log.log(`[RivenScan] weapon detected from OCR: "${detected}"`);
          _rivenWeaponName = detected;
          forEachRivenWindow((win) => {
            if (!win.isDestroyed()) win.webContents.send("riven-weapon-update", detected);
          });
          sendWeaponEnrichment();
        }
      }

      if (stats.length > 0) {
        rivenSession.onInitialStats(getRivenWindows(), stats);
        // If weapon name is already known, send grading immediately
        sendGradedInitialStats();
      }
    } catch (err) {
      log.warn("[RivenScan] initial scan failed:", String(err));
    }
  }, INITIAL_SCAN_DELAY_MS);
}

function triggerRollScan(): void {
  if (_rivenRollScanTimer) clearTimeout(_rivenRollScanTimer);
  _rivenRollScanTimer = setTimeout(async () => {
    _rivenRollScanTimer = null;
    try {
      const stats = await rivenScan.scanNewRoll();
      _rivenNewRollStats = stats;
      if (stats.length > 0) {
        _rivenHasRollResult = true;
        // Send as a roll result — left side is the initial stats we already have,
        // right side is the newly scanned roll
        rivenSession.onRollResult(getRivenWindows(), {
          left: _rivenInitialStats,
          right: stats,
        });
        // Send grading for both panels
        const leftGraded = tryGradeStats(_rivenInitialStats);
        const rightGraded = tryGradeStats(stats);
        if (leftGraded || rightGraded) {
          forEachRivenWindow((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send("riven-grading-roll", {
                left: leftGraded,
                right: rightGraded,
              });
            }
          });
        }
      }
    } catch (err) {
      log.warn("[RivenScan] roll scan failed:", String(err));
    }
  }, ROLL_SCAN_DELAY_MS);
}

// triggerChoiceScan was removed — determining which side was chosen via OCR required
// a second full OCR pass (4-6s) on top of the roll scan, causing severe lag after
// pressing CONFIRM.  We don't actually need to know which side was kept: we always
// re-scan the single card that the game shows after the choice, which gives us the
// accurate current stats regardless of which side was selected.

// ── Exported riven callbacks (wired from main.ts via eeLogMonitor) ─────────────

export function onRivenSessionClose(): void {
  log.log("[OverlayRoute] trigger=riven-session-close");
  stopEscMonitor();
  clearRivenScanTimers();
  _rivenHasRollResult = false;
  _rivenInitialStats = [];
  _rivenNewRollStats = [];
  _rivenWeaponName = "";
  _rivenInteractive = false;
  rivenSession.endSession(getRivenWindows());
  forEachRivenWindow((win) => win.hide());
}

export function onRivenChatView(): void {
  log.log("[OverlayRoute] trigger=riven-chat-view (left panel only)");
  // Don't interrupt an active rolling session
  if (_rivenHasRollResult) return;

  _rivenHasRollResult = false;
  _rivenInitialStats = [];
  _rivenNewRollStats = [];
  _rivenWeaponName = "";

  // Create only the left window (or reuse if already exists)
  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy } = display.workArea;
  const PAD = 16;

  const existLeft = ctx.rivenOverlayLeftWindow;
  if (!existLeft || existLeft.isDestroyed()) {
    _rivenInteractive = false;
    const leftWin = createSingleRivenWindow("left", dx + PAD, dy + 80, { show: true });
    ctx.rivenOverlayLeftWindow = leftWin;
    leftWin.on("closed", () => { ctx.rivenOverlayLeftWindow = null; });
  } else {
    existLeft.setAlwaysOnTop(true, "screen-saver");
    existLeft.moveTop();
    existLeft.showInactive();
  }

  // Hide right window if it exists (chat view = left only)
  const existRight = ctx.rivenOverlayRightWindow;
  if (existRight && !existRight.isDestroyed()) existRight.hide();

  // Start session with "Riven" placeholder, no kuva cost
  const wins = [ctx.rivenOverlayLeftWindow];
  rivenSession.startSession(wins, "Riven", 0);
  if (ctx.overlayThemeVars && Object.keys(ctx.overlayThemeVars).length > 0) {
    const vars = { ...ctx.overlayThemeVars };
    const lw = ctx.rivenOverlayLeftWindow;
    if (lw && !lw.isDestroyed()) lw.webContents.send("overlay-theme-vars", vars);
  }
  startEscMonitor(() => onRivenSessionClose());
  triggerInitialScan();
}

export function onRivenSessionOpen(): void {
  log.log("[OverlayRoute] trigger=riven-session");
  _rivenHasRollResult = false;
  _rivenInitialStats = [];
  _rivenNewRollStats = [];
  _rivenWeaponName = "";
  createRivenOverlayWindows({ show: true });
  // Start (or restart) the session — resets roll count, clears panels.
  // Weapon name is "Riven" placeholder until the first cycle dialog reveals it.
  rivenSession.startSession(getRivenWindows(), "Riven", 0);
  if (ctx.overlayThemeVars && Object.keys(ctx.overlayThemeVars).length > 0) {
    const vars = { ...ctx.overlayThemeVars };
    forEachRivenWindow((win) => win.webContents.send("overlay-theme-vars", vars));
  }
  // ESC key closes the riven overlay — uses the same low-level keyboard hook
  // as the relic recommendation overlay (uiohook-napi).
  startEscMonitor(() => onRivenSessionClose());
  triggerInitialScan();
}

export function onRivenRollPending(weapon: string, kuvaPerRoll: number): void {
  _rivenHasRollResult = false;
  // Update weapon name from the cycle dialog text (first time we learn it).
  // Don't call startSession — that would reset the roll count and wipe
  // the stats that the initial scan already populated.
  const isFirstReveal = _rivenWeaponName === "" || _rivenWeaponName === "Riven";
  if (weapon) {
    _rivenWeaponName = weapon;
    forEachRivenWindow((win) => {
      if (!win.isDestroyed()) win.webContents.send("riven-weapon-update", weapon);
    });

    // First time weapon name is revealed → grade existing stats + send enrichment
    if (isFirstReveal) {
      sendGradedInitialStats();
      sendWeaponEnrichment();
    }
  }
}

export function onRivenRollConfirmed(): void {
  rivenSession.onRollConfirmed(getRivenWindows());
  triggerRollScan();
}

export function onRivenChoiceConfirmed(): void {
  // Cancel any in-flight scan timers (e.g. a roll scan that started just before
  // the user pressed CONFIRM very quickly).  Without this, a stale timer could
  // fire after the choice and overwrite the right panel with old roll data.
  clearRivenScanTimers();
  _rivenHasRollResult = false;
  _rivenNewRollStats = [];

  // Tell the renderer immediately: choice was made, reset the right panel.
  rivenSession.onChoiceMade(getRivenWindows(), "unknown");

  // Re-scan the single card the game now shows — uses a center-only crop
  // to avoid capturing stale two-card transition text at screen edges.
  if (_rivenInitialScanTimer) clearTimeout(_rivenInitialScanTimer);
  _rivenInitialScanTimer = setTimeout(async () => {
    _rivenInitialScanTimer = null;
    try {
      const stats = await rivenScan.scanChoiceRescan();
      _rivenInitialStats = stats;
      if (stats.length > 0) {
        rivenSession.onInitialStats(getRivenWindows(), stats);
        sendGradedInitialStats();
      }
    } catch (err) {
      log.warn("[RivenScan] choice rescan failed:", String(err));
    }
  }, CHOICE_RESCAN_DELAY_MS);
}

function pushOverlayInteractionMode(): void {
  const payload = {
    interactive: !!ctx.overlayInteractiveMode,
  };
  rewardWindowsController.sendOverlayEvent("overlay-interaction-mode", payload);
  plannerWindowsController.sendOverlayEvent("overlay-interaction-mode", payload);
}

async function bringOverlayToWarframeDisplayIfAvailable(): Promise<void> {
  try {
    const status = await warframeStatus.getStatus({ force: true });
    if (status?.focusedDisplayId) {
      const anchor = { sourceDisplayId: String(status.focusedDisplayId) };
      rewardWindowsController.setAnchorMeta(anchor);
      plannerWindowsController.setAnchorMeta(anchor);
      rewardWindowsController.positionOverlayWindow(rewardWindowsController.getAnchorMeta());
      plannerWindowsController.positionOverlayWindow(plannerWindowsController.getAnchorMeta());
    }
  } catch {
    // best effort
  }
}

function setOverlayInteractionMode(enabled: boolean, source = "unknown"): void {
  const next = !!enabled;
  const rewardExists = !!(ctx.overlayWindow && !ctx.overlayWindow.isDestroyed());
  const plannerExists = !!(ctx.plannerOverlayWindow && !ctx.plannerOverlayWindow.isDestroyed());
  if (ctx.overlayInteractiveMode === next && (rewardExists || plannerExists)) {
    if (rewardExists) rewardWindowsController.setOverlayInteractiveMode(next);
    if (plannerExists) plannerWindowsController.setOverlayInteractiveMode(next);
    pushOverlayInteractionMode();
    return;
  }

  ctx.overlayInteractiveMode = next;
  if (rewardExists) rewardWindowsController.setOverlayInteractiveMode(next);
  if (plannerExists) plannerWindowsController.setOverlayInteractiveMode(next);
  pushOverlayInteractionMode();
  log.log(`[OverlayInteraction] mode=${next ? "interactive" : "passive"} source=${source}`);
}

function toggleOverlayInteractionMode(source = "unknown"): void {
  const plannerWindow =
    ctx.plannerOverlayWindow && !ctx.plannerOverlayWindow.isDestroyed()
      ? ctx.plannerOverlayWindow
      : null;
  const rewardWindow =
    ctx.overlayWindow && !ctx.overlayWindow.isDestroyed() ? ctx.overlayWindow : null;

  // Check if any riven window is visible
  const rivenLeftWindow =
    ctx.rivenOverlayLeftWindow && !ctx.rivenOverlayLeftWindow.isDestroyed()
      ? ctx.rivenOverlayLeftWindow
      : null;
  const anyRivenVisible =
    (rivenLeftWindow && rivenLeftWindow.isVisible()) ||
    (ctx.rivenOverlayRightWindow && !ctx.rivenOverlayRightWindow.isDestroyed() && ctx.rivenOverlayRightWindow.isVisible());

  // Only consider a window "active" if it is currently visible.
  const activeWindow =
    plannerWindow && plannerWindow.isVisible()
      ? plannerWindow
      : rewardWindow && rewardWindow.isVisible()
        ? rewardWindow
        : anyRivenVisible
          ? rivenLeftWindow
          : null;

  if (!activeWindow) {
    // Nothing is visible — do nothing. This prevents the reward overlay from
    // appearing unexpectedly when Ctrl+Tab is pressed after closing the planner.
    return;
  }

  // If any riven overlay is visible, toggle interactive mode on both riven windows.
  if (anyRivenVisible) {
    toggleRivenInteractiveMode();
  }

  setOverlayInteractionMode(!ctx.overlayInteractiveMode, source);
}

function ensureOverlayWindowPrimed(): void {
  rewardWindowsController.createOverlayWindow({ show: false });
  plannerWindowsController.createOverlayWindow({ show: false });
  rewardWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
  plannerWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
  pushOverlayInteractionMode();
  pushOverlayThemeVars();
}

let scanController = createOverlayScanController({
  log,
  rewardScanner,
  ctx,
  windows: rewardWindowsController,
  warframeStatus,
});

async function openOcrCropDebugger(source = "manual") {
  const frame = await rewardScanner.captureDebugFrame();
  if (!frame) {
    const msg = "Could not capture Warframe screen for crop debug.";
    log.warn("[CropDebug] open failed:", msg);
    return { ok: false, error: msg };
  }

  rewardWindowsController.createCropDebugWindow(frame);
  log.log(`[CropDebug] opened from ${source}`);
  return { ok: true, settings: { ...ctx.overlaySettings } };
}

const OVERLAY_THEME_VAR_ALLOWLIST = new Set([
  "--bg-deep",
  "--bg-base",
  "--bg-surface",
  "--bg-raised",
  "--bg-hover",
  "--accent",
  "--accent-dim",
  "--accent-bright",
  "--accent-glow",
  "--text-primary",
  "--text-secondary",
  "--text-muted",
  "--success",
  "--warning",
  "--danger",
  "--info",
  "--border",
  "--border-strong",
  "--font-display",
  "--font-body",
  "--font-heading-size",
  "--font-body-size",
  "--font-small-size",
]);

function sanitizeOverlayThemeVars(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};

  const input = raw as Record<string, unknown>;
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!OVERLAY_THEME_VAR_ALLOWLIST.has(key)) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    sanitized[key] = trimmed;
  }
  return sanitized;
}

function pushOverlayThemeVars() {
  if (!ctx.overlayThemeVars || Object.keys(ctx.overlayThemeVars).length === 0) return;
  const vars = { ...ctx.overlayThemeVars };
  rewardWindowsController.sendOverlayEvent("overlay-theme-vars", vars);
  plannerWindowsController.sendOverlayEvent("overlay-theme-vars", vars);
  forEachRivenWindow((win) => win.webContents.send("overlay-theme-vars", vars));
}

function onRelicRewardTrigger(source = "manual") {
  log.log(`[OverlayRoute] trigger=reward source=${source}`);
  void bringOverlayToWarframeDisplayIfAvailable();
  rewardWindowsController.createOverlayWindow();
  rewardWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
  pushOverlayInteractionMode();
  pushOverlayThemeVars();
  scanController.onRelicRewardTrigger(source);
}

function onRelicSelectionTrigger(source: string) {
  log.log(`[OverlayRoute] trigger=planner source=${source}`);
  void bringOverlayToWarframeDisplayIfAvailable();
  plannerWindowsController.createOverlayWindow();
  plannerWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
  pushOverlayInteractionMode();
  pushOverlayThemeVars();
  void relicSelectionController.onRelicSelectionTrigger(source);
  startEscMonitor(onRelicSelectionClose);
}

const settingsController = createOverlaySettingsController({
  log,
  fs,
  globalShortcut,
  ctx,
  settingsFile: OVERLAY_SETTINGS_FILE,
  defaults: OVERLAY_SETTINGS_DEFAULTS,
  limits: OVERLAY_SETTINGS_LIMITS,
  cropPresets: OVERLAY_CROP_PRESETS,
  ocrEngines: OVERLAY_OCR_ENGINES,
  rewardScanner,
  onRelicRewardTrigger,
  onToggleOverlayInteractionMode: toggleOverlayInteractionMode,
  onOpenCropDebugger: openOcrCropDebugger,
});

scanController = createOverlayScanController({
  log,
  rewardScanner,
  ctx,
  windows: rewardWindowsController,
  warframeStatus,
});

const relicSelectionController = createRelicSelectionController({
  log,
  ctx,
  windows: plannerWindowsController,
  relicService,
  rewardScanner,
  wfmStatsPrice,
  warframeStatus,
  fs,
  cacheFilePath: PRICE_CACHE_FILE,
});

function onRelicSelectionClose(): void {
  stopEscMonitor();
  const win = ctx.plannerOverlayWindow;
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  // Do NOT call suppressReopenForClose here — the EE.log-based close fires for
  // dialog navigation (including entering the relic selection area), so suppressing
  // reopen would block the overlay on the very next PopulateInventoryGrid event.
  // suppressReopenForClose is reserved for explicit user close (the X button / overlay-close IPC).
  plannerWindowsController.clearOverlayAutoHideTimer();
  ctx.overlayInteractiveMode = false;
  pushOverlayInteractionMode();
  win.hide();
  log.log("[OverlayClose] planner closed via ESC / Dialog::SendResult");
}

function register(): void {
  ensureOverlayWindowPrimed();
  setTimeout(() => {
    if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) {
      ctx.overlayWindow.hide();
    }
    if (ctx.plannerOverlayWindow && !ctx.plannerOverlayWindow.isDestroyed()) {
      ctx.plannerOverlayWindow.hide();
    }
  }, 150);

  ipcMain.on("overlay-close", (event: unknown) => {
    if (!isAuthorizedSender(assertOverlayRendererSender, event as never, "overlay-close")) return;
    stopEscMonitor();
    rewardWindowsController.clearOverlayAutoHideTimer();
    plannerWindowsController.clearOverlayAutoHideTimer();
    relicSelectionController.suppressReopenForClose?.();

    // Reset interactive mode so the next trigger opens the overlay in passive mode.
    ctx.overlayInteractiveMode = false;
    pushOverlayInteractionMode();

    const senderId = Number((event as { sender?: { id?: number } } | null)?.sender?.id || 0);
    if (
      ctx.plannerOverlayWindow &&
      !ctx.plannerOverlayWindow.isDestroyed() &&
      senderId === ctx.plannerOverlayWindow.webContents.id
    ) {
      ctx.plannerOverlayWindow.hide();
      return;
    }

    if (ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()) {
      ctx.overlayWindow.hide();
    }
  });

  ipcMain.on("riven-overlay-close", (event: unknown) => {
    if (
      !isAuthorizedSender(
        assertRivenOverlayRendererSender,
        event as never,
        "riven-overlay-close",
      )
    ) {
      return;
    }
    stopEscMonitor();
    clearRivenScanTimers();
    _rivenInteractive = false;
    _rivenHasRollResult = false;
    _rivenInitialStats = [];
    _rivenNewRollStats = [];
    rivenSession.endSession(getRivenWindows());
    forEachRivenWindow((win) => win.hide());
  });

  ipcMain.on("riven-open-auction", (event: unknown, auctionId: unknown) => {
    if (
      !isAuthorizedSender(
        assertRivenOverlayRendererSender,
        event as never,
        "riven-open-auction",
      )
    ) {
      return;
    }
    const id = String(auctionId || "").replace(/[^a-zA-Z0-9]/g, "");
    if (id) {
      void shell.openExternal(`https://warframe.market/auction/${id}`);
    }
  });

  ipcMain.on("crop-debug-close", (event: unknown) => {
    if (!isAuthorizedSender(assertCropDebugRendererSender, event as never, "crop-debug-close")) {
      return;
    }
    if (ctx.cropDebugWindow && !ctx.cropDebugWindow.isDestroyed()) {
      ctx.cropDebugWindow.close();
    }
  });

  ipcMain.handle("overlay-get-relic-items", async (event: unknown) => {
    assertAuthorizedSender(assertOverlayRendererSender, event as never, "overlay-get-relic-items");

    const db = relicService.getRelicDatabase();
    const seen = new Map<string, { name: string; urlName: string | null; rarity: string }>();
    for (const group of Object.values(db.groups)) {
      if (!group.qualities) continue;
      for (const qualData of Object.values(group.qualities)) {
        if (!qualData?.rewards) continue;
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

  ipcMain.handle("overlay:get-settings", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "overlay:get-settings");
    return { ...ctx.overlaySettings };
  });

  ipcMain.handle("overlay:get-price", async (event: unknown, slug: string) => {
    assertAuthorizedSender(assertOverlayRendererSender, event as never, "overlay:get-price");
    return wfmStatsPrice.fetchPriceBySlug(slug);
  });

  ipcMain.handle("overlay:get-theme-vars", async (event: unknown) => {
    assertAuthorizedSender(assertOverlayRendererSender, event as never, "overlay:get-theme-vars");
    return { ...(ctx.overlayThemeVars || {}) };
  });

  ipcMain.handle("overlay:set-settings", async (event: unknown, nextSettings: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "overlay:set-settings");

    const settings = settingsController.setOverlaySettings(nextSettings);
    settingsController.registerOverlayHotkey();
    return settings;
  });

  ipcMain.handle("overlay:open-crop-debugger", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "overlay:open-crop-debugger");
    return openOcrCropDebugger("ipc");
  });

  ipcMain.handle("overlay:apply-crop-selection", async (event: unknown, selection: unknown) => {
    assertAuthorizedSender(
      assertCropDebugRendererSender,
      event as never,
      "overlay:apply-crop-selection",
    );

    try {
      const settings = settingsController.applyCropSelection(selection);
      return { ok: true, settings };
    } catch (err) {
      log.error("[CropDebug] apply selection failed:", normalizeErrorMessage(err));
      return {
        ok: false,
        error: normalizeErrorMessage(err),
      };
    }
  });

  ipcMain.on("toggle-overlay", (event: unknown) => {
    if (!isAuthorizedSender(assertMainRendererSender, event as never, "toggle-overlay")) return;

    rewardWindowsController.clearOverlayAutoHideTimer();
    if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) {
      rewardWindowsController.createOverlayWindow();
      rewardWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
      pushOverlayInteractionMode();
      pushOverlayThemeVars();
    } else if (ctx.overlayWindow.isVisible()) {
      ctx.overlayWindow.hide();
    } else {
      rewardWindowsController.positionOverlayWindow(rewardWindowsController.getAnchorMeta());
      rewardWindowsController.setOverlayInteractiveMode(ctx.overlayInteractiveMode);
      pushOverlayInteractionMode();
      pushOverlayThemeVars();
      ctx.overlayWindow.showInactive();
    }
  });

  ipcMain.on("overlay-theme-updated", (event: unknown, rawVars: unknown) => {
    if (!isAuthorizedSender(assertMainRendererSender, event as never, "overlay-theme-updated")) {
      return;
    }

    const sanitized = sanitizeOverlayThemeVars(rawVars);
    ctx.overlayThemeVars = sanitized;
    log.log(`[OverlayTheme] updated vars=${Object.keys(sanitized).length}`);
    if (Object.keys(sanitized).length > 0) {
      pushOverlayThemeVars();
    }
  });

  ipcMain.on("simulate-relic-trigger", (event: unknown) => {
    if (!isAuthorizedSender(assertMainRendererSender, event as never, "simulate-relic-trigger")) {
      return;
    }
    onRelicRewardTrigger("simulate");
  });

  ipcMain.on("overlay:push-relic-filters", (event: unknown, rawFilters: unknown) => {
    if (
      !isAuthorizedSender(
        assertMainRendererSender,
        event as never,
        "overlay:push-relic-filters",
      )
    ) {
      return;
    }

    if (!rawFilters || typeof rawFilters !== "object") return;
    const filters = rawFilters as Record<string, unknown>;
    relicSelectionController.setDesktopFilters({
      squadSize: typeof filters.squadSize === "number" ? filters.squadSize : undefined,
      tierFilter: typeof filters.tierFilter === "string" ? filters.tierFilter : null,
    });
  });
}

export const loadOverlaySettings = settingsController.loadOverlaySettings;
export const registerOverlayHotkey = settingsController.registerOverlayHotkey;
export const unregisterOverlayHotkey = settingsController.unregisterOverlayHotkey;

export {
  register,
  settingsController,
  onRelicRewardTrigger,
  onRelicSelectionTrigger,
  onRelicSelectionClose,
  openOcrCropDebugger,
};
