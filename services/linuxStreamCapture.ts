// Persistent-stream screen capture for Linux. Per-scan desktopCapturer.getSources()
// reopens the Wayland portal picker every time; instead we hold ONE
// getDisplayMedia stream in a hidden window so the portal prompts once per session.

import type { BrowserWindow as BrowserWindowType, NativeImage } from "electron";
import path from "node:path";

import { withScope } from "./logger";
import { hardenBrowserWindowNavigation } from "./windowSecurity";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("linuxStreamCapture");

const APP_ROOT = path.join(__dirname, "..");
const CAPTURE_WINDOW_FILE = path.join(APP_ROOT, "renderer", "linux-capture.html");

// After a decline, don't re-prompt on every scan retry.
const DECLINE_COOLDOWN_MS = 60_000;
// The portal picker is interactive; give the user time to answer.
const STREAM_START_TIMEOUT_MS = 120_000;
const GRAB_TIMEOUT_MS = 5_000;

let _win: BrowserWindowType | null = null;
let _starting: Promise<boolean> | null = null;
let _handlerInstalled = false;
let _declinedAt = 0;

function _now(): number {
  return Date.now();
}

async function _installDisplayMediaHandler(win: BrowserWindowType): Promise<void> {
  if (_handlerInstalled) return;
  const { desktopCapturer } = await import("electron");
  // Routes the page's getDisplayMedia; getSources() opens the Wayland picker.
  win.webContents.session.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          if (sources.length > 0) callback({ video: sources[0] });
          else callback({} as never);
        })
        .catch((err) => {
          log.warn("[LinuxCapture] getSources failed:", normalizeErrorMessage(err));
          callback({} as never);
        });
    },
    { useSystemPicker: true },
  );
  _handlerInstalled = true;
}

async function _createWindow(): Promise<BrowserWindowType | null> {
  try {
    const { BrowserWindow } = await import("electron");
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 180,
      skipTaskbar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false, // keep the <video> element decoding while hidden
      },
    });
    hardenBrowserWindowNavigation(win, {
      label: "linux-capture",
      allowedFilePaths: [CAPTURE_WINDOW_FILE],
      log,
    });
    await _installDisplayMediaHandler(win);
    win.on("closed", () => {
      if (_win === win) _win = null;
    });
    await win.loadFile(CAPTURE_WINDOW_FILE);
    // _exec passes userGesture=true; getDisplayMedia needs a user activation.
    await _exec(win, "window.__startCapture && window.__startCapture()");
    return win;
  } catch (err) {
    log.warn("[LinuxCapture] window creation failed:", normalizeErrorMessage(err));
    return null;
  }
}

async function _exec<T>(win: BrowserWindowType, script: string): Promise<T | null> {
  try {
    return (await win.webContents.executeJavaScript(script, true)) as T;
  } catch (err) {
    log.warn("[LinuxCapture] executeJavaScript failed:", normalizeErrorMessage(err));
    return null;
  }
}

async function _waitForLiveStream(win: BrowserWindowType): Promise<boolean> {
  const deadline = _now() + STREAM_START_TIMEOUT_MS;
  for (;;) {
    const state = await _exec<string>(win, "window.__captureState && window.__captureState()");
    if (state === "live") return true;
    if (state === "dead" || state === null) return false;
    if (_now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Ensure the hidden window exists and its stream is live. One prompt max. */
async function _ensureStream(): Promise<boolean> {
  if (_win && !_win.isDestroyed()) {
    const state = await _exec<string>(_win, "window.__captureState && window.__captureState()");
    if (state === "live") return true;
    if (state === "starting") return _waitForLiveStream(_win);
    // dead: tear down and maybe recreate below
    _win.destroy();
    _win = null;
  }

  if (_now() - _declinedAt < DECLINE_COOLDOWN_MS) return false;

  if (!_starting) {
    _starting = (async () => {
      const win = await _createWindow();
      if (!win) return false;
      _win = win;
      const live = await _waitForLiveStream(win);
      if (!live) {
        _declinedAt = _now();
        log.warn(
          `[LinuxCapture] stream not acquired (portal declined/failed) - cooling down ${Math.round(DECLINE_COOLDOWN_MS / 1000)}s`,
        );
        win.destroy();
        _win = null;
      } else {
        log.info("[LinuxCapture] persistent capture stream acquired");
      }
      return live;
    })().finally(() => {
      _starting = null;
    });
  }
  return _starting;
}

/**
 * Grab one frame from the persistent stream as a NativeImage.
 * Returns null when the stream is unavailable (declined portal, cooldown).
 */
export async function captureLinuxStreamFrame(): Promise<NativeImage | null> {
  const live = await _ensureStream();
  if (!live || !_win || _win.isDestroyed()) return null;

  const grab = _exec<string | null>(_win, "window.__grabFrame && window.__grabFrame()");
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), GRAB_TIMEOUT_MS));
  const dataUrl = await Promise.race([grab, timeout]);
  if (!dataUrl || typeof dataUrl !== "string") return null;

  try {
    const { nativeImage } = await import("electron");
    const img = nativeImage.createFromDataURL(dataUrl);
    if (!img || img.isEmpty()) return null;
    return img;
  } catch (err) {
    log.warn("[LinuxCapture] frame decode failed:", normalizeErrorMessage(err));
    return null;
  }
}

/** Close the hidden capture window (app shutdown). */
export function disposeLinuxStreamCapture(): void {
  if (_win && !_win.isDestroyed()) _win.destroy();
  _win = null;
}
