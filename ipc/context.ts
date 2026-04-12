/**
 * Shared mutable state for the main process.
 * All IPC modules import from here so they share the same references.
 */

import type { BrowserWindow } from "electron";
import type { FSWatcher } from "chokidar";
import { withScope } from "../services/logger";
import type { OverlaySettings } from "../config/runtime/overlaySettings";
import { OVERLAY_SETTINGS_DEFAULTS } from "../config/runtime/overlaySettings";

const log = withScope("ctx");

type InventoryData = Record<string, unknown> | null;
type OverlayThemeVars = Record<string, string>;

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let plannerOverlayWindow: BrowserWindow | null = null;
let rivenOverlayLeftWindow: BrowserWindow | null = null;
let rivenOverlayRightWindow: BrowserWindow | null = null;
let tradeNotificationWindow: BrowserWindow | null = null;
let currentInventoryPath: string | null = null;
let currentInventoryData: InventoryData = null;
let watcher: FSWatcher | null = null;
let overlaySettings = { ...OVERLAY_SETTINGS_DEFAULTS } as OverlaySettings;
let overlayThemeVars: OverlayThemeVars = {};
let overlayHotkeyRegistered: string | null = null;
let overlayInteractionHotkeyRegistered: string | null = null;
let overlayInteractiveMode = false;
let overlayDismissedUntilMs = 0;

const ctx = {
  get mainWindow() {
    return mainWindow;
  },
  set mainWindow(v: BrowserWindow | null) {
    log.log(`mainWindow ${mainWindow ? "set" : "null"} -> ${v ? "set" : "null"}`);
    mainWindow = v;
  },

  get overlayWindow() {
    return overlayWindow;
  },
  set overlayWindow(v: BrowserWindow | null) {
    log.log(`overlayWindow ${overlayWindow ? "set" : "null"} -> ${v ? "set" : "null"}`);
    overlayWindow = v;
  },

  get plannerOverlayWindow() {
    return plannerOverlayWindow;
  },
  set plannerOverlayWindow(v: BrowserWindow | null) {
    log.log(`plannerOverlayWindow ${plannerOverlayWindow ? "set" : "null"} -> ${v ? "set" : "null"}`);
    plannerOverlayWindow = v;
  },

  get rivenOverlayLeftWindow() {
    return rivenOverlayLeftWindow;
  },
  set rivenOverlayLeftWindow(v: BrowserWindow | null) {
    log.log(`rivenOverlayLeftWindow ${rivenOverlayLeftWindow ? "set" : "null"} -> ${v ? "set" : "null"}`);
    rivenOverlayLeftWindow = v;
  },

  get rivenOverlayRightWindow() {
    return rivenOverlayRightWindow;
  },
  set rivenOverlayRightWindow(v: BrowserWindow | null) {
    log.log(`rivenOverlayRightWindow ${rivenOverlayRightWindow ? "set" : "null"} -> ${v ? "set" : "null"}`);
    rivenOverlayRightWindow = v;
  },

  get tradeNotificationWindow() {
    return tradeNotificationWindow;
  },
  set tradeNotificationWindow(v: BrowserWindow | null) {
    log.log(`tradeNotificationWindow ${tradeNotificationWindow ? "set" : "null"} -> ${v ? "set" : "null"}`);
    tradeNotificationWindow = v;
  },

  get currentInventoryPath() {
    return currentInventoryPath;
  },
  set currentInventoryPath(v: string | null) {
    log.log(`currentInventoryPath ${currentInventoryPath ? "set" : "null"} -> ${v ? "set" : "null"}`);
    currentInventoryPath = v;
  },

  get currentInventoryData() {
    return currentInventoryData;
  },
  set currentInventoryData(v: InventoryData) {
    currentInventoryData = v;
  },

  get watcher() {
    return watcher;
  },
  set watcher(v: FSWatcher | null) {
    log.log(`watcher ${watcher ? "set" : "null"} -> ${v ? "set" : "null"}`);
    watcher = v;
  },

  get overlaySettings() {
    return overlaySettings;
  },
  set overlaySettings(v: OverlaySettings) {
    overlaySettings = v;
  },

  get overlayThemeVars() {
    return overlayThemeVars;
  },
  set overlayThemeVars(v: OverlayThemeVars) {
    overlayThemeVars = v;
  },

  get overlayHotkeyRegistered() {
    return overlayHotkeyRegistered;
  },
  set overlayHotkeyRegistered(v: string | null) {
    log.log(`overlayHotkeyRegistered "${overlayHotkeyRegistered}" -> "${v}"`);
    overlayHotkeyRegistered = v;
  },

  get overlayInteractionHotkeyRegistered() {
    return overlayInteractionHotkeyRegistered;
  },
  set overlayInteractionHotkeyRegistered(v: string | null) {
    log.log(`overlayInteractionHotkeyRegistered "${overlayInteractionHotkeyRegistered}" -> "${v}"`);
    overlayInteractionHotkeyRegistered = v;
  },

  get overlayInteractiveMode() {
    return overlayInteractiveMode;
  },
  set overlayInteractiveMode(v: boolean) {
    const next = !!v;
    if (next !== overlayInteractiveMode) {
      log.log(`overlayInteractiveMode ${overlayInteractiveMode} -> ${next}`);
    }
    overlayInteractiveMode = next;
  },

  get overlayDismissedUntilMs() {
    return overlayDismissedUntilMs;
  },
  set overlayDismissedUntilMs(v: number) {
    overlayDismissedUntilMs = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
  },
};

export default ctx;
