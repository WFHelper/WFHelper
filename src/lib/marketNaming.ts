import { normalizeForSearch, normalizeForSlug } from "../../config/shared/textNormalize.js";

export function normalizeMarketName(value: string): string {
  return normalizeForSearch(value);
}

export function normalizeLooseMarketName(value: string): string {
  return normalizeMarketName(value).replace(/[^a-z0-9]+/g, "");
}

export function toMarketSlug(name: string): string {
  return normalizeForSlug(name) || "";
}
