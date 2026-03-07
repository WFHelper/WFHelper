import type { RelicQuality } from "../../types/relics.js";

export const RELIC_ICON_PATHS: Record<string, string> = {
  lith: "world-icons/relic-lith.png",
  meso: "world-icons/relic-meso.png",
  neo: "world-icons/relic-neo.png",
  axi: "world-icons/relic-axi.png",
  requiem: "world-icons/relic-requiem.png",
  omnia: "world-icons/relic-requiem.png",
  default: "world-icons/relic-lith.png",
};

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
