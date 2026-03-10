"use strict";

const BLOOD_FOR_SLUGS = new Set(["blood_for_ammo", "blood_for_energy", "blood_for_life"]);

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

module.exports = {
  BLOOD_FOR_SLUGS,
  isExcludedRankedMarketItem,
};
