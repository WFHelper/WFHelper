/**
 * Shared mutable state for the main process.
 * All IPC modules import from here so they share the same references.
 */

/** @type {Electron.BrowserWindow|null} */
let mainWindow = null;

/** @type {Electron.BrowserWindow|null} */
let overlayWindow = null;

/** @type {string|null} Path of the currently watched inventory file. */
let currentInventoryPath = null;

/** @type {object|null} Last-loaded raw inventory JSON. */
let currentInventoryData = null;

/** @type {import('chokidar').FSWatcher|null} */
let watcher = null;

/** @type {string|null} AlecaFrame decryption key (Buffer stored as key). */
let ALECA_KEY = null;

/** @type {string|null} AlecaFrame decryption IV (Buffer). */
let ALECA_IV = null;

/** Current overlay settings (normalised). */
let overlaySettings = {};

/** The currently registered hotkey accelerator string, or null. */
let overlayHotkeyRegistered = null;

module.exports = {
  get mainWindow() { return mainWindow; },
  set mainWindow(v) { mainWindow = v; },
  get overlayWindow() { return overlayWindow; },
  set overlayWindow(v) { overlayWindow = v; },
  get currentInventoryPath() { return currentInventoryPath; },
  set currentInventoryPath(v) { currentInventoryPath = v; },
  get currentInventoryData() { return currentInventoryData; },
  set currentInventoryData(v) { currentInventoryData = v; },
  get watcher() { return watcher; },
  set watcher(v) { watcher = v; },
  get ALECA_KEY() { return ALECA_KEY; },
  set ALECA_KEY(v) { ALECA_KEY = v; },
  get ALECA_IV() { return ALECA_IV; },
  set ALECA_IV(v) { ALECA_IV = v; },
  get overlaySettings() { return overlaySettings; },
  set overlaySettings(v) { overlaySettings = v; },
  get overlayHotkeyRegistered() { return overlayHotkeyRegistered; },
  set overlayHotkeyRegistered(v) { overlayHotkeyRegistered = v; },
};
