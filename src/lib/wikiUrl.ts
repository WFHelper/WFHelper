/**
 * Convert a Fandom wiki URL to the official wiki.warframe.com URL.
 * Returns the input unchanged if it's already an official URL or unparseable.
 */
export function toOfficialWikiUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === "warframe.fandom.com" ||
      parsed.hostname === "www.warframe.fandom.com"
    ) {
      const page = parsed.pathname.replace(/^\/wiki\//, "");
      return `https://wiki.warframe.com/w/${page}${parsed.search}${parsed.hash}`;
    }
  } catch {
    /* invalid URL, return as-is */
  }
  return url;
}

/**
 * Build a direct wiki URL from an item/component name.
 * Falls back to search if the name might not match a page title exactly.
 */
export function buildWikiUrl(name: string): string {
  return `https://wiki.warframe.com/w/${encodeURIComponent(name.replace(/ /g, "_"))}`;
}
