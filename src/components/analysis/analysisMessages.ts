import type { MessageKey } from "../../lib/i18n.js";
import type { TradeItemKind } from "../../lib/stats/tradeAnalytics.js";

/** Kind ids are internal, so the panels always render these labels instead. */
export const KIND_KEYS: Record<TradeItemKind, MessageKey> = {
  riven: "common.rivens",
  set: "analysis.kind.set",
  prime: "analysis.kind.prime",
  mod: "inventory.tab.mods",
  arcane: "inventory.tab.arcanes",
  relic: "common.relics",
  resource: "nav.resources",
  other: "arbi.type.other",
};
