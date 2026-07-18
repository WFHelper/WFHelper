/**
 * Structured renderer logger.
 *
 * In development: passes through to console.*.
 * In production:
 *   - warn/error are forwarded to the main-process file transport via
 *     window.api.logWarn (IPC send -> main process electron-log).
 *   - info/debug are suppressed to avoid log noise.
 */

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
