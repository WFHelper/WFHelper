import { normalizeWfmSlugKey } from "./wfm";
import { normalizeForSearch } from "./textNormalize";
import { isRankedGroup } from "./numeric";

const BLOOD_FOR_SLUGS = new Set(["blood_for_ammo", "blood_for_energy", "blood_for_life"]);

// Skip inventory slugs that have no WFM listing and would repeatedly return 404.
const WFM_EXCLUDED_SLUGS = new Set(["vendor_relic"]);

function isKnownUnlistedSlugPattern(slug: string): boolean {
  // Captura scenes exist in inventory/world reward data but are not listed on WFM.
  return slug.endsWith("_scene");
}

function normalizeName(value: unknown): string {
  return typeof value === "string" ? normalizeForSearch(value) : "";
}

function isVeiledRivenSlug(slug: unknown): boolean {
  const normalized = normalizeWfmSlugKey(slug);
  return /(^|_)riven_mod_veiled$/.test(normalized);
}

function isVeiledRivenName(name: unknown): boolean {
  const normalized = normalizeName(name);
  return /riven mod\s*\(veiled\)$/.test(normalized);
}

export function isExcludedRankedMarketItem(name: unknown, slug: unknown): boolean {
  const normalizedSlug = normalizeWfmSlugKey(slug);
  if (BLOOD_FOR_SLUGS.has(normalizedSlug)) return true;
  if (isVeiledRivenSlug(normalizedSlug)) return true;

  const normalizedItemName = normalizeName(name);
  if (normalizedItemName === "blood for ammo") return true;
  if (normalizedItemName === "blood for energy") return true;
  if (normalizedItemName === "blood for life") return true;
  if (isVeiledRivenName(normalizedItemName)) return true;

  return false;
}

export function isRankedMarketItem(
  group: string | null | undefined,
  name: unknown,
  slug: unknown,
): boolean {
  return isRankedGroup(group) && !isExcludedRankedMarketItem(name, slug);
}

/** Whether a slug is known to have no Warframe Market listing. */
export function isWfmExcludedSlug(slug: unknown): boolean {
  const normalizedSlug = normalizeWfmSlugKey(slug);
  if (!normalizedSlug) return false;
  return WFM_EXCLUDED_SLUGS.has(normalizedSlug) || isKnownUnlistedSlugPattern(normalizedSlug);
}
