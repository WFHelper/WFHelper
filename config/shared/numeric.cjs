"use strict";

/**
 * Shared numeric utilities used by main-process, renderer, and worker.
 *
 * Central definitions that replace ~30 file-local duplicates scattered
 * across the codebase.  Every function is side-effect-free and safe to
 * call with arbitrary untrusted input.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Highest mod/arcane rank the app supports for cache keys and API queries. */
const MAX_SUPPORTED_RANK = 20;

/** Inventory groups whose items carry a rank (mods, arcanes). */
const RANKED_GROUPS = Object.freeze(["mods", "arcanes"]);

// ---------------------------------------------------------------------------
// Core numeric coercion
// ---------------------------------------------------------------------------

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
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = /** @type {Record<string, unknown>} */ (value);
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

/**
 * Like {@link toFiniteNumber} but returns a configurable fallback instead
 * of `null`.
 *
 * @param {unknown} value
 * @param {number}  fallback  Value returned when coercion fails (default `0`).
 * @returns {number}
 */
function toFiniteOr(value, fallback) {
  if (fallback === undefined) fallback = 0;
  const n = toFiniteNumber(value);
  return n !== null ? n : fallback;
}

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

/**
 * Clamp a value between `min` and `max` (inclusive).
 *
 * When called with 3 args the value must already be a number.
 * When a 4th `fallback` arg is provided the value is first coerced
 * via `Number()` and, if the result is not finite, `fallback` is
 * returned instead of clamping.
 *
 * @param {unknown} value
 * @param {number}  min
 * @param {number}  max
 * @param {number}  [fallback]  Returned when `Number(value)` is not finite.
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  const n = arguments.length >= 4 ? Number(value) : /** @type {number} */ (value);
  if (!Number.isFinite(n)) return /** @type {number} */ (fallback);
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// Rank normalisation
// ---------------------------------------------------------------------------

/**
 * Parse an unknown value into a non-negative integer rank, optionally
 * clamped to an upper bound.
 *
 * Returns `null` for values that are not finite non-negative numbers,
 * empty strings, or `null`/`undefined`.
 *
 * @param {unknown}  value
 * @param {number}   [maxRank]  Upper bound (inclusive).  When omitted no
 *                              upper bound is enforced.
 * @returns {number | null}
 */
function normalizeRank(value, maxRank) {
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
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeRankFilter(value) {
  return normalizeRank(value, MAX_SUPPORTED_RANK);
}

/**
 * Coerce a value to a finite positive (> 0) integer, or `null`.
 *
 * Useful for parsing `maxRank` values where 0 is not meaningful.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function toFinitePositiveInt(value) {
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
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function toFiniteNonNegativeInt(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ranked-group predicate
// ---------------------------------------------------------------------------

/**
 * Return `true` when the given inventory group is rank-bearing
 * (currently `"mods"` or `"arcanes"`).
 *
 * @param {string | null | undefined} group
 * @returns {boolean}
 */
function isRankedGroup(group) {
  return group === "mods" || group === "arcanes";
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  MAX_SUPPORTED_RANK,
  RANKED_GROUPS,
  toFiniteNumber,
  toFiniteOr,
  clampNumber,
  normalizeRank,
  normalizeRankFilter,
  toFinitePositiveInt,
  toFiniteNonNegativeInt,
  isRankedGroup,
};
