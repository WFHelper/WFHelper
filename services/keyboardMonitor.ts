import { withScope } from "./logger";

const { uIOhook, UiohookKey } = require("uiohook-napi") as typeof import("uiohook-napi");

const log = withScope("keyboardMonitor");

let escCallback: (() => void) | null = null;
let isRunning = false;

uIOhook.on("keydown", (e) => {
  if (e.keycode === UiohookKey.Escape && typeof escCallback === "function") {
    escCallback();
  }
});

/**
 * Activate the ESC observer and register a callback.
 * Starts the low-level keyboard hook if it isn't already running.
 * The hook observes keypresses without consuming them — the focused
 * application (e.g. Warframe) still receives the key normally.
 */
export function startEscMonitor(callback: () => void): void {
  escCallback = callback;
  if (isRunning) return;
  try {
    uIOhook.start();
    isRunning = true;
    log.log("[KeyboardMonitor] hook started");
  } catch (err) {
    log.warn("[KeyboardMonitor] start failed:", String(err));
  }
}

/**
 * Deactivate the ESC observer and stop the low-level keyboard hook.
 * Safe to call even if the hook isn't running.
 */
export function stopEscMonitor(): void {
  escCallback = null;
  if (!isRunning) return;
  try {
    uIOhook.stop();
    isRunning = false;
    log.log("[KeyboardMonitor] hook stopped");
  } catch (err) {
    log.warn("[KeyboardMonitor] stop failed:", String(err));
  }
}
