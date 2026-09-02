// Development logs to the console. Production forwards warnings and errors to
// the main-process file logger and suppresses lower levels.

const isDev = import.meta.env.MODE === "development";

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function sendToMain(message: string, ...args: unknown[]): void {
  try {
    (window as { api?: { logWarn?: (m: string, ...a: unknown[]) => void } }).api?.logWarn?.(
      message,
      ...args,
    );
  } catch {
    // non-fatal - if IPC isn't ready, skip silently
  }
}

const RESIZE_OBSERVER_LOOP_RE =
  /^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)$/;
// Chromium's "Uncaught" on a window error, the "Error:" a stringified Error
// carries and the trailing full stop are wording, not part of the message.
const ERROR_NOISE_PREFIX_RE = /^(?:uncaught\s+)?(?:error:\s*)?/i;

/** Chromium raises these when an observer callback resizes what it observes
    (bind:clientWidth on the layout grid does). A benign frame skip, not a
    failure: anything else that merely mentions a ResizeObserver is real. */
export function isResizeObserverLoopError(reason: unknown): boolean {
  const text = reason instanceof Error ? reason.message : String(reason ?? "");
  const message = text.trim().replace(ERROR_NOISE_PREFIX_RE, "").replace(/\.$/, "").trim();
  return RESIZE_OBSERVER_LOOP_RE.test(message);
}

export const log = {
  info(message: string, ...args: unknown[]): void {
    if (isDev) {
      console.log(`[${timestamp()}] ${message}`, ...args);
    }
  },

  warn(message: string, ...args: unknown[]): void {
    if (isDev) {
      console.warn(`[${timestamp()}] ${message}`, ...args);
    } else {
      sendToMain(message, ...args);
    }
  },

  error(message: string, ...args: unknown[]): void {
    if (isDev) {
      console.error(`[${timestamp()}] ${message}`, ...args);
    } else {
      sendToMain(message, ...args);
    }
  },
} as const;
