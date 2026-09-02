/** Capitalises each word of a lowercased base, hyphenated parts included, for the
 *  lowercase keys and upper-case game strings the world data mixes. */
export function titleCase(value: string): string {
  return value.toLowerCase().replace(/(^|[\s-])\S/g, (c) => c.toUpperCase());
}

export function normalizeForSearch(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeForSlug(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/['\u2019\u2018]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || null;
}

export function normalizeForOcr(value: unknown): string {
  return String(value || "")
    .toUpperCase()
    .replace(/[1|!]/g, "I")
    .replace(/0/g, "O")
    .replace(/5/g, "S")
    .replace(/[^A-Z]/g, "")
    .trim();
}

// Most warframe.market slugs are [a-z0-9_], but the catalog also ships hyphens,
// parentheses, curly apostrophes and accented letters. Allowlist what it holds
// so path separators stay out, and anchor both ends on an alphanumeric so bare
// punctuation still falls through to name folding.
const WFM_SLUG_RE = /^[\p{Ll}\p{N}](?:[\p{Ll}\p{M}\p{N}_()'’-]{0,118}[\p{Ll}\p{N})])?$/u;

export function isWfmSlug(value: unknown): boolean {
  return typeof value === "string" && WFM_SLUG_RE.test(value);
}

/** Keeps a slug warframe.market already minted; null for anything else. */
export function sanitizeWfmSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase();
  return WFM_SLUG_RE.test(slug) ? slug : null;
}
