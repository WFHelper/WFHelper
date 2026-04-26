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
