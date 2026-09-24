import { getOverlayDescriptor } from "../config/shared/overlayLayout";
import ctx from "./context";
import { assertArbiSummarySender, onAuthorized } from "./ipcSecurity";
import {
  createOverlayWindowBoundsChangeHandler,
  createOverlayWindowsController,
} from "./overlay/windows";
import { registerZOrderSubscriber, syncUnfocusHide } from "./overlay/zOrder";
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
const WIN_W = getOverlayDescriptor("arbiSummary").canvas.width;
const WIN_H = getOverlayDescriptor("arbiSummary").canvas.height;

let persistOverlaySettings: (() => void) | null = null;
const rememberOverlayWindowBounds = createOverlayWindowBoundsChangeHandler({
  ctx,
  save: () => {
    persistOverlaySettings?.();
  },
});

export const arbiSummaryWindowsController = createOverlayWindowsController({
  app,
  BrowserWindow,
  screen,
  ctx,
  getOverlayWindow: () => ctx.arbiSummaryWindow,
  setOverlayWindow: (window) => {
    ctx.arbiSummaryWindow = window;
  },
  getOverlayInteractiveMode: () => false,
  setOverlayInteractiveModeState: () => {},
  persistBoundsWhenPassive: true,
  // Click-through is never wanted here, and on X11 it cannot be undone.
  neverClickThrough: true,
  log,
  hardenBrowserWindowNavigation,
  overlayWindowFile: ARBI_SUMMARY_WINDOW_FILE,
  windowLabel: "arbi summary window",
  windowTitle: "WFHelper Arbitration Summary",
  preloadFileName: "preload-arbi.js",
  placement: "top-right",
  displayMode: "primary",
  windowWidth: WIN_W,
  windowHeight: WIN_H,
  minWindowWidth: WIN_W,
  minWindowHeight: WIN_H,
  transparent: true,
  hasShadow: false,
  windowStateKey: "arbiSummary",
  onWindowBoundsChanged: rememberOverlayWindowBounds,
});

registerZOrderSubscriber({
  isActive: () =>
    arbiSummaryWindowsController.isOverlayWindowVisible() ||
    arbiSummaryWindowsController.isHiddenByUnfocus(),
  sync: (warframeFocused, foreground) => {
    syncUnfocusHide("arbi summary", [arbiSummaryWindowsController], warframeFocused, foreground);
  },
});

export function isArbiSummaryWindow(win: InstanceType<typeof BrowserWindow>): boolean {
  return !!ctx.arbiSummaryWindow && win === ctx.arbiSummaryWindow;
}

function hideArbiSummary(): void {
  arbiSummaryWindowsController.clearOverlayAutoHideTimer();
  arbiSummaryWindowsController.hideOverlayWindow();
}

export function maybeShowArbiSummary(run: ArbiRunRecord): void {
  if (!isArbiSummaryOverlayEnabled(ctx.overlaySettings)) return;
  const payload = buildArbiSummaryPayload(run);
  if (!payload) return;

  log.info(
    `[ArbiSummary] showing overlay for ${payload.id} (${payload.node}, ${payload.rotations} rotations)`,
  );
  arbiSummaryWindowsController.createOverlayWindow();
  arbiSummaryWindowsController.sendOverlayEvent(ARBI_SUMMARY_DATA, payload);
  arbiSummaryWindowsController.scheduleOverlayAutoHide(AUTO_HIDE_MS);
}

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
