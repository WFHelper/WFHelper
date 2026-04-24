/**
 * tradeNotificationIpc.ts — Manages the trade notification overlay window.
 *
 * Shows a small, transient, always-on-top toast when a WFM order is
 * auto-closed after an in-game trade completes.
 */

import ctx from "./context";
import { assertTradeNotificationSender, onAuthorized } from "./ipcSecurity";
import { withScope } from "../services/logger";
import { hardenBrowserWindowNavigation } from "../services/windowSecurity";
import {
  TRADE_NOTIFICATION_SHOW, TRADE_NOTIFICATION_DISMISS,
} from "../config/shared/ipcChannels";
import type { TradeMatchPayload } from "../config/shared/tradeMatch";

const log = withScope("tradeNotificationIpc");

import path from "node:path";
import { app, BrowserWindow, screen } from "electron";

// ── Constants ─────────────────────────────────────────────────────────────────

const WIN_W = 370;
const WIN_H = 80;
const MARGIN = 16;
const NOTIFICATION_FILE = path.join(__dirname, "..", "renderer", "trade-notification.html");

// Timing: the renderer shows the toast for RENDERER_VISIBLE_MS, then fades out
// over RENDERER_FADE_MS. The main process hides the window slightly later so
// the renderer always finishes its animation before visibility is revoked.
const RENDERER_VISIBLE_MS = 5_000;
const RENDERER_FADE_MS = 400;
const MAIN_HIDE_BUFFER_MS = 600;
const AUTO_HIDE_MS = RENDERER_VISIBLE_MS + RENDERER_FADE_MS + MAIN_HIDE_BUFFER_MS;

/** Payload sent to the notification renderer. Shape is stable so the vanilla
 *  JS renderer can read it without importing TypeScript types. */
export interface TradeNotificationShowPayload {
  match: TradeMatchPayload;
  timing: {
    visibleMs: number;
    fadeMs: number;
  };
}

// ── State ─────────────────────────────────────────────────────────────────────

let _hideTimer: ReturnType<typeof setTimeout> | null = null;

// ── Window lifecycle ──────────────────────────────────────────────────────────

function _getOrCreateWindow(): InstanceType<typeof BrowserWindow> {
  const existing = ctx.tradeNotificationWindow;
  if (existing && !existing.isDestroyed()) return existing;

  const preloadPath = path.join(
    app.getAppPath(),
    ".electron-build",
    "preload-trade-notification.js",
  );

  const primaryDisplay = screen.getPrimaryDisplay();
  const { x: dX, y: dY, width: dW } = primaryDisplay.workArea;

  const win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: dX + dW - WIN_W - MARGIN,
    y: dY + MARGIN,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  hardenBrowserWindowNavigation(win, {
    label: "trade notification window",
    allowedFilePaths: [NOTIFICATION_FILE],
    log,
  });

  void win.loadFile(NOTIFICATION_FILE);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.on("closed", () => {
    ctx.tradeNotificationWindow = null;
    if (_hideTimer) {
      clearTimeout(_hideTimer);
      _hideTimer = null;
    }
  });

  ctx.tradeNotificationWindow = win;
  return win;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Show a trade-finished notification for a matched WFM order.
 */
export function showTradeNotification(match: TradeNotificationShowPayload["match"]): void {
  const win = _getOrCreateWindow();
  const payload: TradeNotificationShowPayload = {
    match,
    timing: { visibleMs: RENDERER_VISIBLE_MS, fadeMs: RENDERER_FADE_MS },
  };
  win.webContents.send(TRADE_NOTIFICATION_SHOW, payload);
  win.showInactive();
  win.moveTop();

  // Auto-hide after delay — always slightly later than the renderer's
  // visibleMs + fadeMs so the animation completes before visibility is revoked.
  if (_hideTimer) clearTimeout(_hideTimer);
  _hideTimer = setTimeout(() => {
    if (!win.isDestroyed()) win.hide();
    _hideTimer = null;
  }, AUTO_HIDE_MS);

  log.log(
    `[TradeNotification] Showing: ${match.type} ${match.itemName} ${match.platinum}p with ${match.partner}`,
  );
}

/**
 * Register IPC handlers from the notification overlay window.
 */
export function register(): void {
  onAuthorized(TRADE_NOTIFICATION_DISMISS, assertTradeNotificationSender, () => {
    const win = ctx.tradeNotificationWindow;
    if (win && !win.isDestroyed()) win.hide();
    if (_hideTimer) {
      clearTimeout(_hideTimer);
      _hideTimer = null;
    }
  });
}
