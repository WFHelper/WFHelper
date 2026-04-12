import { withScope } from "./logger";
import type { ScopedLogger } from "./logger";

import { normalizeErrorMessage } from "../config/shared/errors";

const log: ScopedLogger = withScope("crashReporter");

const DEFAULT_TRACES_SAMPLE_RATE: number = 0;

let sentryMain: typeof import("@sentry/electron/main") | null = null;
let initialized: boolean = false;

function resolveDsn(): string {
  return process.env.SENTRY_DSN || process.env.WF_COMPANION_SENTRY_DSN || "";
}

function parseSampleRate(rawValue: unknown, fallback: number): number {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0 || value > 1) return fallback;
  return value;
}

export function initCrashReporting(): boolean {
  if (initialized) return Boolean(sentryMain);
  initialized = true;

  const dsn = resolveDsn();
  if (!dsn) {
    log.info("Sentry disabled (no SENTRY_DSN configured)");
    return false;
  }

  try {
    sentryMain = require("@sentry/electron/main");
    sentryMain!.init({
      dsn,
      environment: process.env.NODE_ENV || "production",
      release: process.env.SENTRY_RELEASE || process.env.npm_package_version || undefined,
      tracesSampleRate: parseSampleRate(
        process.env.SENTRY_TRACES_SAMPLE_RATE,
        DEFAULT_TRACES_SAMPLE_RATE,
      ),
      attachStacktrace: true,
    });
    log.info("Sentry initialized for main process");
    return true;
  } catch (err: unknown) {
    log.error("Failed to initialize Sentry:", normalizeErrorMessage(err));
    sentryMain = null;
    return false;
  }
}

export function captureMainException(error: unknown, context: Record<string, unknown> = {}): void {
  if (!sentryMain) return;
  sentryMain.captureException(error, { extra: context });
}