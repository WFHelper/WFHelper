/**
 * Shared Warframe Market constants and helpers used by main-process,
 * renderer, and (optionally) the worker.
 *
 * Centralizes headers, asset URLs, and slug normalization that were
 * previously duplicated across 8+ files.
 */

// ---------------------------------------------------------------------------
// API headers
// ---------------------------------------------------------------------------

/**
 * Standard request headers for the warframe.market v1 API.
 *
 * Individual callers may spread these and add extras (e.g. `User-Agent`).
 */
export const WFM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Platform: "pc",
  Language: "en",
  Crossplay: "true",
  Accept: "application/json",
});

// ---------------------------------------------------------------------------
// Asset URLs
// ---------------------------------------------------------------------------

/** Base URL for warframe.market static assets (icons, thumbnails). */
export const WFM_ASSET_BASE = "https://warframe.market/static/assets/";

// ---------------------------------------------------------------------------
// Slug normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a warframe.market item slug.
 *
 * - Trims and lowercases.
 * - Strips ASCII apostrophes (U+0027). Unicode quotes become underscores.
 * - Collapses non-alphanumeric runs to underscores.
 * - Strips leading/trailing underscores.
 *
 * Returns `null` for non-string or empty input.
 */
export function normalizeWfmSlug(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || null;
}
