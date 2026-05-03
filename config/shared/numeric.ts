/**
 * Shared numeric utilities used by main-process, renderer, and worker.
 *
 * Central definitions that replace ~30 file-local duplicates scattered
 * across the codebase.  Every function is side-effect-free and safe to
 * call with arbitrary untrusted input.
 */

// Constants

/** Highest mod/arcane rank the app supports for cache keys and API queries. */
export const MAX_SUPPORTED_RANK = 20;

/** Inventory groups whose items carry a rank (mods, arcanes). */
export const RANKED_GROUPS: readonly string[] = Object.freeze(["mods", "arcanes"]);

// Core numeric coercion

/**
 * Coerce an unknown value to a finite number or `null`.
 *
 * Handles:
 * - Already-a-number: returned if finite.
 * - Non-empty trimmed string: parsed via `Number()`, returned if finite.
 * - BSON-style boxed objects (`$numberInt`, `$numberLong`, …): recursively
 *   unwrapped.
 *
 * Returns `null` for anything else (`NaN`, `Infinity`, empty strings,
 * `null`, `undefined`, booleans, arrays, …).
 */
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

// Clamping

/**
 * Clamp a value between `min` and `max` (inclusive).
 *
 * When called with 3 args the value must already be a number.
 * When a 4th `fallback` arg is provided the value is first coerced
 * via `Number()` and, if the result is not finite, `fallback` is
 * returned instead of clamping.
 */
export function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback?: number,
): number {
  const n = fallback !== undefined ? Number(value) : (value as number);
  if (!Number.isFinite(n)) return fallback as number;
  return Math.max(min, Math.min(max, n));
}

// Rank normalisation

/**
 * Parse an unknown value into a non-negative integer rank, optionally
 * clamped to an upper bound.
 *
 * Returns `null` for values that are not finite non-negative numbers,
 * empty strings, or `null`/`undefined`.
 */
export function normalizeRank(value: unknown, maxRank?: number): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim().length === 0) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const floored = Math.floor(parsed);
  if (maxRank !== undefined && floored > maxRank) return null;
  return floored;
}

/**
 * Convenience: {@link normalizeRank} clamped to {@link MAX_SUPPORTED_RANK}.
 *
 * Use this when the rank represents a filter/cache-key for WFM price
 * lookups rather than an inventory-level rank.
 */
export function normalizeRankFilter(value: unknown): number | null {
  return normalizeRank(value, MAX_SUPPORTED_RANK);
}

/**
 * Coerce a value to a finite positive (> 0) integer, or `null`.
 *
 * Useful for parsing `maxRank` values where 0 is not meaningful.
 */
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

// Ranked-group predicate

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
