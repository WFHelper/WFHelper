import type { MessageKey } from "../i18n.js";
import type { RelicQuality } from "../../types/relics.js";
import { RELIC_ICON_URLS } from "../assetUrls.js";

export {
  RELIC_QUALITY_MODES as QUALITY_MODES,
  highestOwnedQuality,
} from "../../../config/shared/relicPlannerView.js";

export const RELIC_ICON_PATHS: Record<string, string> = RELIC_ICON_URLS;

/** Int / Ex / Fl / Rad. */
export const RELIC_QUALITY_SHORT_KEY: Record<RelicQuality, MessageKey> = {
  intact: "relics.qualityShort.intact",
  exceptional: "relics.qualityShort.exceptional",
  flawless: "relics.qualityShort.flawless",
  radiant: "relics.qualityShort.radiant",
};

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
