export function sanitizeDisplayName(name: string | null | undefined): string {
  return String(name || "")
    .replace(/^<ARCHWING>\s*/i, "")
    .trim();
}
