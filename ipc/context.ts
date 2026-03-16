/**
 * Shared mutable state for the main process.
 * All IPC modules import from here so they share the same references.
 */

import type { BrowserWindow } from "electron";
import type { FSWatcher } from "chokidar";

type InventoryData = Record<string, unknown> | null;
type OverlaySettings = Record<string, unknown>;
type OverlayThemeVars = Record<string, string>;

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let plannerOverlayWindow: BrowserWindow | null = null;
let rivenOverlayLeftWindow: BrowserWindow | null = null;
let rivenOverlayRightWindow: BrowserWindow | null = null;
let cropDebugWindow: BrowserWindow | null = null;
let currentInventoryPath: string | null = null;
let currentInventoryData: InventoryData = null;
let watcher: FSWatcher | null = null;
let overlaySettings: OverlaySettings = {};
let overlayThemeVars: OverlayThemeVars = {};
let overlayHotkeyRegistered: string | null = null;
let overlayCropHotkeyRegistered: string | null = null;
let overlayInteractionHotkeyRegistered: string | null = null;
let overlayInteractiveMode = false;
let overlayDismissedUntilMs = 0;

const ctx = {
  get mainWindow() {
    return mainWindow;
  },
  set mainWindow(v: BrowserWindow | null) {
    mainWindow = v;
  },

  get overlayWindow() {
    return overlayWindow;
  },
  set overlayWindow(v: BrowserWindow | null) {
    overlayWindow = v;
  },

  get plannerOverlayWindow() {
    return plannerOverlayWindow;
  },
  set plannerOverlayWindow(v: BrowserWindow | null) {
    plannerOverlayWindow = v;
  },

  get rivenOverlayLeftWindow() {
    return rivenOverlayLeftWindow;
  },
  set rivenOverlayLeftWindow(v: BrowserWindow | null) {
    rivenOverlayLeftWindow = v;
  },

  get rivenOverlayRightWindow() {
    return rivenOverlayRightWindow;
  },
  set rivenOverlayRightWindow(v: BrowserWindow | null) {
    rivenOverlayRightWindow = v;
  },

  get cropDebugWindow() {
    return cropDebugWindow;
  },
  set cropDebugWindow(v: BrowserWindow | null) {
    cropDebugWindow = v;
  },

  get currentInventoryPath() {
    return currentInventoryPath;
  },
  set currentInventoryPath(v: string | null) {
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
    overlayHotkeyRegistered = v;
  },

  get overlayCropHotkeyRegistered() {
    return overlayCropHotkeyRegistered;
  },
  set overlayCropHotkeyRegistered(v: string | null) {
    overlayCropHotkeyRegistered = v;
  },

  get overlayInteractionHotkeyRegistered() {
    return overlayInteractionHotkeyRegistered;
  },
  set overlayInteractionHotkeyRegistered(v: string | null) {
    overlayInteractionHotkeyRegistered = v;
  },

  get overlayInteractiveMode() {
    return overlayInteractiveMode;
  },
  set overlayInteractiveMode(v: boolean) {
    overlayInteractiveMode = !!v;
  },

  get overlayDismissedUntilMs() {
    return overlayDismissedUntilMs;
  },
  set overlayDismissedUntilMs(v: number) {
    overlayDismissedUntilMs = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
  },
};

export default ctx;
