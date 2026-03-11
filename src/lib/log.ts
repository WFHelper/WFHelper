/**
 * Structured renderer logger.
 *
 * In development: passes through to console.*.
 * In production:
 *   - warn/error are forwarded to the main-process file transport via
 *     electron-log/renderer (requires the preload bridge set up in preload.ts).
 *   - error also captures to Sentry.
 *   - info/debug are suppressed to avoid log noise.
 */

import { captureRendererException } from "./crashReporting.js";
import electronLog from "electron-log/renderer";

const isDev = import.meta.env.MODE === "development";

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
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
      electronLog.warn(message, ...args);
    }
  },

  error(message: string, ...args: unknown[]): void {
    if (isDev) {
      console.error(`[${timestamp()}] ${message}`, ...args);
    } else {
      electronLog.error(message, ...args);
    }
    // Always report errors to Sentry in production
    const errorArg = args.find((a) => a instanceof Error);
    if (errorArg instanceof Error) {
      captureRendererException(errorArg, { message });
    }
  },
} as const;
