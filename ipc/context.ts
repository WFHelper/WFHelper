/**
 * Shared mutable state for the main process.
 * All IPC modules import from here so they share the same references.
 */

import type { BrowserWindow } from "electron";
import type { FSWatcher } from "chokidar";

type InventoryData = Record<string, unknown> | null;
type OverlaySettings = Record<string, unknown>;

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let cropDebugWindow: BrowserWindow | null = null;
let currentInventoryPath: string | null = null;
let currentInventoryData: InventoryData = null;
let watcher: FSWatcher | null = null;
let ALECA_KEY: Buffer | null = null;
let ALECA_IV: Buffer | null = null;
let overlaySettings: OverlaySettings = {};
let overlayHotkeyRegistered: string | null = null;
let overlayCropHotkeyRegistered: string | null = null;

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

  get ALECA_KEY() {
    return ALECA_KEY;
  },
  set ALECA_KEY(v: Buffer | null) {
    ALECA_KEY = v;
  },

  get ALECA_IV() {
    return ALECA_IV;
  },
  set ALECA_IV(v: Buffer | null) {
    ALECA_IV = v;
  },

  get overlaySettings() {
    return overlaySettings;
  },
  set overlaySettings(v: OverlaySettings) {
    overlaySettings = v;
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
};

export default ctx;
