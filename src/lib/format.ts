export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function timeTo(date: Date | null, nowMs: number = Date.now()): string {
  if (!date) return "N/A";
  const diff = date.getTime() - nowMs;
  if (diff <= 0) return "Refreshing...";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1_000);
  return h > 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m ${s}s`;
}

export function timeToStrict(date: Date | null, nowMs: number = Date.now()): string {
  if (!date) return "N/A";
  const diff = date.getTime() - nowMs;
  if (diff <= 0) return "Refreshing...";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1_000);
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

export function formatNumber(num: number): string {
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
  return num.toLocaleString();
}

export function formatTimeRemaining(endDate: Date, nowMs: number = Date.now()): string {
  const diff = endDate.getTime() - nowMs;
  if (diff <= 0) return "Ready!";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
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
