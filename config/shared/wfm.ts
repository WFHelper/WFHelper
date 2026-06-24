import { normalizeForSlug } from "./textNormalize";

/**
 * Shared Warframe Market constants and helpers (headers, asset URLs, slug
 * normalization) used by main-process, renderer, and the worker.
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
const WFM_ASSET_BASE = "https://warframe.market/static/assets/";

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

// Slug normalizer for WFM URLs - see normalizeForSlug for the semantics.
export { normalizeForSlug as normalizeWfmSlug } from "./textNormalize";

export function normalizeWfmSlugKey(value: unknown): string {
  return normalizeForSlug(typeof value === "string" ? value : null) ?? "";
}
