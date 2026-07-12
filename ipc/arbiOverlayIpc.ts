import ctx from "./context";
import { assertArbiSummarySender, onAuthorized } from "./ipcSecurity";
import {
  createOverlayWindowBoundsChangeHandler,
  createOverlayWindowsController,
} from "./overlay/windows";
import { withScope } from "../services/logger";
import { hardenBrowserWindowNavigation } from "../services/windowSecurity";
import { isArbiSummaryOverlayEnabled } from "../config/runtime/overlaySettings";
import { buildArbiSummaryPayload } from "../config/shared/arbiSummary";
import type { ArbiRunRecord } from "../config/shared/arbiTypes";
import {
  ARBI_OPEN_RUN,
  ARBI_SUMMARY_CLOSE,
  ARBI_SUMMARY_DATA,
  ARBI_SUMMARY_OPEN_DETAILS,
  ARBI_SUMMARY_READY,
} from "../config/shared/ipcChannels";

import { BrowserWindow, app, screen } from "electron";
import path from "node:path";

const log = withScope("arbiOverlayIpc");

const APP_ROOT = app.getAppPath();
const ARBI_SUMMARY_WINDOW_FILE = path.join(APP_ROOT, "renderer", "arbi-overlay.html");

const AUTO_HIDE_MS = 60_000;
const WIN_W = 420;
const WIN_H = 252;

let persistOverlaySettings: (() => void) | null = null;
const rememberOverlayWindowBounds = createOverlayWindowBoundsChangeHandler({
  ctx,
  save: () => {
    persistOverlaySettings?.();
  },
});

const arbiSummaryWindowsController = createOverlayWindowsController({
  app,
  BrowserWindow,
  screen,
  ctx,
  getOverlayWindow: () => ctx.arbiSummaryWindow,
  setOverlayWindow: (window) => {
    ctx.arbiSummaryWindow = window;
  },
  // Factory interactive mode would focus the window (steals game focus) - stay
  // non-interactive and re-enable mouse events manually: clickable, never focused.
  getOverlayInteractiveMode: () => false,
  setOverlayInteractiveModeState: () => {},
  // right-drag works without the unlock hotkey here, so save moves despite passive mode
  persistBoundsWhenPassive: true,
  log,
  hardenBrowserWindowNavigation,
  overlayWindowFile: ARBI_SUMMARY_WINDOW_FILE,
  windowLabel: "arbi summary window",
  preloadFileName: "preload-arbi.js",
  placement: "top-right",
  displayMode: "primary",
  windowWidth: WIN_W,
  windowHeight: WIN_H,
  minWindowWidth: WIN_W,
  minWindowHeight: WIN_H,
  transparent: false,
  backgroundColor: "#060a12",
  hasShadow: false,
  ignoreMouseEventsForward: false,
  windowStateKey: "arbiSummary",
  onWindowBoundsChanged: rememberOverlayWindowBounds,
});

export function isArbiSummaryWindow(win: InstanceType<typeof BrowserWindow>): boolean {
  return !!ctx.arbiSummaryWindow && win === ctx.arbiSummaryWindow;
}

function makeClickable(): void {
  const win = ctx.arbiSummaryWindow;
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(false);
}

function hideArbiSummary(): void {
  arbiSummaryWindowsController.clearOverlayAutoHideTimer();
  const win = ctx.arbiSummaryWindow;
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

export function maybeShowArbiSummary(run: ArbiRunRecord): void {
  if (!isArbiSummaryOverlayEnabled(ctx.overlaySettings)) return;
  const payload = buildArbiSummaryPayload(run);
  if (!payload) return;

  log.info(
    `[ArbiSummary] showing overlay for ${payload.id} (${payload.node}, ${payload.rotations} rotations)`,
  );
  arbiSummaryWindowsController.createOverlayWindow();
  makeClickable();
  arbiSummaryWindowsController.sendOverlayEvent(ARBI_SUMMARY_DATA, payload);
  arbiSummaryWindowsController.scheduleOverlayAutoHide(AUTO_HIDE_MS);
}

/** Setup placement step: where the window would appear right now (saved or default). */
export function getArbiSummaryPlacementRect() {
  return arbiSummaryWindowsController.getOverlayBoundsForActiveDisplay();
}

export function positionArbiSummaryWindow(): void {
  arbiSummaryWindowsController.positionOverlayWindow(arbiSummaryWindowsController.getAnchorMeta());
}

export function configureOverlaySettingsPersistence(persist: () => void): void {
  persistOverlaySettings = persist;
}

export function register(): void {
  onAuthorized(ARBI_SUMMARY_READY, assertArbiSummarySender, (event) => {
    arbiSummaryWindowsController.markRendererReady(event.sender.id);
    // Window (re)load resets ignore-mouse-events; re-apply once it's alive.
    makeClickable();
  });

  onAuthorized(ARBI_SUMMARY_CLOSE, assertArbiSummarySender, () => {
    hideArbiSummary();
  });

  onAuthorized(ARBI_SUMMARY_OPEN_DETAILS, assertArbiSummarySender, (_event, rawRunId: unknown) => {
    const runId = typeof rawRunId === "string" ? rawRunId : "";
    hideArbiSummary();

    const main = ctx.mainWindow;
    if (!main || main.isDestroyed()) return;
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    if (runId) main.webContents.send(ARBI_OPEN_RUN, runId);
  });
}
