/**
 * Structured renderer logger.
 *
 * In development: passes through to console.*.
 * In production: suppresses console noise; routes to Sentry breadcrumbs when enabled.
 */

import { captureRendererException } from "./crashReporting.js";

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
    }
  },

  error(message: string, ...args: unknown[]): void {
    if (isDev) {
      console.error(`[${timestamp()}] ${message}`, ...args);
    }
    // Always report errors to Sentry in production
    const errorArg = args.find((a) => a instanceof Error);
    if (errorArg instanceof Error) {
      captureRendererException(errorArg, { message });
    }
  },
} as const;
