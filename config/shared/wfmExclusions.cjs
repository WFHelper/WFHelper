"use strict";

const BLOOD_FOR_SLUGS = new Set(["blood_for_ammo", "blood_for_energy", "blood_for_life"]);

// Slugs that exist in the Warframe inventory but have no WFM listing at all.
// Excluded from every price AND meta lookup. Add entries here when an item
// produces repeated 404s (e.g. vendor packs, internal placeholder items).
const WFM_EXCLUDED_SLUGS = new Set(["vendor-relic"]);

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeSlug(value) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeName(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

/**
 * @param {unknown} slug
 * @returns {boolean}
 */
function isVeiledRivenSlug(slug) {
  const normalized = normalizeSlug(slug);
  return /(^|_)riven_mod_veiled$/.test(normalized);
}

/**
 * @param {unknown} name
 * @returns {boolean}
 */
function isVeiledRivenName(name) {
  const normalized = normalizeName(name);
  return /riven mod\s*\(veiled\)$/.test(normalized);
}

/**
 * @param {unknown} name
 * @param {unknown} slug
 * @returns {boolean}
 */
function isExcludedRankedMarketItem(name, slug) {
  const normalizedSlug = normalizeSlug(slug);
  if (BLOOD_FOR_SLUGS.has(normalizedSlug)) return true;
  if (isVeiledRivenSlug(normalizedSlug)) return true;

  const normalizedItemName = normalizeName(name);
  if (normalizedItemName === "blood for ammo") return true;
  if (normalizedItemName === "blood for energy") return true;
  if (normalizedItemName === "blood for life") return true;
  if (isVeiledRivenName(normalizedItemName)) return true;

  return false;
}

/**
 * Returns true for slugs that should never be looked up on warframe.market
 * (price OR meta). These are items that exist in the Warframe inventory but
 * are not tradable and have no WFM listing.
 *
 * @param {unknown} slug  Already-normalized WFM slug (lowercase, underscores)
 * @returns {boolean}
 */
function isWfmExcludedSlug(slug) {
  if (typeof slug !== "string" || !slug) return false;
  return WFM_EXCLUDED_SLUGS.has(slug);
}

module.exports = {
  BLOOD_FOR_SLUGS,
  WFM_EXCLUDED_SLUGS,
  isExcludedRankedMarketItem,
  isWfmExcludedSlug,
};
