import * as Sentry from "@sentry/browser";

const DEFAULT_TRACES_SAMPLE_RATE = 0;

let enabled = false;

function parseSampleRate(rawValue: string | undefined, fallback: number): number {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0 || value > 1) return fallback;
  return value;
}

export function initRendererCrashReporting(): boolean {
  if (enabled) return true;

  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE || import.meta.env.VITE_APP_VERSION || undefined,
    tracesSampleRate: parseSampleRate(
      import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE,
      DEFAULT_TRACES_SAMPLE_RATE,
    ),
    integrations: [],
  });

  enabled = true;
  return true;
}

export function captureRendererException(
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  if (!enabled) return;
  const normalized = error instanceof Error ? error : new Error(String(error));
  Sentry.captureException(normalized, { extra: context });
}
