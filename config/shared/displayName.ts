export function sanitizeDisplayName(name: string | null | undefined): string {
  return String(name || "")
    .replace(/^<ARCHWING>\s*/i, "")
    .trim();
}

/**
 * Derive a human-readable fallback name from a `/Lotus/...`-style uniqueName:
 * take the last path segment and space out camelCase boundaries.
 */
export function fallbackNameFromUniqueName(uniqueName: string | null | undefined): string {
  if (!uniqueName) return "Unknown";
  const segments = String(uniqueName).split("/");
  const name = (segments[segments.length - 1] || "Unknown")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return sanitizeDisplayName(name);
}
