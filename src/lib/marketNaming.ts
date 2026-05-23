import { normalizeForSearch, normalizeForSlug } from "../../config/shared/textNormalize.js";

export { normalizeForSearch as normalizeMarketName } from "../../config/shared/textNormalize.js";

export function normalizeLooseMarketName(value: string): string {
  return normalizeForSearch(value).replace(/[^a-z0-9]+/g, "");
}

export function toMarketSlug(name: string): string {
  return normalizeForSlug(name) ?? "";
}
