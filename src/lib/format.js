/**
 * Parse an ISO date string into a Date, or return null if invalid.
 * @param {string|null} value
 * @returns {Date|null}
 */
export function parseIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Human-readable countdown to a future Date.
 * Shows days when >= 24h, otherwise h/m/s.
 * @param {Date|null} date
 * @returns {string}
 */
export function timeTo(date) {
  if (!date) return 'N/A';
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return 'Refreshing...';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1_000);
  return h > 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m ${s}s`;
}

/**
 * Like timeTo, but always shows hours/minutes/seconds (never collapses to days).
 * @param {Date|null} date
 * @returns {string}
 */
export function timeToStrict(date) {
  if (!date) return 'N/A';
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return 'Refreshing...';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1_000);
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

/**
 * Format a large number with K/M suffixes.
 * @param {number} num
 * @returns {string}
 */
export function formatNumber(num) {
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
  return num.toLocaleString();
}

/**
 * Time remaining until a foundry item finishes building.
 * @param {Date} endDate
 * @returns {string}
 */
export function formatTimeRemaining(endDate) {
  const diff = endDate - new Date();
  if (diff <= 0) return 'Ready!';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
}

/** Next UTC midnight (daily reset). */
export function nextDailyResetUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Next Monday UTC midnight (weekly reset). */
export function nextWeeklyResetUtc(now = new Date()) {
  const day = now.getUTCDay(); // 0=Sun … 6=Sat
  let daysUntilMonday = (8 - day) % 7;
  if (daysUntilMonday === 0) daysUntilMonday = 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday));
}

/**
 * Prefer the API-provided time-left string if it is non-zero;
 * fall back to computing from the ISO expiry date.
 * @param {string} apiTimeLeft
 * @param {string} expiryIso
 * @returns {string}
 */
export function cycleTimeDisplay(apiTimeLeft, expiryIso) {
  const api = (apiTimeLeft || '').trim();
  if (api && !/^0h?\s*0m?\s*(0s)?$/i.test(api) && !/^0m?\s*0s?$/i.test(api)) return api;
  return timeTo(parseIsoDate(expiryIso));
}
