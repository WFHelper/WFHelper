import type { MessageKey } from "../lib/i18n.js";
import type { LayoutView, SectionSpan } from "../lib/layout/types.js";

/** Span is always explicit: a preset can be applied to a view whose module has
    not loaded yet, so there is no descriptor to take a default from. */
interface PresetSection {
  id: string;
  span: SectionSpan;
  hidden?: boolean;
  collapsed?: boolean;
}

interface LayoutPreset {
  id: string;
  labelKey: MessageKey;
  views: Partial<Record<LayoutView, readonly PresetSection[]>>;
}

const show = (id: string, span: SectionSpan = 1): PresetSection => ({ id, span });
const hide = (id: string, span: SectionSpan = 1): PresetSection => ({ id, span, hidden: true });
const fold = (id: string, span: SectionSpan = "full"): PresetSection => ({
  id,
  span,
  collapsed: true,
});

export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
  {
    id: "compactTrader",
    labelKey: "layout.preset.compactTrader",
    views: {
      inventory: [
        show("inventory.valueStrip", "full"),
        show("inventory.filters", "full"),
        show("inventory.selectionBar", "full"),
        show("inventory.grid", "full"),
      ],
      stats: [show("stats.trades", "full"), show("stats.summary", "full"), fold("stats.charts")],
      world: [
        show("world.fissures"),
        show("world.cycles"),
        hide("world.timers"),
        hide("world.resurgence"),
        hide("world.circuit"),
        hide("world.steelPath"),
        show("world.darvo"),
        show("world.invasions"),
        show("world.fissureAlerts"),
        show("world.baro", "full"),
        hide("world.bounties", "full"),
      ],
      mastery: [hide("mastery.summary", "full"), show("mastery.content", "full")],
      market: [
        show("market.reviewBanner", "full"),
        show("market.orders", "full"),
        show("market.alerts", "full"),
        show("market.rivens", "full"),
        show("market.browse", "full"),
      ],
      analytics: [
        show("analytics.summary", "full"),
        show("analytics.topTraded", "full"),
        show("analytics.topItems", "full"),
        show("analytics.byType"),
        show("analytics.worthToday"),
        hide("analytics.partners"),
        hide("analytics.yearCompare"),
        hide("analytics.timeCharts", "full"),
        show("analytics.ledger", "full"),
      ],
    },
  },
  {
    id: "dailyChecklist",
    labelKey: "layout.preset.dailyChecklist",
    views: {
      world: [
        show("world.timers"),
        show("world.cycles"),
        show("world.fissures"),
        show("world.fissureAlerts"),
        show("world.invasions"),
        show("world.darvo"),
        hide("world.resurgence"),
        hide("world.circuit"),
        show("world.steelPath"),
        show("world.bounties", "full"),
        show("world.baro", "full"),
        show("world.dailies", "full"),
        show("world.arbiSchedule", "full"),
      ],
      stats: [show("stats.summary", "full"), fold("stats.charts"), show("stats.trades", "full")],
      market: [
        show("market.reviewBanner", "full"),
        show("market.orders", "full"),
        show("market.alerts", "full"),
        show("market.rivens", "full"),
        show("market.browse", "full"),
      ],
      analytics: [
        show("analytics.summary", "full"),
        show("analytics.timeCharts", "full"),
        show("analytics.byType"),
        show("analytics.worthToday"),
        hide("analytics.partners"),
        hide("analytics.yearCompare"),
        hide("analytics.topTraded", "full"),
        hide("analytics.topItems", "full"),
        show("analytics.ledger", "full"),
      ],
    },
  },
  {
    id: "relicFarmer",
    labelKey: "layout.preset.relicFarmer",
    views: {
      world: [
        show("world.fissures"),
        show("world.fissureAlerts"),
        show("world.cycles"),
        show("world.resurgence"),
        show("world.circuit"),
        hide("world.timers"),
        hide("world.steelPath"),
        hide("world.darvo"),
        hide("world.invasions"),
        show("world.bounties", "full"),
        show("world.baro", "full"),
      ],
      inventory: [
        show("inventory.filters", "full"),
        show("inventory.valueStrip", "full"),
        show("inventory.selectionBar", "full"),
        show("inventory.grid", "full"),
      ],
      market: [
        show("market.reviewBanner", "full"),
        show("market.orders", "full"),
        show("market.rivens", "full"),
        show("market.browse", "full"),
        show("market.alerts", "full"),
      ],
      analytics: [
        show("analytics.summary", "full"),
        show("analytics.topTraded", "full"),
        show("analytics.topItems", "full"),
        show("analytics.worthToday"),
        hide("analytics.byType"),
        hide("analytics.partners"),
        hide("analytics.yearCompare"),
        hide("analytics.timeCharts", "full"),
        show("analytics.ledger", "full"),
      ],
    },
  },
  {
    id: "masteryFocus",
    labelKey: "layout.preset.masteryFocus",
    views: {
      mastery: [show("mastery.summary", "full"), show("mastery.content", "full")],
      inventory: [
        show("inventory.filters", "full"),
        hide("inventory.valueStrip", "full"),
        show("inventory.selectionBar", "full"),
        show("inventory.grid", "full"),
      ],
      world: [
        show("world.circuit"),
        show("world.resurgence"),
        show("world.cycles"),
        show("world.fissures"),
        hide("world.timers"),
        hide("world.darvo"),
        hide("world.invasions"),
        hide("world.fissureAlerts"),
        show("world.steelPath"),
        show("world.baro", "full"),
        hide("world.bounties", "full"),
      ],
      market: [
        show("market.reviewBanner", "full"),
        show("market.orders", "full"),
        show("market.browse", "full"),
        show("market.rivens", "full"),
        show("market.alerts", "full"),
      ],
      analytics: [
        show("analytics.summary", "full"),
        hide("analytics.topTraded", "full"),
        hide("analytics.timeCharts", "full"),
        hide("analytics.topItems", "full"),
        hide("analytics.byType"),
        hide("analytics.partners"),
        hide("analytics.worthToday"),
        hide("analytics.yearCompare"),
        show("analytics.ledger", "full"),
      ],
    },
  },
  {
    id: "runAnalyst",
    labelKey: "layout.preset.runAnalyst",
    views: {
      arbi: [fold("arbi.filters"), show("arbi.runs", "full")],
      stats: [
        show("stats.charts", "full"),
        show("stats.summary", "full"),
        show("stats.trades", "full"),
      ],
      world: [
        show("world.arbiSchedule", "full"),
        show("world.cycles"),
        show("world.timers"),
        show("world.fissures"),
        show("world.invasions"),
        hide("world.resurgence"),
        hide("world.circuit"),
        hide("world.darvo"),
        hide("world.fissureAlerts"),
        show("world.steelPath"),
        hide("world.baro", "full"),
        hide("world.bounties", "full"),
      ],
      market: [
        show("market.reviewBanner", "full"),
        show("market.orders", "full"),
        show("market.rivens", "full"),
        show("market.alerts", "full"),
        show("market.browse", "full"),
      ],
      analytics: [
        show("analytics.summary", "full"),
        show("analytics.timeCharts", "full"),
        show("analytics.yearCompare"),
        show("analytics.byType"),
        show("analytics.partners"),
        show("analytics.worthToday"),
        show("analytics.topItems", "full"),
        show("analytics.topTraded", "full"),
        show("analytics.ledger", "full"),
      ],
    },
  },
];

export function presetById(id: string): LayoutPreset | null {
  return LAYOUT_PRESETS.find((preset) => preset.id === id) ?? null;
}
