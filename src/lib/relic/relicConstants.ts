import type { RelicQuality } from "../../types/relics.js";
import { RELIC_ICON_URLS } from "../assetUrls.js";

export const RELIC_ICON_PATHS: Record<string, string> = RELIC_ICON_URLS;

export const RELIC_TIER_ORDER: Record<string, number> = {
  Lith: 0,
  Meso: 1,
  Neo: 2,
  Axi: 3,
  Requiem: 4,
};

export const QUALITY_MODES: RelicQuality[] = ["intact", "exceptional", "flawless", "radiant"];

export function fissureTierClass(tier: string = ""): string {
  const t = tier.toLowerCase();
  if (t.includes("lith")) return "lith";
  if (t.includes("meso")) return "meso";
  if (t.includes("neo")) return "neo";
  if (t.includes("axi")) return "axi";
  if (t.includes("requiem")) return "requiem";
  if (t.includes("omnia")) return "omnia";
  return "default";
}
