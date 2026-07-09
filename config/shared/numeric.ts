/** Shared numeric utilities (main, renderer, worker). */

/** Highest mod/arcane rank the app supports for cache keys and API queries. */
const MAX_SUPPORTED_RANK = 20;

/** Unknown -> finite number or null. Unwraps BSON-style boxed numbers. */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const boxed =
      record.$numberInt ??
      record.$numberLong ??
      record.$numberDouble ??
      record.$numberDecimal ??
      record.$numberFloat;
    if (boxed !== undefined) return toFiniteNumber(boxed);
  }
  return null;
}

export function isTimestampFresh(
  timestamp: unknown,
  ttlMs: number,
  nowMs: number = Date.now(),
): boolean {
  const parsed = toFiniteNumber(timestamp);
  return parsed != null && parsed > 0 && nowMs - parsed < ttlMs;
}

export function isCacheEntryFresh(
  entry: unknown,
  okTtlMs: number,
  noDataTtlMs: number,
  options: { timestampKey?: string } = {},
): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  const status = String(record.status || "").toLowerCase();
  if (!status) return false;

  const timestampKey = options.timestampKey || "timestamp";
  return isTimestampFresh(record[timestampKey], status === "ok" ? okTtlMs : noDataTtlMs);
}

/**
 * Like {@link toFiniteNumber} but returns a configurable fallback instead
 * of `null`.
 */
export function toFiniteOr(value: unknown, fallback: number = 0): number {
  const n = toFiniteNumber(value);
  return n !== null ? n : fallback;
}

/**
 * Clamp to [min, max]. 3-arg form throws on a non-finite value; 4-arg form
 * coerces and returns `fallback` when not finite.
 */
export function clampNumber(value: number, min: number, max: number): number;
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number;
export function clampNumber(value: unknown, min: number, max: number, fallback?: number): number {
  const n = fallback !== undefined ? Number(value) : (value as number);
  if (!Number.isFinite(n)) {
    if (fallback === undefined) {
      throw new TypeError(`clampNumber: value must be finite, got ${String(value)}`);
    }
    return fallback;
  }
  return Math.max(min, Math.min(max, n));
}

/** Unknown -> non-negative integer rank (optionally clamped), else null. */
export function normalizeRank(value: unknown, maxRank?: number): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim().length === 0) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const floored = Math.floor(parsed);
  if (maxRank !== undefined && floored > maxRank) return null;
  return floored;
}

/** {@link normalizeRank} clamped to {@link MAX_SUPPORTED_RANK} - for WFM filter/cache keys. */
export function normalizeRankFilter(value: unknown): number | null {
  return normalizeRank(value, MAX_SUPPORTED_RANK);
}

/** Finite positive integer or null. */
export function toFinitePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return null;
}

/**
 * Coerce a value to a finite non-negative (>= 0) integer, or `null`.
 */
export function toFiniteNonNegativeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }
  return null;
}

export function normalizeDucats(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  return parsed != null && parsed >= 0 ? Math.round(parsed) : null;
}

/**
 * Return `true` when the given inventory group is rank-bearing
 * (currently `"mods"` or `"arcanes"`).
 */
export function isRankedGroup(group: string | null | undefined): boolean {
  return group === "mods" || group === "arcanes";
}

export function resolveRankedMaxRank(group: string | null | undefined): number {
  if (group === "mods") return 10;
  if (group === "arcanes") return 5;
  return 0;
}
