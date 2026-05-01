import { normalizeWfmSlug } from "./wfm";
import { normalizeForSearch } from "./textNormalize";

const BLOOD_FOR_SLUGS = new Set(["blood_for_ammo", "blood_for_energy", "blood_for_life"]);

// Slugs that exist in the Warframe inventory but have no WFM listing at all.
// Excluded from every price AND meta lookup. Add entries here when an item
// produces repeated 404s (e.g. vendor packs, internal placeholder items).
const WFM_EXCLUDED_SLUGS = new Set(["vendor-relic"]);

function normalizeSlug(value: unknown): string {
  return normalizeWfmSlug(typeof value === "string" ? value : null) ?? "";
}

function normalizeName(value: unknown): string {
  return typeof value === "string" ? normalizeForSearch(value) : "";
}

function isVeiledRivenSlug(slug: unknown): boolean {
  const normalized = normalizeSlug(slug);
  return /(^|_)riven_mod_veiled$/.test(normalized);
}

function isVeiledRivenName(name: unknown): boolean {
  const normalized = normalizeName(name);
  return /riven mod\s*\(veiled\)$/.test(normalized);
}

export function isExcludedRankedMarketItem(name: unknown, slug: unknown): boolean {
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
 */
export function isWfmExcludedSlug(slug: unknown): boolean {
  if (typeof slug !== "string" || !slug) return false;
  return WFM_EXCLUDED_SLUGS.has(slug);
}

