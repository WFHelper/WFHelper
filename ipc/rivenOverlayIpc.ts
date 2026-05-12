import ctx from "./context";
import {
  assertRivenOverlayRendererSender,
  onAuthorized,
} from "./ipcSecurity";
import {
  createOverlayWindowBoundsChangeHandler,
  createOverlayWindowsController,
} from "./overlay/windows";
import * as rivenSession from "./overlay/rivenSession";
import * as rivenScan from "./overlay/rivenScan";
import * as rivenGrading from "../services/rivenGrading";
import * as rivenDataSvc from "../services/rivenData";
import * as rivenBestAttributes from "../services/rivenBestAttributes";
import * as wfmRivenSearch from "../services/wfmRivenSearch";
import * as warframeStatus from "../services/warframeStatus";
import { withScope } from "../services/logger";
import { hardenBrowserWindowNavigation } from "../services/windowSecurity";
import { isRivenOverlayEnabled as isRivenOverlaySettingEnabled } from "../config/runtime/overlaySettings";

import { forceEndRivenSession } from "../services/eeLogMonitor";
import { isAllowedExternalHost } from "../config/runtime/security";
import {
  OVERLAY_INTERACTION_MODE,
  RIVEN_OVERLAY_CLOSE, RIVEN_OPEN_AUCTION,
  RIVEN_GRADING_INITIAL, RIVEN_GRADING_ROLL,
  RIVEN_BEST_ATTRIBUTES, RIVEN_SIMILAR_LISTINGS, RIVEN_WEAPON_UPDATE,
} from "../config/shared/ipcChannels";

const log = withScope("rivenOverlayIpc");

import { BrowserWindow, app, screen, shell } from "electron";
import path from "node:path";

const APP_ROOT = app.getAppPath();
const RIVEN_WINDOW_FILE = path.join(APP_ROOT, "renderer", "riven-overlay.html");


let _rivenInteractive = false;
let persistOverlaySettings: (() => void) | null = null;
const rememberOverlayWindowBounds = createOverlayWindowBoundsChangeHandler({
  ctx,
  save: () => {
    persistOverlaySettings?.();
  },
});

const RIVEN_WIN_W = 420;
const RIVEN_WIN_H = 640;
const RIVEN_TOP_OFFSET = 80;

const rivenWindowBaseOptions = {
  app,
  BrowserWindow,
  screen,
  ctx,
  log,
  hardenBrowserWindowNavigation,
  overlayWindowFile: RIVEN_WINDOW_FILE,
  displayMode: "primary" as const,
  windowWidth: RIVEN_WIN_W,
  windowHeight: RIVEN_WIN_H,
  minWindowWidth: RIVEN_WIN_W,
  minWindowHeight: RIVEN_WIN_H,
  topOffset: RIVEN_TOP_OFFSET,
  transparent: false,
  backgroundColor: "#060a12",
  preloadFileName: "preload-riven.js",
  hasShadow: false,
  ignoreMouseEventsForward: false,
};

const rivenLeftWindowsController = createOverlayWindowsController({
  ...rivenWindowBaseOptions,
  getOverlayWindow: () => ctx.rivenOverlayLeftWindow,
  setOverlayWindow: (window) => {
    ctx.rivenOverlayLeftWindow = window;
  },
  getOverlayInteractiveMode: () => _rivenInteractive,
  setOverlayInteractiveModeState: (enabled) => {
    _rivenInteractive = !!enabled;
  },
  windowLabel: "riven overlay left window",
  fileSearch: "side=left",
  placement: "top-left",
  windowStateKey: "rivenLeft",
  onWindowBoundsChanged: rememberOverlayWindowBounds,
});

const rivenRightWindowsController = createOverlayWindowsController({
  ...rivenWindowBaseOptions,
  getOverlayWindow: () => ctx.rivenOverlayRightWindow,
  setOverlayWindow: (window) => {
    ctx.rivenOverlayRightWindow = window;
  },
  getOverlayInteractiveMode: () => _rivenInteractive,
  setOverlayInteractiveModeState: (enabled) => {
    _rivenInteractive = !!enabled;
  },
  windowLabel: "riven overlay right window",
  fileSearch: "side=right",
  placement: "top-right",
  windowStateKey: "rivenRight",
  onWindowBoundsChanged: rememberOverlayWindowBounds,
});

function getRivenWindows(): (InstanceType<typeof BrowserWindow> | null)[] {
  return [ctx.rivenOverlayLeftWindow, ctx.rivenOverlayRightWindow];
}

function forEachRivenWindow(fn: (win: InstanceType<typeof BrowserWindow>) => void): void {
  for (const win of getRivenWindows()) {
    if (win && !win.isDestroyed()) fn(win);
  }
}

function syncRivenWindowZOrder(warframeFocused: boolean): void {
  forEachRivenWindow((win) => {
    if (!win.isVisible()) return;
    if (warframeFocused) {
      win.setSkipTaskbar(true);
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setAlwaysOnTop(true, "screen-saver");
      win.moveTop();
    }
  });
}

function toggleRivenInteractiveMode(): void {
  _rivenInteractive = !_rivenInteractive;
  rivenLeftWindowsController.setOverlayInteractiveMode(_rivenInteractive);
  rivenRightWindowsController.setOverlayInteractiveMode(_rivenInteractive);
  forEachRivenWindow((win) => {
    win.webContents.send(OVERLAY_INTERACTION_MODE, { interactive: _rivenInteractive });
  });
}

export function isRivenInteractiveMode(): boolean {
  return _rivenInteractive;
}

function createRivenWindow(side: "left" | "right", options: { show?: boolean }): void {
  const controller = side === "left" ? rivenLeftWindowsController : rivenRightWindowsController;
  controller.createOverlayWindow(options);
  controller.setOverlayInteractiveMode(_rivenInteractive);
}

export function positionRivenOverlayWindows(): void {
  rivenLeftWindowsController.positionOverlayWindow(rivenLeftWindowsController.getAnchorMeta());
  rivenRightWindowsController.positionOverlayWindow(rivenRightWindowsController.getAnchorMeta());
}

function createRivenOverlayWindows(options: { show?: boolean } = {}): void {
  // If both already exist, just bring them to front
  const existLeft = ctx.rivenOverlayLeftWindow;
  const existRight = ctx.rivenOverlayRightWindow;
  if (existLeft && !existLeft.isDestroyed() && existRight && !existRight.isDestroyed()) {
    if (options.show !== false && (!existLeft.isVisible() || !existRight.isVisible())) {
      existLeft.destroy();
      existRight.destroy();
    } else {
      forEachRivenWindow((win) => {
        win.setSkipTaskbar(true);
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        win.setAlwaysOnTop(true, "screen-saver");
        win.moveTop();
        if (options.show !== false) win.showInactive();
      });
      rivenLeftWindowsController.setOverlayInteractiveMode(_rivenInteractive);
      rivenRightWindowsController.setOverlayInteractiveMode(_rivenInteractive);
      return;
    }
  }

  // Destroy stale windows
  if (existLeft && !existLeft.isDestroyed()) existLeft.destroy();
  if (existRight && !existRight.isDestroyed()) existRight.destroy();

  _rivenInteractive = false;

  createRivenWindow("left", options);
  createRivenWindow("right", options);
}

const rivenZOrderInterval = setInterval(async () => {
  try {
    const status = await warframeStatus.getStatus();
    syncRivenWindowZOrder(status.isFocused);
  } catch {
    // ignore
  }
}, 2000);

app.on("before-quit", () => {
  clearInterval(rivenZOrderInterval);
});

// Tracks whether the current session has produced at least one roll result.
let _rivenHasRollResult = false;

// Serial counter incremented on every new triggerRollScan call.  The async
// scan closure captures it; if a newer scan starts before the old one sends
// results, the old one discards its output rather than overwriting.
let _rollScanSerial = 0;

// OCR scan timers — scans run after a short delay to let the UI animate.
let _rivenInitialScanTimer: ReturnType<typeof setTimeout> | null = null;
let _rivenRollScanTimer: ReturnType<typeof setTimeout> | null = null;

// Riven OCR delays in ms; roll and choice waits allow animation text to settle.
const INITIAL_SCAN_DELAY_MS = 200;
const ROLL_SCAN_DELAY_MS = 2850;
const CHOICE_RESCAN_DELAY_MS = 1200;

// Last known stats for choice detection (old vs new)
let _rivenInitialStats: rivenScan.RivenStat[] = [];
let _rivenNewRollStats: rivenScan.RivenStat[] = [];

// Weapon name — starts as "Riven" placeholder, updated when cycle dialog reveals it
let _rivenWeaponName = "";

function isRivenOverlayEnabled(): boolean {
  return isRivenOverlaySettingEnabled(ctx.overlaySettings);
}


/**
 * Try to grade stats using the current weapon name.
 * Returns the grading result or null if weapon is unknown/unresolvable.
 */
function tryGradeStats(stats: rivenScan.RivenStat[]): rivenGrading.RivenGradeResult | null {
  if (!_rivenWeaponName || _rivenWeaponName === "Riven" || stats.length === 0) return null;
  return rivenGrading.gradeRiven(_rivenWeaponName, stats);
}

function scoreRivenStatSimilarity(
  left: rivenScan.RivenStat[],
  right: rivenScan.RivenStat[],
): number {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) {
    return 0;
  }

  const rightByName = new Map(right.map((stat) => [stat.name.toLowerCase(), stat] as const));

  let score = 0;
  for (const stat of left) {
    const match = rightByName.get(stat.name.toLowerCase());
    if (!match) {
      score -= 4;
      continue;
    }

    score += stat.positive === match.positive ? 12 : 2;
    if (stat.value != null && match.value != null) {
      const base = Math.max(5, Math.abs(stat.value), Math.abs(match.value));
      const diffRatio = Math.abs(stat.value - match.value) / base;
      score += Math.max(0, 8 - diffRatio * 24);
    } else if (stat.value === match.value) {
      score += 2;
    }
  }

  const unmatchedRight = Math.max(0, right.length - left.length);
  score -= unmatchedRight * 3;
  return score;
}

/**
 * Send grading data for initial stats to the overlay.
 * Called when we have both weapon name AND initial stats.
 */
function sendGradedInitialStats(): void {
  const graded = tryGradeStats(_rivenInitialStats);
  if (graded) {
    forEachRivenWindow((win) => {
      if (!win.isDestroyed()) win.webContents.send(RIVEN_GRADING_INITIAL, graded);
    });
  }
}

/**
 * Send best attributes and trigger WFM search when weapon name becomes available.
 */
function sendWeaponEnrichment(): void {
  if (!_rivenWeaponName || _rivenWeaponName === "Riven") return;

  // Send best attributes to both panels
  void rivenBestAttributes.ensureRivenGoodRollsLoaded().then(() => {
    if (!_rivenWeaponName || _rivenWeaponName === "Riven") return;
    const category = rivenDataSvc.getWeaponCategory(_rivenWeaponName);
    const isMelee = category === "Melee" || category === "SpaceMelee";
    const weaponInfo = rivenBestAttributes.getBestAttributes(_rivenWeaponName, isMelee);
    if (weaponInfo) {
      forEachRivenWindow((win) => {
        if (!win.isDestroyed()) win.webContents.send(RIVEN_BEST_ATTRIBUTES, weaponInfo);
      });
    }
  });

  // Fetch ALL auctions for this weapon (no stat filtering) so the overlay
  // renderer's computeSimilarity() can rank them client-side — same approach
  // as RivenDetailModal.
  const slug = rivenDataSvc.getRivenFamilySlug(_rivenWeaponName);
  wfmRivenSearch
    .searchSimilarRivens(slug, { limit: 30 })
    .then((listings) => {
      if (listings.length > 0) {
        forEachRivenWindow((win) => {
          if (!win.isDestroyed()) win.webContents.send(RIVEN_SIMILAR_LISTINGS, listings);
        });
      }
    })
    .catch((err) => {
      log.warn("[WfmRivenSearch] search failed:", String(err));
    });
}

function clearRivenScanTimers(): void {
  if (_rivenInitialScanTimer) {
    clearTimeout(_rivenInitialScanTimer);
    _rivenInitialScanTimer = null;
  }
  if (_rivenRollScanTimer) {
    clearTimeout(_rivenRollScanTimer);
    _rivenRollScanTimer = null;
  }
}

function triggerInitialScan(): void {
  if (_rivenInitialScanTimer) clearTimeout(_rivenInitialScanTimer);
  _rivenInitialScanTimer = setTimeout(async () => {
    _rivenInitialScanTimer = null;
    try {
      const { stats, rawText, titleText } = await rivenScan.scanInitialCard(_rivenWeaponName);
      _rivenInitialStats = stats;

      // Try to extract weapon name from OCR text if not already known
      const weaponSourceText = titleText || rawText;
      if (weaponSourceText && (!_rivenWeaponName || _rivenWeaponName === "Riven")) {
        const detected = rivenDataSvc.findWeaponInText(weaponSourceText);
        if (detected) {
          log.log(`[RivenScan] weapon detected from OCR: "${detected}"`);
          _rivenWeaponName = detected;
          forEachRivenWindow((win) => {
            if (!win.isDestroyed()) win.webContents.send(RIVEN_WEAPON_UPDATE, detected);
          });
          sendWeaponEnrichment();
        }
      }

      // Always notify the overlay so it can stop the scanning spinner.
      // When stats is empty, the overlay shows the "waiting" placeholder;
      // when stats are present, it renders them.
      rivenSession.onInitialStats(getRivenWindows(), stats);
      if (stats.length > 0) {
        // If weapon name is already known, send grading immediately
        sendGradedInitialStats();
      }
    } catch (err) {
      log.warn("[RivenScan] initial scan failed:", String(err));
    }
  }, INITIAL_SCAN_DELAY_MS);
}

function triggerRollScan(delayMs = ROLL_SCAN_DELAY_MS, skipGate = true): void {
  if (_rivenRollScanTimer) clearTimeout(_rivenRollScanTimer);
  // Increment serial so any already-running scan knows it has been superseded.
  const mySerial = ++_rollScanSerial;
  log.log(`[RivenScan] triggerRollScan: serial=${mySerial}, delay=${delayMs}ms`);
  _rivenRollScanTimer = setTimeout(async () => {
    _rivenRollScanTimer = null;
    log.log(`[RivenScan] roll timer fired: serial=${mySerial}, current=${_rollScanSerial}, weapon="${_rivenWeaponName}"`);
    if (mySerial !== _rollScanSerial) return; // superseded by a later scan
    // Clear any abort flag left by the previous scan before starting fresh.
    rivenScan.resetRivenScanAbort();
    try {
      const panels = await rivenScan.scanNewRoll(_rivenWeaponName, skipGate);
      if (mySerial !== _rollScanSerial) return; // superseded while awaiting OCR
      // If the OCR produced per-panel results, use them directly.  Otherwise
      // fall back to the initial stats we already have for the left panel.
      const leftStats = panels.left.length > 0 ? panels.left : _rivenInitialStats;
      const rightStats = panels.right;
      _rivenNewRollStats = rightStats;
      if (rightStats.length > 0) {
        _rivenHasRollResult = true;
        rivenSession.onRollResult(getRivenWindows(), {
          left: leftStats,
          right: rightStats,
        });
        // Send grading for both panels
        const leftGraded = tryGradeStats(leftStats);
        const rightGraded = tryGradeStats(rightStats);
        if (leftGraded || rightGraded) {
          forEachRivenWindow((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send(RIVEN_GRADING_ROLL, {
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
  }, delayMs);
}


export function onRivenSessionClose(): void {
  log.log("[OverlayRoute] trigger=riven-session-close");
  rivenScan.abortRivenScans();
  // Reset the eeLogMonitor session state so subsequent EE.log events (e.g. a
  // "Cycle Riven into current selection?" dialog arriving after the user pressed
  // ESC) don't re-trigger choice scans against the now-closed overlay windows.
  forceEndRivenSession();
  clearRivenScanTimers();
  _rivenHasRollResult = false;
  _rollScanSerial++;
  _rivenInitialStats = [];
  _rivenNewRollStats = [];
  _rivenWeaponName = "";
  _rivenInteractive = false;
  rivenSession.endSession(getRivenWindows());
  forEachRivenWindow((win) => win.hide());
}

export function onRivenChatView(): void {
  if (!isRivenOverlayEnabled()) return;
  log.log("[OverlayRoute] trigger=riven-chat-view (left panel only)");
  // Don't interrupt an active rolling session
  if (_rivenHasRollResult) return;

  _rivenHasRollResult = false;
  _rivenInitialStats = [];
  _rivenNewRollStats = [];
  _rivenWeaponName = "";
  rivenScan.resetRivenScanAbort();

  // Create only the left window (or reuse if already exists)
  const existLeft = ctx.rivenOverlayLeftWindow;
  if (!existLeft || existLeft.isDestroyed()) {
    _rivenInteractive = false;
    createRivenWindow("left", { show: true });
  } else {
    existLeft.setSkipTaskbar(true);
    existLeft.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    existLeft.setAlwaysOnTop(true, "screen-saver");
    existLeft.moveTop();
    existLeft.showInactive();
    rivenLeftWindowsController.setOverlayInteractiveMode(_rivenInteractive);
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
  triggerInitialScan();
}

export function onRivenSessionOpen(): void {
  if (!isRivenOverlayEnabled()) return;
  log.log("[OverlayRoute] trigger=riven-session");
  _rivenHasRollResult = false;
  _rollScanSerial++;
  _rivenInitialStats = [];
  _rivenNewRollStats = [];
  _rivenWeaponName = "";
  rivenScan.resetRivenScanAbort();
  createRivenOverlayWindows({ show: true });
  // Start (or restart) the session — resets roll count, clears panels.
  // Weapon name is "Riven" placeholder until the first cycle dialog reveals it.
  rivenSession.startSession(getRivenWindows(), "Riven", 0);
  if (ctx.overlayThemeVars && Object.keys(ctx.overlayThemeVars).length > 0) {
    const vars = { ...ctx.overlayThemeVars };
    forEachRivenWindow((win) => win.webContents.send("overlay-theme-vars", vars));
  }
  triggerInitialScan();
}

export function onRivenRollPending(weapon: string, kuvaPerRoll: number): void {
  if (!isRivenOverlayEnabled()) return;
  _rivenHasRollResult = false;
  log.log(`[OverlayRoute] onRivenRollPending: weapon="${weapon}", kuva=${kuvaPerRoll}, current="${_rivenWeaponName}"`);
  // Update weapon name from the cycle dialog text (first time we learn it).
  // Don't call startSession — that would reset the roll count and wipe
  // the stats that the initial scan already populated.
  const isFirstReveal = _rivenWeaponName === "" || _rivenWeaponName === "Riven";
  if (weapon) {
    _rivenWeaponName = weapon;
    forEachRivenWindow((win) => {
      if (!win.isDestroyed()) win.webContents.send(RIVEN_WEAPON_UPDATE, weapon);
    });

    // First time weapon name is revealed → grade existing stats + send enrichment
    if (isFirstReveal) {
      sendGradedInitialStats();
      sendWeaponEnrichment();
    }
  }
}

export function onRivenRollConfirmed(): void {
  if (!isRivenOverlayEnabled()) return;
  log.log("[OverlayRoute] onRivenRollConfirmed -> scheduling roll scan");
  rivenSession.onRollConfirmed(getRivenWindows());
  triggerRollScan();
}

// Fired when the two-card diorama finishes loading. Roll scans are scheduled from
// the roll-confirm event instead, so this remains a no-op to prevent duplicate scans.
export function onRivenDioramaSetup(): void {
  if (!isRivenOverlayEnabled()) return;
  log.log("[OverlayRoute] diorama setup event (no-op, roll uses fixed delay)");
}

export function onRivenChoiceConfirmed(): void {
  if (!isRivenOverlayEnabled()) return;
  // If the overlay was already closed (e.g. user pressed ESC before the EE.log
  // file poll delivered the choice-confirm line), bail out immediately.  Scanning
  // against a hidden/non-existent window captures the desktop and can crash the
  // native OCR binding with FATAL ERROR: ThrowAsJavaScriptException.
  const anyVisible = getRivenWindows().some((w) => w && !w.isDestroyed() && w.isVisible());
  if (!anyVisible) {
    log.log("[RivenScan] choice confirmed but overlay is not visible — skipping");
    return;
  }

  clearRivenScanTimers();
  _rivenHasRollResult = false;

  // IMPORTANT: SendResult(4) fires for BOTH "accept new roll" (user clicked right card
  // then CONFIRM) AND "confirm keeping current" (user clicked left card then CONFIRM).
  // There is NO way to determine the chosen side from EE.log alone — we MUST rescan.

  // Snapshot both stat sets NOW under local names — _rivenNewRollStats / _rivenInitialStats
  // may be overwritten if the user immediately starts another roll before the timer fires.
  const preChoiceStats = _rivenInitialStats.slice();
  const newRollStats = _rivenNewRollStats.slice();
  _rivenNewRollStats = [];

  // Tell the renderer: choice made, side unknown until rescan completes.
  rivenSession.onChoiceMade(getRivenWindows(), "unknown");

  // Rescan the single card shown after the choice once the post-choice animation settles.
  if (_rivenInitialScanTimer) clearTimeout(_rivenInitialScanTimer);
  _rivenInitialScanTimer = setTimeout(async () => {
    _rivenInitialScanTimer = null;
    try {
      const stats = await rivenScan.scanChoiceRescan(_rivenWeaponName);

      // Determine which side was chosen by comparing OCR result to both known stat sets.
      let chosenSide: "left" | "right" | "unknown" = "unknown";
      if (stats.length > 0 && preChoiceStats.length > 0 && newRollStats.length > 0) {
        const leftScore = scoreRivenStatSimilarity(stats, preChoiceStats);
        const rightScore = scoreRivenStatSimilarity(stats, newRollStats);
        log.log(
          `[RivenScan] choice similarity: left=${leftScore.toFixed(2)} right=${rightScore.toFixed(2)}`,
        );
        const best = Math.max(leftScore, rightScore);
        const delta = Math.abs(leftScore - rightScore);
        if (best >= 12 && delta >= 6) {
          chosenSide = rightScore > leftScore ? "right" : "left";
        }
      }

      // Update _rivenInitialStats to whichever side was confirmed.
      if (chosenSide === "right" && newRollStats.length > 0) {
        _rivenInitialStats = newRollStats;
      } else if (chosenSide === "left" && preChoiceStats.length > 0) {
        _rivenInitialStats = preChoiceStats;
      } else if (stats.length > 0) {
        _rivenInitialStats = stats; // fallback: use OCR text directly
      }

      if (_rivenInitialStats.length > 0) {
        rivenSession.onChoiceMade(getRivenWindows(), chosenSide);
        rivenSession.onInitialStats(getRivenWindows(), _rivenInitialStats);
        sendGradedInitialStats();
      }
    } catch (err) {
      log.warn("[RivenScan] choice rescan failed:", String(err));
    }
  }, CHOICE_RESCAN_DELAY_MS);
}


export { toggleRivenInteractiveMode, forEachRivenWindow,  };

export function configureOverlaySettingsPersistence(persist: () => void): void {
  persistOverlaySettings = persist;
}


export function register(): void {
  onAuthorized(RIVEN_OVERLAY_CLOSE, assertRivenOverlayRendererSender, () => {
    clearRivenScanTimers();
    _rivenInteractive = false;
    _rivenHasRollResult = false;
    _rivenInitialStats = [];
    _rivenNewRollStats = [];
    rivenSession.endSession(getRivenWindows());
    forEachRivenWindow((win) => win.hide());
  });

  onAuthorized(RIVEN_OPEN_AUCTION, assertRivenOverlayRendererSender, (_event, auctionId: unknown) => {
    const id = String(auctionId || "").replace(/[^a-zA-Z0-9]/g, "");
    if (id) {
      const url = new URL(`https://warframe.market/auction/${id}`);
      if (url.protocol === "https:" && isAllowedExternalHost(url.hostname)) {
        void shell.openExternal(url.toString());
      }
    }
  });
}
