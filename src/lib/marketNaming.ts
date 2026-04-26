export function normalizeMarketName(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeLooseMarketName(value: string): string {
  return normalizeMarketName(value).replace(/[^a-z0-9]+/g, "");
}

export function toMarketSlug(name: string): string {
  return normalizeMarketName(name)
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
