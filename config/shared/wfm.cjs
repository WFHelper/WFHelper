"use strict";

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
 * @type {Readonly<Record<string, string>>}
 */
const WFM_HEADERS = Object.freeze({
  Platform: "pc",
  Language: "en",
  Crossplay: "true",
  Accept: "application/json",
});

// ---------------------------------------------------------------------------
// Asset URLs
// ---------------------------------------------------------------------------

/** Base URL for warframe.market static assets (icons, thumbnails). */
const WFM_ASSET_BASE = "https://warframe.market/static/assets/";

// ---------------------------------------------------------------------------
// Slug normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a warframe.market item slug.
 *
 * - Trims and lowercases.
 * - Strips smart quotes / apostrophes.
 * - Collapses non-alphanumeric runs to underscores.
 * - Strips leading/trailing underscores.
 *
 * Returns `null` for non-string or empty input.
 *
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
function normalizeWfmSlug(value) {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  WFM_HEADERS,
  WFM_ASSET_BASE,
  normalizeWfmSlug,
};
