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
 * The callback is disarmed immediately so no further ESC events fire.
 * The actual native hook shutdown is deferred to the next event-loop turn
 * to avoid calling uIOhook.stop() from within the hook’s own callback chain,
 * which can deadlock the main thread for seconds on Windows.
 */
export function stopEscMonitor(): void {
  escCallback = null;
  if (!isRunning) return;
  // Defer: the hook thread is currently inside the keydown dispatch that
  // called us.  Stopping synchronously here would wait for that dispatch to
  // return, which can’t happen until WE return — classic re-entrant deadlock.
  setImmediate(() => {
    if (!isRunning) return; // another call already stopped it
    try {
      uIOhook.stop();
      isRunning = false;
      log.log("[KeyboardMonitor] hook stopped");
    } catch (err) {
      isRunning = false;
      log.warn("[KeyboardMonitor] stop failed:", String(err));
    }
  });
}
