import type { MessageKey } from "../i18n.js";
import { SPAN_ORDER } from "../layout/plan.js";
import type { SectionDescriptor } from "../layout/types.js";
import type { SidebarViewName } from "../viewRegistry.js";
import type { WidgetDescriptor } from "./types.js";

const SECTION_PREFIX = "dashboard.";
const WIDGET_PREFIX = "widget.";

// The layout grid expresses "how narrow may this get" as minSpan and cycles
// upward from SPAN_ORDER, so allowedSpans must stay a contiguous tail of that
// order for the two to agree. A registry test holds that rule.

export const DASHBOARD_WIDGETS: readonly WidgetDescriptor[] = [
  {
    id: "widget.cycles",
    labelKey: "world.planetCycles",
    defaultSpan: 1,
    allowedSpans: SPAN_ORDER,
    canPopout: true,
  },
  {
    id: "widget.fissures",
    labelKey: "world.voidFissures",
    defaultSpan: 1,
    allowedSpans: SPAN_ORDER,
    settings: {
      limit: "number",
      lith: "boolean",
      meso: "boolean",
      neo: "boolean",
      axi: "boolean",
      requiem: "boolean",
      omnia: "boolean",
    },
    canPopout: true,
  },
  {
    id: "widget.foundryReady",
    labelKey: "dashboard.foundryReady",
    defaultSpan: 1,
    allowedSpans: SPAN_ORDER,
    settings: { limit: "number" },
  },
  {
    id: "widget.marketAlerts",
    labelKey: "marketAlerts.title",
    defaultSpan: 1,
    allowedSpans: SPAN_ORDER,
    settings: { limit: "number" },
    canPopout: true,
  },
  {
    id: "widget.goals",
    labelKey: "mastery.planner.pinnedTitle",
    defaultSpan: 1,
    allowedSpans: SPAN_ORDER,
    settings: { limit: "number" },
  },
  {
    id: "widget.baro",
    labelKey: "world.baroKiteer",
    defaultSpan: 1,
    allowedSpans: SPAN_ORDER,
    canPopout: true,
  },
  {
    id: "widget.inventoryValue",
    labelKey: "inventory.value.title",
    defaultSpan: 1,
    allowedSpans: SPAN_ORDER,
    settings: { allTradables: "boolean" },
  },
  {
    id: "widget.tradeSummary",
    // Reuses the Analytics section label; en.json rejects a second key with the
    // same English value, so "Trade summary" only exists once.
    labelKey: "layout.section.analyticsSummary",
    defaultSpan: 1,
    allowedSpans: SPAN_ORDER,
  },
  {
    id: "widget.lastMission",
    labelKey: "dashboard.lastMission",
    defaultSpan: 1,
    allowedSpans: SPAN_ORDER,
  },
  {
    id: "widget.recentRuns",
    labelKey: "arbi.title",
    defaultSpan: "full",
    allowedSpans: [2, "full"],
    settings: { limit: "number" },
    canPopout: true,
  },
];

export const WIDGET_HOME_VIEWS: Readonly<Record<string, SidebarViewName>> = {
  "widget.cycles": "world",
  "widget.fissures": "world",
  "widget.foundryReady": "foundry",
  "widget.marketAlerts": "market",
  "widget.goals": "mastery",
  "widget.baro": "world",
  "widget.inventoryValue": "inventory",
  "widget.tradeSummary": "analytics",
  "widget.lastMission": "missions",
  "widget.recentRuns": "arbi",
};

// Joins a dashboard layout saved before it existed as hidden, so that layout
// stays as the user left it; a dashboard without a saved layout shows it.
const HIDDEN_IN_SAVED_LAYOUTS: ReadonlySet<string> = new Set(["widget.lastMission"]);

export const WIDGET_SETTING_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  limit: "dashboard.rowLimit",
  allTradables: "inventory.value.allTradables",
  lith: "relics.tier.lith",
  meso: "relics.tier.meso",
  neo: "relics.tier.neo",
  axi: "relics.tier.axi",
  requiem: "relics.tier.requiem",
  omnia: "relics.tier.omnia",
};

export const WIDGET_SETTING_DEFAULTS: Readonly<Record<string, boolean | number | string>> = {
  limit: 5,
  allTradables: false,
  lith: true,
  meso: true,
  neo: true,
  axi: true,
  requiem: true,
  omnia: true,
};

export const WIDGET_SETTING_RANGES: Readonly<Record<string, { min: number; max: number }>> = {
  limit: { min: 1, max: 20 },
};

export function widgetById(id: string): WidgetDescriptor | null {
  return DASHBOARD_WIDGETS.find((widget) => widget.id === id) ?? null;
}

export function sectionIdFor(widgetId: string): string {
  return `${SECTION_PREFIX}${widgetId.slice(WIDGET_PREFIX.length)}`;
}

export function dashboardSectionDescriptors(): SectionDescriptor[] {
  return DASHBOARD_WIDGETS.map((widget) => ({
    id: sectionIdFor(widget.id),
    view: "dashboard" as const,
    labelKey: widget.labelKey,
    defaultSpan: widget.defaultSpan,
    minSpan: widget.allowedSpans[0] ?? 1,
    canCollapse: true,
    ...(widget.canPopout === true ? { canPopout: true } : {}),
    ...(HIDDEN_IN_SAVED_LAYOUTS.has(widget.id) ? { hiddenInSavedLayouts: true } : {}),
  }));
}
