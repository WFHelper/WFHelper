// DE's dict values carry leading category markers in angle brackets
// (`<ARCHWING> Amesha`, `<CREDITS>`, `<ENDO>`, `<ENERGY>`, `<RAID>`, `<UGC>`, ...).
// None of them belong in a rendered name, so strip any single leading `<...>`.
const LEADING_BRACKET_TOKEN = /^<[^>]{1,24}>\s*/;

export function sanitizeDisplayName(name: string | null | undefined): string {
  return String(name || "")
    .replace(LEADING_BRACKET_TOKEN, "")
    .trim();
}

/**
 * Derive a human-readable fallback name from a `/Lotus/...`-style uniqueName:
 * take the last path segment and space out camelCase boundaries.
 *
 * `/Lotus/Language/...` keys are localization keys that always end in `Name`
 * (e.g. `ArchonCrystalGreenName`, `ArchonCrystalAmarMythicName`); when the dict
 * can't resolve them we still land here, so drop that trailing `Name` artifact
 * rather than surface "Archon Crystal Green Name".
 */
export function fallbackNameFromUniqueName(uniqueName: string | null | undefined): string {
  if (!uniqueName) return "Unknown";
  const raw = String(uniqueName);
  const segments = raw.split("/");
  let last = segments[segments.length - 1] || "Unknown";
  if (/\/Lotus\/Language\//i.test(raw)) {
    last = last.replace(/Name$/, "");
  }
  const name = last
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return sanitizeDisplayName(name);
}
