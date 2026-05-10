import { withScope } from "./logger";

const log = withScope("keyboardMonitor");

interface UiohookApi {
  on: (eventName: "keydown", callback: (event: { keycode: number }) => void) => void;
  stop: () => void;
}

interface UiohookModule {
  uIOhook: UiohookApi;
  UiohookKey: { Escape: number };
}

let escCallback: (() => void) | null = null;
let isRunning = false;
let uiohook: UiohookApi | null = null;

function isUiohookModule(value: unknown): value is UiohookModule {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UiohookModule>;
  return (
    typeof candidate.uIOhook?.on === "function" &&
    typeof candidate.uIOhook.stop === "function" &&
    typeof candidate.UiohookKey?.Escape === "number"
  );
}

function loadKeyboardHook(): UiohookApi | null {
  if (process.env.WFHELPER_DISABLE_KEYBOARD_HOOK === "1") {
    log.log("[KeyboardMonitor] native hook disabled by environment");
    return null;
  }

  try {
    const nativeHook = require("uiohook-napi") as unknown;
    if (!isUiohookModule(nativeHook)) {
      log.warn("[KeyboardMonitor] native hook module had an unexpected shape");
      return null;
    }

    nativeHook.uIOhook.on("keydown", (event) => {
      if (event.keycode === nativeHook.UiohookKey.Escape && typeof escCallback === "function") {
        escCallback();
      }
    });
    return nativeHook.uIOhook;
  } catch (err) {
    log.warn("[KeyboardMonitor] native hook unavailable:", String(err));
    return null;
  }
}

uiohook = loadKeyboardHook();

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
      uiohook?.stop();
      isRunning = false;
      log.log("[KeyboardMonitor] hook stopped");
    } catch (err) {
      isRunning = false;
      log.warn("[KeyboardMonitor] stop failed:", String(err));
    }
  });
}
