import { STAT_RESOURCES } from "./statsTypes";
import type { DailyStatEntry, StatResourceDay } from "./statsTypes";

const STAT_RESOURCE_IDS = new Set(STAT_RESOURCES.map((resource) => resource.id));

export const MAX_STATS_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_STATS_IMPORT_ROWS = 10_000;
export const MAX_TRADE_IMPORT_ROWS = 10_000;

const DELTA_KEYS = [
  "platDelta",
  "creditsDelta",
  "endoDelta",
  "ducatsDelta",
  "ayaDelta",
  "vitusDelta",
] as const;
const COUNT_KEYS = ["relicsOpened", "daysPlayed", "dailyTrades"] as const;
const BALANCE_KEYS = [
  "absPlat",
  "absCredits",
  "absEndo",
  "absDucats",
  "absAya",
  "absVitus",
] as const;

export function isValidStatsImportDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function assertStatsImportFileSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_STATS_IMPORT_FILE_BYTES) {
    throw new Error("Stats import file exceeds 50 MB.");
  }
}

export function assertStatsImportRowCount(count: number): void {
  if (!Number.isInteger(count) || count < 0 || count > MAX_STATS_IMPORT_ROWS) {
    throw new Error(`Stats import exceeds ${MAX_STATS_IMPORT_ROWS} rows.`);
  }
}

function isStatResourceDay(value: unknown): value is StatResourceDay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const day = value as Record<string, unknown>;
  if (!Number.isFinite(day.delta)) return false;
  return day.abs === undefined || Number.isFinite(day.abs);
}

// Only ids the catalog knows are checked; sanitizeStatsImportEntries drops the
// rest, so a hand-edited file cannot grow the persisted map.
function isValidResourceMap(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([id, day]) => !STAT_RESOURCE_IDS.has(id) || isStatResourceDay(day),
  );
}

export function isDailyStatEntry(value: unknown): value is DailyStatEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (!isValidStatsImportDate(entry.date)) return false;
  if (DELTA_KEYS.some((key) => !Number.isFinite(entry[key]))) return false;
  if (COUNT_KEYS.some((key) => !Number.isInteger(entry[key]) || (entry[key] as number) < 0)) {
    return false;
  }
  if (entry.resourcesVersion !== undefined && !Number.isInteger(entry.resourcesVersion)) {
    return false;
  }
  if (!isValidResourceMap(entry.resources)) return false;
  return BALANCE_KEYS.every(
    (key) =>
      entry[key] === undefined ||
      (typeof entry[key] === "number" && Number.isFinite(entry[key]) && entry[key] >= 0),
  );
}

/** Rebuilds the resource map with known ids only, keeping the row shape exact. */
export function sanitizeStatsImportEntries(entries: readonly DailyStatEntry[]): DailyStatEntry[] {
  return entries.map((entry) => {
    if (!entry.resources) return entry;
    const resources: Record<string, StatResourceDay> = {};
    for (const [id, day] of Object.entries(entry.resources)) {
      if (!STAT_RESOURCE_IDS.has(id)) continue;
      resources[id] =
        day.abs === undefined ? { delta: day.delta } : { delta: day.delta, abs: day.abs };
    }
    return { ...entry, resources };
  });
}

export function isValidStatsImportPayload(value: unknown): value is DailyStatEntry[] {
  return (
    Array.isArray(value) && value.length <= MAX_STATS_IMPORT_ROWS && value.every(isDailyStatEntry)
  );
}
