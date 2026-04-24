import { WFM_ASSET_BASE } from "./wfm";

export function formatWfmAssetUrl(path: unknown): string | null {
  if (typeof path !== "string" || !path.trim()) return null;
  const trimmed = path.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `${WFM_ASSET_BASE}${trimmed}`;
}
