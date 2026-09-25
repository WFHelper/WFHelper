import path from "node:path";
import { BrowserWindow, app, screen, shell } from "electron";
import { getOverlayDescriptor } from "../config/shared/overlayLayout";
import ctx from "./context";
import { assertRivenOverlayRendererSender, onAuthorized } from "./ipcSecurity";
import {
  createOverlayWindowBoundsChangeHandler,
  createOverlayWindowsController,
} from "./overlay/windows";
import {
  applyOverlayZOrder,
  canRaiseOverlayWindows,
  registerZOrderSubscriber,
  returnFocusToWarframe,
  syncOverlayWindowZOrder,
  syncUnfocusHide,
} from "./overlay/zOrder";
import * as rivenSession from "./overlay/rivenSession";
import * as rivenScan from "./overlay/rivenScan";
import {
  readFitsInWeapon,
  readFitsInWeaponSmallUi,
  shouldApplyLabelWeapon,
  type RivenWeaponSource,
} from "./overlay/rivenWeaponLabel";
import { looksLikeStaleCardRead, rollRescanReason } from "./overlay/rivenScanText";
import { captureScreenFast, type CaptureResult } from "../services/screenCapture";
import type { WeaponLabelMatch } from "../services/rivenData";
import { sleep } from "../services/sleep";
import * as rivenGrading from "../services/rivenGrading";
import * as rivenDataSvc from "../services/rivenData";
import * as rivenBestAttributes from "../services/rivenBestAttributes";
import * as wfmRivenSearch from "../services/wfmRivenSearch";
import * as warframeStatus from "../services/warframeStatus";
import { withScope } from "../services/logger";
import { hardenBrowserWindowNavigation } from "../services/windowSecurity";
import {
  isRivenOverlayEnabled as isRivenOverlaySettingEnabled,
  overlaysStartInteractive,
  REFERENCE_WARFRAME_UI_SCALE,
} from "../config/runtime/overlaySettings";
import { resolveWarframeUiScale } from "../services/eeLogPath";

import { forceEndRivenSession, resumeRivenSession } from "../services/eeLogMonitor";
import { isAllowedExternalHost } from "../config/runtime/security";
import {
  OVERLAY_INTERACTION_MODE,
  OVERLAY_THEME_VARS,
  RIVEN_OVERLAY_CLOSE,
  RIVEN_OPEN_AUCTION,
  RIVEN_GRADING_INITIAL,
  RIVEN_GRADING_ROLL,
  RIVEN_BEST_ATTRIBUTES,
  RIVEN_SIMILAR_LISTINGS,
  RIVEN_WEAPON_UPDATE,
  RIVEN_RESCAN_REQUEST,
  RIVEN_RESCAN,
  RIVEN_WEAPON_MISSING,
} from "../config/shared/ipcChannels";

const log = withScope("rivenOverlayIpc");

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

const RIVEN_CANVAS = getOverlayDescriptor("rivenLeft").canvas;
const RIVEN_TOP_OFFSET = 80;

const rivenLastEvents = new Map<string, unknown[]>();
const readyRivenRenderers = new Set<number>();

function onRivenWindowCreated(window: InstanceType<typeof BrowserWindow>): void {
  const senderId = window.webContents.id;
  readyRivenRenderers.delete(senderId);
  window.webContents.on("did-start-loading", () => readyRivenRenderers.delete(senderId));
  window.once("closed", () => readyRivenRenderers.delete(senderId));
}

const rivenWindowBaseOptions = {
  app,
  BrowserWindow,
  screen,
  ctx,
  log,
  hardenBrowserWindowNavigation,
  overlayWindowFile: RIVEN_WINDOW_FILE,
  displayMode: "primary" as const,
  windowWidth: RIVEN_CANVAS.width,
  windowHeight: RIVEN_CANVAS.height,
  minWindowWidth: RIVEN_CANVAS.width,
  minWindowHeight: RIVEN_CANVAS.height,
  topOffset: RIVEN_TOP_OFFSET,
  transparent: true,
  preloadFileName: "preload-riven.js",
  hasShadow: false,
  onWindowCreated: onRivenWindowCreated,
  onPresentationEnd: () => resetRivenInteractionWhenIdle(),
  canRaise: canRaiseOverlayWindows,
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
  windowTitle: "WFHelper Riven Scanner Left",
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
  windowTitle: "WFHelper Riven Scanner Right",
  fileSearch: "side=right",
  placement: "top-right",
  windowStateKey: "rivenRight",
  onWindowBoundsChanged: rememberOverlayWindowBounds,
});

function recordRivenEvent(channel: string, args: unknown[]): void {
  rivenLastEvents.delete(channel);
  rivenLastEvents.set(channel, args);
}

rivenSession.setEventRecorder(recordRivenEvent);

function sendToRivenWindows(channel: string, ...args: unknown[]): void {
  recordRivenEvent(channel, args);
  forEachRivenWindow((win) => win.webContents.send(channel, ...args));
}

export function markRivenRendererReady(senderId: number): boolean {
  const entry = rivenWindowEntries().find(
    ({ win }) => win !== null && !win.isDestroyed() && win.webContents.id === senderId,
  );
  if (!entry || !entry.win) return false;
  entry.controller.markRendererReady(senderId);
  if (readyRivenRenderers.has(senderId)) return true;
  readyRivenRenderers.add(senderId);
  for (const [channel, args] of rivenLastEvents) entry.win.webContents.send(channel, ...args);
  return true;
}

const rivenControllers = [rivenLeftWindowsController, rivenRightWindowsController];

function rivenWindowEntries() {
  return [
    { win: ctx.rivenOverlayLeftWindow, controller: rivenLeftWindowsController },
    { win: ctx.rivenOverlayRightWindow, controller: rivenRightWindowsController },
  ];
}

function getRivenWindows(): (InstanceType<typeof BrowserWindow> | null)[] {
  return rivenWindowEntries().map(({ win }) => win);
}

export function isAnyRivenWindowVisible(): boolean {
  return rivenControllers.some((controller) => controller.isOverlayWindowVisible());
}

function isRivenShown(): boolean {
  return rivenControllers.some(
    (controller) => controller.isOverlayWindowVisible() || controller.isHiddenByUnfocus(),
  );
}

export function restoreRivenAfterUnfocus(): void {
  for (const controller of rivenControllers) controller.restoreAfterUnfocus();
}

function hideRivenWindows(): void {
  for (const controller of rivenControllers) controller.hideOverlayWindow();
}

function forEachRivenWindow(fn: (win: InstanceType<typeof BrowserWindow>) => void): void {
  for (const win of getRivenWindows()) {
    if (win && !win.isDestroyed()) fn(win);
  }
}

let _lastZOrderProbe = "";

function probeRivenZOrder(keepRaised: boolean): void {
  const sides = rivenWindowEntries().map(({ win, controller }, index) => {
    const side = index === 0 ? "L" : "R";
    if (!win || win.isDestroyed()) return `${side}=gone`;
    const os = warframeStatus.isWindowTopmost(win.getNativeWindowHandle());
    const top = `${win.isAlwaysOnTop() ? 1 : 0}/${os === null ? "?" : os ? 1 : 0}`;
    return `${side}=vis:${controller.isOverlayWindowVisible() ? 1 : 0} top:${top}`;
  });
  const line = `raised=${keepRaised ? 1 : 0} ${sides.join(" ")}`;
  if (line === _lastZOrderProbe) return;
  _lastZOrderProbe = line;
  log.info(`[ZOrder] riven ${line}`);
}

function syncRivenWindowZOrder(warframeFocused: boolean, foreground: boolean | null = null): void {
  syncUnfocusHide("riven panels", rivenControllers, warframeFocused, foreground);
  if (!isAnyRivenWindowVisible()) return;
  const keepRaised =
    process.platform === "win32" ? canRaiseOverlayWindows() : warframeFocused || _rivenInteractive;
  probeRivenZOrder(keepRaised);
  for (const { win, controller } of rivenWindowEntries()) {
    syncOverlayWindowZOrder(controller, win, keepRaised);
  }
}

function setRivenInteractiveMode(
  next: boolean,
  options: { focus?: boolean } = { focus: true },
): void {
  _rivenInteractive = next;
  rivenLeftWindowsController.setOverlayInteractiveMode(_rivenInteractive, options);
  rivenRightWindowsController.setOverlayInteractiveMode(_rivenInteractive, options);
  sendToRivenWindows(OVERLAY_INTERACTION_MODE, { interactive: _rivenInteractive });
}

function rivenStartsInteractive(): boolean {
  return overlaysStartInteractive(ctx.overlaySettings, process.platform);
}

function resetRivenInteraction(): void {
  const start = rivenStartsInteractive();
  if (_rivenInteractive === start) return;
  if (start) {
    setRivenInteractiveMode(true, { focus: false });
    return;
  }
  setRivenInteractiveMode(false);
  if (!ctx.overlayInteractiveMode) returnFocusToWarframe();
}

function resetRivenInteractionWhenIdle(): void {
  if (!isRivenShown()) resetRivenInteraction();
}

export function isRivenInteractiveMode(): boolean {
  return _rivenInteractive;
}

export function getRivenPlacementRects() {
  return {
    left: rivenLeftWindowsController.getOverlayBoundsForActiveDisplay(),
    right: rivenRightWindowsController.getOverlayBoundsForActiveDisplay(),
  };
}

function createRivenWindow(side: "left" | "right", options: { show?: boolean }): void {
  const controller = side === "left" ? rivenLeftWindowsController : rivenRightWindowsController;
  controller.createOverlayWindow(options);
  controller.setOverlayInteractiveMode(_rivenInteractive);
}

function createFreshRivenWindows(
  sides: Array<"left" | "right">,
  options: { show?: boolean },
): void {
  _rivenInteractive = rivenStartsInteractive();
  for (const side of sides) createRivenWindow(side, options);
  // A fresh renderer starts click-through, so only the interactive start needs telling.
  if (_rivenInteractive) sendToRivenWindows(OVERLAY_INTERACTION_MODE, { interactive: true });
}

export function positionRivenOverlayWindows(): void {
  rivenLeftWindowsController.positionOverlayWindow(rivenLeftWindowsController.getAnchorMeta());
  rivenRightWindowsController.positionOverlayWindow(rivenRightWindowsController.getAnchorMeta());
}

function createRivenOverlayWindows(options: { show?: boolean } = {}): void {
  const existLeft = ctx.rivenOverlayLeftWindow;
  const existRight = ctx.rivenOverlayRightWindow;
  const keepMapped =
    rivenLeftWindowsController.isKeepMappedActive() &&
    rivenRightWindowsController.isKeepMappedActive();
  if (existLeft && !existLeft.isDestroyed() && existRight && !existRight.isDestroyed()) {
    if (
      !keepMapped &&
      options.show !== false &&
      (!rivenLeftWindowsController.isOverlayWindowVisible() ||
        !rivenRightWindowsController.isOverlayWindowVisible())
    ) {
      existLeft.destroy();
      existRight.destroy();
    } else {
      positionRivenOverlayWindows();
      for (const { win, controller } of rivenWindowEntries()) {
        if (!win || win.isDestroyed()) continue;
        applyOverlayZOrder(win, true);
        if (options.show !== false) controller.showOverlayWindowInactive();
      }
      rivenLeftWindowsController.setOverlayInteractiveMode(_rivenInteractive);
      rivenRightWindowsController.setOverlayInteractiveMode(_rivenInteractive);
      return;
    }
  }

  if (existLeft && !existLeft.isDestroyed()) existLeft.destroy();
  if (existRight && !existRight.isDestroyed()) existRight.destroy();

  rivenLastEvents.clear();
  createFreshRivenWindows(["left", "right"], options);
}

registerZOrderSubscriber({
  isActive: isRivenShown,
  sync: syncRivenWindowZOrder,
});

let _rivenHasRollResult = false;

const rollScanGeneration = rivenSession.createScanGeneration();

let _rivenInitialScanTimer: ReturnType<typeof setTimeout> | null = null;
let _rivenRollScanTimer: ReturnType<typeof setTimeout> | null = null;

const INITIAL_SCAN_DELAY_MS = 200;
const ROLL_SCAN_DELAY_MS = 2850;
const CHOICE_RESCAN_DELAY_MS = 1200;

// The reveal animation can outlast ROLL_SCAN_DELAY_MS on a slow machine.
const ROLL_STALE_RESCAN_DELAY_MS = 1100;
const MAX_ROLL_STALE_RESCANS = 2;

let _rivenInitialStats: rivenScan.RivenStat[] = [];
let _rivenNewRollStats: rivenScan.RivenStat[] = [];

let _rivenWeaponName = "";
let _rivenScanLayout: rivenScan.InitialCardLayout = "reroll";
let _rivenWeaponSource: RivenWeaponSource = "";
let _rivenWeaponLabelExact = false;
let _rivenSessionToken = 0;

function isRivenOverlayEnabled(): boolean {
  return isRivenOverlaySettingEnabled(ctx.overlaySettings);
}

function tryGradeStats(stats: rivenScan.RivenStat[]): rivenGrading.RivenGradeResult | null {
  if (!_rivenWeaponName || _rivenWeaponName === "Riven" || stats.length === 0) return null;
  const { stats: corrected } = rivenGrading.correctScannedStats(_rivenWeaponName, stats);
  return rivenGrading.gradeRiven(_rivenWeaponName, corrected);
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

function sendGradedInitialStats(): void {
  const graded = tryGradeStats(_rivenInitialStats);
  if (graded) sendToRivenWindows(RIVEN_GRADING_INITIAL, graded);
}

function sendWeaponEnrichment(): void {
  if (!_rivenWeaponName || _rivenWeaponName === "Riven") return;

  void rivenBestAttributes.ensureRivenGoodRollsLoaded().then(() => {
    if (!_rivenWeaponName || _rivenWeaponName === "Riven") return;
    const isMelee = rivenDataSvc.isMeleeWeapon(_rivenWeaponName);
    const weaponInfo = rivenBestAttributes.getBestAttributes(_rivenWeaponName, isMelee);
    if (weaponInfo) sendToRivenWindows(RIVEN_BEST_ATTRIBUTES, weaponInfo);
  });

  const slug = rivenDataSvc.getRivenFamilySlug(_rivenWeaponName);
  wfmRivenSearch
    .searchSimilarRivens(slug, { limit: 30 })
    .then((listings) => {
      if (listings.length > 0) sendToRivenWindows(RIVEN_SIMILAR_LISTINGS, listings);
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

function applyDetectedWeapon(
  detected: string,
  source: RivenWeaponSource,
  via: string,
  labelExact = false,
): void {
  log.info(`[RivenScan] weapon detected from ${via}: "${detected}"`);
  _rivenWeaponName = detected;
  _rivenWeaponSource = source;
  _rivenWeaponLabelExact = labelExact;
  sendToRivenWindows(RIVEN_WEAPON_UPDATE, detected);
  sendWeaponEnrichment();
  if (_rivenInitialStats.length > 0) sendGradedInitialStats();
}

function maybeDetectWeaponFromText(ocrText: string): void {
  if (!ocrText || (_rivenWeaponName && _rivenWeaponName !== "Riven")) return;
  const detected = rivenDataSvc.findWeaponInText(ocrText);
  if (!detected) return;
  applyDetectedWeapon(detected, "ocr", "OCR");
}

// The diorama resource path identifies the weapon without localized text.
export function onRivenWeaponPath(weaponPath: string): void {
  const name = rivenDataSvc.getWeaponNameByUniqueName(weaponPath);
  if (!name) {
    log.info(`[OverlayRoute] diorama weapon path has no indexed weapon: ${weaponPath}`);
    return;
  }
  if (_rivenWeaponName && _rivenWeaponName !== "Riven") {
    if (_rivenWeaponName === name) return;
    // Within one family, the exact diorama variant controls disposition and grading.
    if (
      rivenDataSvc.getRivenFamilySlug(name) === rivenDataSvc.getRivenFamilySlug(_rivenWeaponName)
    ) {
      if (_rivenWeaponSource === "label") return;
      applyDetectedWeapon(name, "diorama", "diorama load (refines OCR)");
      return;
    }
    log.warn(
      `[OverlayRoute] diorama weapon "${name}" differs from detected "${_rivenWeaponName}" - keeping the first`,
    );
    return;
  }
  applyDetectedWeapon(name, "diorama", "diorama load");
}

function onFitsInWeapon(match: WeaponLabelMatch): void {
  if (match.name === _rivenWeaponName) {
    _rivenWeaponSource = "label";
    _rivenWeaponLabelExact = match.exact;
    return;
  }
  const sameFamily =
    !!_rivenWeaponName &&
    _rivenWeaponName !== "Riven" &&
    rivenDataSvc.getRivenFamilySlug(match.name) ===
      rivenDataSvc.getRivenFamilySlug(_rivenWeaponName);
  if (shouldApplyLabelWeapon(match, _rivenWeaponName, _rivenWeaponSource, sameFamily)) {
    applyDetectedWeapon(match.name, "label", "fits-in label", match.exact);
    return;
  }
  log.warn(
    `[RivenScan] fits-in label "${match.name}" differs from detected "${_rivenWeaponName}" - keeping the current weapon`,
  );
}

async function detectFitsInWeapon(capture: CaptureResult): Promise<void> {
  const token = _rivenSessionToken;
  const uiScale =
    (ctx.overlaySettings.warframeUiScaleAuto !== false ? resolveWarframeUiScale() : null) ??
    (Number(ctx.overlaySettings.warframeUiScale) || REFERENCE_WARFRAME_UI_SCALE);
  // Sub-100% scales move the plate; recapture with our panel hidden and search wide.
  const smallUi = uiScale < 0.98;
  try {
    let match: WeaponLabelMatch | null = null;
    if (smallUi) {
      const overlayWasVisible = rivenRightWindowsController.isOverlayWindowVisible();
      if (overlayWasVisible) rivenRightWindowsController.hideOverlayWindow({ transient: true });
      try {
        // Drifting shards blank single frames; retry on fresh captures.
        for (let attempt = 0; attempt < 3 && !match; attempt += 1) {
          await sleep(attempt === 0 ? 50 : 600);
          if (token !== _rivenSessionToken) return;
          const fresh = await captureScreenFast(capture.sourceDisplayId || null, 100);
          if (!fresh) continue;
          match = await readFitsInWeaponSmallUi(fresh.image, uiScale, fresh.sourceType);
        }
      } finally {
        if (overlayWasVisible && token === _rivenSessionToken) {
          rivenRightWindowsController.showOverlayWindowInactive();
        }
      }
    } else {
      match = await readFitsInWeapon(capture.image, capture.sourceType);
      if (token !== _rivenSessionToken) return;
      if (!match && rivenRightWindowsController.isOverlayWindowVisible()) {
        let retryCapture: CaptureResult | null = null;
        rivenRightWindowsController.hideOverlayWindow({ transient: true });
        try {
          await sleep(50);
          if (token !== _rivenSessionToken) return;
          retryCapture = await captureScreenFast(capture.sourceDisplayId || null, 100);
        } finally {
          if (token === _rivenSessionToken) {
            rivenRightWindowsController.showOverlayWindowInactive();
          }
        }
        if (retryCapture) {
          match = await readFitsInWeapon(retryCapture.image, retryCapture.sourceType);
        }
      }
    }
    if (token !== _rivenSessionToken) return;
    if (match) {
      onFitsInWeapon(match);
      return;
    }
  } catch (err) {
    log.warn("[RivenScan] fits-in label read failed:", String(err));
    if (token !== _rivenSessionToken) return;
  }
  if (!_rivenWeaponName || _rivenWeaponName === "Riven") {
    sendToRivenWindows(RIVEN_WEAPON_MISSING);
  }
}

function triggerInitialScan(layout: rivenScan.InitialCardLayout = "reroll"): void {
  _rivenScanLayout = layout;
  if (_rivenInitialScanTimer) clearTimeout(_rivenInitialScanTimer);
  _rivenInitialScanTimer = setTimeout(async () => {
    _rivenInitialScanTimer = null;
    rivenScan.resetRivenScanAbort();
    try {
      const { stats, rawText, titleText, capture, lowConfidence } =
        await rivenScan.scanInitialCard(layout);
      _rivenInitialStats = stats;

      maybeDetectWeaponFromText(titleText || rawText);

      rivenSession.onInitialStats(getRivenWindows(), stats, lowConfidence);
      if (stats.length > 0) {
        sendGradedInitialStats();
      }
      if (capture) void detectFitsInWeapon(capture);
    } catch (err) {
      log.warn("[RivenScan] initial scan failed:", String(err));
      rivenSession.onInitialStats(getRivenWindows(), []);
    }
  }, INITIAL_SCAN_DELAY_MS);
}

function triggerRollScan(delayMs = ROLL_SCAN_DELAY_MS): void {
  if (_rivenRollScanTimer) clearTimeout(_rivenRollScanTimer);
  const mySerial = rollScanGeneration.begin();
  log.info(`[RivenScan] triggerRollScan: serial=${mySerial}, delay=${delayMs}ms`);
  _rivenRollScanTimer = setTimeout(async () => {
    _rivenRollScanTimer = null;
    log.info(
      `[RivenScan] roll timer fired: serial=${mySerial}, current=${rollScanGeneration.current()}, weapon="${_rivenWeaponName}"`,
    );
    if (!rollScanGeneration.isCurrent(mySerial)) return;
    rivenScan.resetRivenScanAbort();
    const knownCards = [_rivenInitialStats.slice(), _rivenNewRollStats.slice()];
    try {
      let panels = await rivenScan.scanNewRoll();
      if (!rollScanGeneration.isCurrent(mySerial)) return;
      for (let rescan = 0; rescan < MAX_ROLL_STALE_RESCANS; rescan++) {
        const reason = rollRescanReason(panels.right, knownCards);
        if (!reason) break;
        log.warn(
          `[RivenScan] roll result ${reason} (rescan ${rescan + 1}/${MAX_ROLL_STALE_RESCANS}) - waiting ${ROLL_STALE_RESCAN_DELAY_MS}ms`,
        );
        await sleep(ROLL_STALE_RESCAN_DELAY_MS);
        if (!rollScanGeneration.isCurrent(mySerial)) return;
        panels = await rivenScan.scanNewRoll();
        if (!rollScanGeneration.isCurrent(mySerial)) return;
      }
      if (looksLikeStaleCardRead(panels.right, knownCards)) {
        log.warn("[RivenScan] roll result still matches a pre-roll card");
        _rivenNewRollStats = [];
        rivenSession.onRollFailed(getRivenWindows(), _rivenInitialStats);
        return;
      }
      // The cycle dialog logs a language key these days, so the roll card's title names it.
      maybeDetectWeaponFromText(panels.rawText ?? "");
      const leftStats = panels.left.length > 0 ? panels.left : _rivenInitialStats;
      const rightStats = panels.right;
      _rivenNewRollStats = rightStats;
      if (rightStats.length === 0) {
        rivenSession.onRollFailed(getRivenWindows(), leftStats);
        return;
      }

      _rivenHasRollResult = true;
      rivenSession.onRollResult(getRivenWindows(), {
        left: leftStats,
        right: rightStats,
      });
      const leftGraded = tryGradeStats(leftStats);
      const rightGraded = tryGradeStats(rightStats);
      if (leftGraded || rightGraded) {
        sendToRivenWindows(RIVEN_GRADING_ROLL, { left: leftGraded, right: rightGraded });
      }
    } catch (err) {
      log.warn("[RivenScan] roll scan failed:", String(err));
      if (rollScanGeneration.isCurrent(mySerial)) {
        _rivenNewRollStats = [];
        rivenSession.onRollFailed(getRivenWindows(), _rivenInitialStats);
      }
    }
  }, delayMs);
}

export function onRivenSessionClose(): void {
  log.info("[OverlayRoute] trigger=riven-session-close");
  rollScanGeneration.invalidate();
  _rivenSessionToken += 1;
  rivenScan.abortRivenScans();
  forceEndRivenSession();
  clearRivenScanTimers();
  _rivenHasRollResult = false;
  _rivenInitialStats = [];
  _rivenNewRollStats = [];
  _rivenWeaponName = "";
  _rivenWeaponSource = "";
  _rivenWeaponLabelExact = false;
  rivenSession.endSession(getRivenWindows());
  hideRivenWindows();
  resetRivenInteraction();
  rivenLastEvents.clear();
}

export function onRivenChatView(): void {
  if (!isRivenOverlayEnabled()) return;
  log.info("[OverlayRoute] trigger=riven-chat-view (left panel only)");
  if (_rivenHasRollResult) return;
  resetRivenInteractionWhenIdle();

  _rivenHasRollResult = false;
  _rivenInitialStats = [];
  _rivenNewRollStats = [];
  _rivenWeaponName = "";
  _rivenWeaponSource = "";
  _rivenWeaponLabelExact = false;
  _rivenSessionToken += 1;

  const existLeft = ctx.rivenOverlayLeftWindow;
  if (!existLeft || existLeft.isDestroyed()) {
    createFreshRivenWindows(["left"], { show: true });
  } else {
    applyOverlayZOrder(existLeft, true);
    rivenLeftWindowsController.showOverlayWindowInactive();
    rivenLeftWindowsController.setOverlayInteractiveMode(_rivenInteractive);
  }

  rivenRightWindowsController.hideOverlayWindow();

  const wins = [ctx.rivenOverlayLeftWindow];
  rivenSession.startSession(wins, "Riven", 0);
  if (ctx.overlayThemeVars && Object.keys(ctx.overlayThemeVars).length > 0) {
    const vars = { ...ctx.overlayThemeVars };
    const lw = ctx.rivenOverlayLeftWindow;
    if (lw && !lw.isDestroyed()) lw.webContents.send(OVERLAY_THEME_VARS, vars);
  }
  triggerInitialScan("chat");
}

function rescanVisibleRivenCard(): void {
  rollScanGeneration.invalidate();
  _rivenSessionToken += 1;
  rivenScan.abortRivenScans();
  clearRivenScanTimers();
  _rivenHasRollResult = false;
  _rivenNewRollStats = [];
  sendToRivenWindows(RIVEN_RESCAN);
  triggerInitialScan(_rivenScanLayout);
}

export function onRivenManualRescan(source = "hotkey"): void {
  if (!isRivenOverlayEnabled()) {
    log.info("[OverlayRoute] riven rescan ignored - the riven overlay is off");
    return;
  }
  log.info(`[OverlayRoute] trigger=riven-rescan source=${source}`);
  resumeRivenSession();
  if (isAnyRivenWindowVisible()) {
    rescanVisibleRivenCard();
    return;
  }
  onRivenSessionOpen();
}

export function onRivenSessionOpen(): void {
  if (!isRivenOverlayEnabled()) return;
  log.info("[OverlayRoute] trigger=riven-session");
  resetRivenInteractionWhenIdle();
  _rivenHasRollResult = false;
  rollScanGeneration.invalidate();
  _rivenInitialStats = [];
  _rivenNewRollStats = [];
  _rivenWeaponName = "";
  _rivenWeaponSource = "";
  _rivenWeaponLabelExact = false;
  _rivenSessionToken += 1;
  createRivenOverlayWindows({ show: true });
  rivenSession.startSession(getRivenWindows(), "Riven", 0);
  if (ctx.overlayThemeVars && Object.keys(ctx.overlayThemeVars).length > 0) {
    const vars = { ...ctx.overlayThemeVars };
    forEachRivenWindow((win) => win.webContents.send(OVERLAY_THEME_VARS, vars));
  }
  triggerInitialScan();
}

export function onRivenRollPending(weapon: string, kuvaPerRoll: number): void {
  if (!isRivenOverlayEnabled()) return;
  _rivenHasRollResult = false;
  log.info(
    `[OverlayRoute] onRivenRollPending: weapon="${weapon}", kuva=${kuvaPerRoll}, current="${_rivenWeaponName}"`,
  );
  const isFirstReveal = _rivenWeaponName === "" || _rivenWeaponName === "Riven";
  // The EE.log dialog only names the weapon family, never the variant.
  const keepLabelVariant =
    !isFirstReveal &&
    _rivenWeaponSource === "label" &&
    (_rivenWeaponLabelExact ||
      rivenDataSvc.getRivenFamilySlug(weapon) ===
        rivenDataSvc.getRivenFamilySlug(_rivenWeaponName));
  if (weapon && !keepLabelVariant) {
    _rivenWeaponName = weapon;
    _rivenWeaponSource = "dialog";
    _rivenWeaponLabelExact = false;
    forEachRivenWindow((win) => {
      if (!win.isDestroyed()) win.webContents.send(RIVEN_WEAPON_UPDATE, weapon);
    });

    if (isFirstReveal) {
      sendGradedInitialStats();
      sendWeaponEnrichment();
    }
  }
}

export function onRivenRollConfirmed(): void {
  if (!isRivenOverlayEnabled()) return;
  log.info("[OverlayRoute] onRivenRollConfirmed -> scheduling roll scan");
  rivenSession.onRollConfirmed(getRivenWindows());
  triggerRollScan();
}

export function onRivenDioramaSetup(): void {
  if (!isRivenOverlayEnabled()) return;
  log.info("[OverlayRoute] diorama setup event (no-op, roll uses fixed delay)");
}

export function onRivenChoiceConfirmed(): void {
  if (!isRivenOverlayEnabled()) return;
  if (!isAnyRivenWindowVisible()) {
    log.info("[RivenScan] choice confirmed but overlay is not visible - skipping");
    return;
  }

  rollScanGeneration.invalidate();
  rivenScan.abortRivenScans();
  clearRivenScanTimers();
  _rivenHasRollResult = false;

  // SendResult(4) fires for BOTH "accept new roll" and "keep current" confirms;
  // EE.log alone can't tell which side - always rescan.

  const preChoiceStats = _rivenInitialStats.slice();
  const newRollStats = _rivenNewRollStats.slice();
  _rivenNewRollStats = [];

  rivenSession.onChoiceMade(getRivenWindows(), "unknown");

  if (_rivenInitialScanTimer) clearTimeout(_rivenInitialScanTimer);
  _rivenInitialScanTimer = setTimeout(async () => {
    _rivenInitialScanTimer = null;
    rivenScan.resetRivenScanAbort();
    try {
      const stats = await rivenScan.scanChoiceRescan();

      let chosenSide: "left" | "right" | "unknown" = "unknown";
      if (stats.length > 0 && preChoiceStats.length > 0 && newRollStats.length > 0) {
        const leftScore = scoreRivenStatSimilarity(stats, preChoiceStats);
        const rightScore = scoreRivenStatSimilarity(stats, newRollStats);
        log.info(
          `[RivenScan] choice similarity: left=${leftScore.toFixed(2)} right=${rightScore.toFixed(2)}`,
        );
        const best = Math.max(leftScore, rightScore);
        const delta = Math.abs(leftScore - rightScore);
        if (best >= 12 && delta >= 6) {
          chosenSide = rightScore > leftScore ? "right" : "left";
        }
      }

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

export { setRivenInteractiveMode, forEachRivenWindow };

export function configureOverlaySettingsPersistence(persist: () => void): void {
  persistOverlaySettings = persist;
}

export function register(): void {
  onAuthorized(RIVEN_OVERLAY_CLOSE, assertRivenOverlayRendererSender, () => {
    rollScanGeneration.invalidate();
    _rivenSessionToken += 1;
    rivenScan.abortRivenScans();
    clearRivenScanTimers();
    _rivenHasRollResult = false;
    _rivenInitialStats = [];
    _rivenNewRollStats = [];
    rivenSession.endSession(getRivenWindows());
    hideRivenWindows();
    resetRivenInteraction();
    rivenLastEvents.clear();
  });

  onAuthorized(RIVEN_RESCAN_REQUEST, assertRivenOverlayRendererSender, () => {
    if (!isAnyRivenWindowVisible()) return;
    log.info("[OverlayRoute] trigger=riven-manual-rescan");
    rescanVisibleRivenCard();
  });

  onAuthorized(
    RIVEN_OPEN_AUCTION,
    assertRivenOverlayRendererSender,
    (_event, auctionId: unknown) => {
      const id = String(auctionId || "").replace(/[^a-zA-Z0-9]/g, "");
      if (id) {
        const url = new URL(`https://warframe.market/auction/${id}`);
        if (url.protocol === "https:" && isAllowedExternalHost(url.hostname)) {
          void shell.openExternal(url.toString());
        }
      }
    },
  );
}
