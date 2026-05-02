export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

type DurationMode = "countdown" | "strictCountdown" | "remaining" | "buildCompact";

function formatDurationMs(durationMs: number, mode: DurationMode): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return mode === "remaining" ? "Ready!" : mode === "buildCompact" ? "" : "Refreshing...";
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const totalMinutes =
    mode === "buildCompact" ? Math.round(durationMs / 60_000) : Math.floor(durationMs / 60_000);
  const totalHours = Math.floor(durationMs / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = mode === "buildCompact" ? Math.floor(totalMinutes / 60) % 24 : totalHours % 24;
  const minutes =
    mode === "buildCompact" ? totalMinutes % 60 : Math.floor((durationMs % 3_600_000) / 60_000);
  const seconds = totalSeconds % 60;

  if (mode === "buildCompact") {
    if (durationMs < 60_000) return `${Math.max(1, totalSeconds)}s`;
    if (days > 0) {
      if (hours === 0 && minutes === 0) return `${days}d`;
      if (minutes === 0) return `${days}d ${hours}h`;
      if (hours === 0) return `${days}d ${minutes}m`;
      return `${days}d ${hours}h ${minutes}m`;
    }
    if (hours === 0) return `${minutes}m`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  if (mode === "remaining") {
    return totalHours > 24 ? `${days}d ${hours}h` : `${totalHours}h ${minutes}m`;
  }

  if (mode === "strictCountdown") {
    return totalHours > 0 ? `${totalHours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
  }

  return totalHours > 24 ? `${days}d ${hours}h` : `${totalHours}h ${minutes}m ${seconds}s`;
}

export function timeTo(date: Date | null, nowMs: number = Date.now()): string {
  if (!date) return "N/A";
  return formatDurationMs(date.getTime() - nowMs, "countdown");
}

export function timeToStrict(date: Date | null, nowMs: number = Date.now()): string {
  if (!date) return "N/A";
  return formatDurationMs(date.getTime() - nowMs, "strictCountdown");
}

export function formatNumber(num: number): string {
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
  return num.toLocaleString();
}

export function formatTimeRemaining(endDate: Date, nowMs: number = Date.now()): string {
  return formatDurationMs(endDate.getTime() - nowMs, "remaining");
}

export function formatBuildTime(seconds: number): string {
  return formatDurationMs(seconds * 1000, "buildCompact");
}

export function nextDailyResetUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export function nextWeeklyResetUtc(now: Date = new Date()): Date {
  const day = now.getUTCDay();
  let daysUntilMonday = (8 - day) % 7;
  if (daysUntilMonday === 0) daysUntilMonday = 7;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday),
  );
}

export function cycleTimeDisplay(
  apiTimeLeft: string | null | undefined,
  expiryIso: string | null | undefined,
  nowMs: number = Date.now(),
): string {
  const expiry = parseIsoDate(expiryIso ?? null);
  if (expiry) {
    return timeToStrict(expiry, nowMs);
  }

  const api = (apiTimeLeft ?? "").trim();
  if (api && !/^0h?\s*0m?\s*(0s)?$/i.test(api) && !/^0m?\s*0s?$/i.test(api)) {
    return api;
  }

  return timeTo(expiry, nowMs);
}
