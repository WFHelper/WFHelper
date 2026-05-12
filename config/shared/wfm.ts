import { normalizeForSlug } from "./textNormalize";

/**
 * Shared Warframe Market constants and helpers used by main-process,
 * renderer, and (optionally) the worker.
 *
 * Centralizes headers, asset URLs, and slug normalization that were
 * previously duplicated across 8+ files.
 */

/** Warframe.market user presence status. */
export type WfmStatus = "online" | "ingame" | "invisible";

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

/** Base URL for warframe.market static assets (icons, thumbnails). */
export const WFM_ASSET_BASE = "https://warframe.market/static/assets/";

/** Normalize a WFM asset path to an absolute URL. */
export function formatWfmAssetUrl(path: unknown): string | null {
  if (typeof path !== "string" || !path.trim()) return null;
  const trimmed = path.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `${WFM_ASSET_BASE}${trimmed}`;
}

export function titleFromSlug(slug: string): string {
  return String(slug)
    .replace(/_/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/**
 * Normalize a warframe.market item slug.
 *
 * - Trims and lowercases.
 * - Strips ASCII and Unicode apostrophes (U+0027, U+2019, U+2018) so
 *   `"Loki's Decoy"` and `"Loki\u2019s Decoy"` both map to `lokis_decoy`
 *   (matching WFM canonical slugs).
 * - Collapses non-alphanumeric runs to underscores.
 * - Strips leading/trailing underscores.
 *
 * Returns `null` for non-string or empty input.
 */
export function normalizeWfmSlug(value: string | null | undefined): string | null {
  return normalizeForSlug(value);
}

export function normalizeWfmSlugKey(value: unknown): string {
  return normalizeWfmSlug(typeof value === "string" ? value : null) ?? "";
}
