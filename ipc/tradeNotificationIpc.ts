"use strict";

/**
 * tradeNotificationIpc.ts — Manages the trade notification overlay window.
 *
 * Shows a small, transient, always-on-top toast when a WFM order is
 * auto-closed after an in-game trade completes.
 */

import ctx from "./context";
import { withScope } from "../services/logger";
import { hardenBrowserWindowNavigation } from "../services/windowSecurity";

const log = withScope("tradeNotificationIpc");

const path = require("node:path") as typeof import("node:path");
const { app, BrowserWindow, ipcMain, screen } =
  require("electron") as typeof import("electron");

// ── Constants ─────────────────────────────────────────────────────────────────

const WIN_W = 370;
const WIN_H = 80;
const MARGIN = 16;
const NOTIFICATION_FILE = path.join(__dirname, "..", "renderer", "trade-notification.html");
const AUTO_HIDE_MS = 6_000;

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
export function showTradeNotification(match: {
  orderId: string;
  itemName: string;
  itemUrlName: string | null;
  itemThumb: string | null;
  quantity: number;
  platinum: number;
  partner: string;
  type: "sale" | "purchase";
}): void {
  const win = _getOrCreateWindow();
  win.webContents.send("trade-notification-show", match);
  win.showInactive();
  win.moveTop();

  // Auto-hide after delay
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
  ipcMain.on("trade-notification-dismiss", () => {
    const win = ctx.tradeNotificationWindow;
    if (win && !win.isDestroyed()) win.hide();
    if (_hideTimer) {
      clearTimeout(_hideTimer);
      _hideTimer = null;
    }
  });
}
