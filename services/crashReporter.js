const log = require("./logger").withScope("crashReporter");
const { normalizeErrorMessage } = require("../config/shared/errors.cjs");

const DEFAULT_TRACES_SAMPLE_RATE = 0;

let sentryMain = null;
let initialized = false;

function resolveDsn() {
  return process.env.SENTRY_DSN || process.env.WF_COMPANION_SENTRY_DSN || "";
}

function parseSampleRate(rawValue, fallback) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0 || value > 1) return fallback;
  return value;
}

function initCrashReporting() {
  if (initialized) return Boolean(sentryMain);
  initialized = true;

  const dsn = resolveDsn();
  if (!dsn) {
    log.info("Sentry disabled (no SENTRY_DSN configured)");
    return false;
  }

  try {
    sentryMain = require("@sentry/electron/main");
    sentryMain.init({
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
  } catch (err) {
    log.error("Failed to initialize Sentry:", normalizeErrorMessage(err));
    sentryMain = null;
    return false;
  }
}

function captureMainException(error, context = {}) {
  if (!sentryMain) return;
  sentryMain.captureException(error, { extra: context });
}

module.exports = {
  initCrashReporting,
  captureMainException,
};
