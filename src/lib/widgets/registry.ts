import type { MessageKey } from "../i18n.js";
import type { SectionDescriptor, SectionSpan } from "../layout/types.js";
import type { ViewName } from "../../types/views.js";
import type { WidgetDescriptor } from "./types.js";

/** Layout section ids are `<view>.<name>`, so a widget maps onto `dashboard.<name>`. */
const SECTION_PREFIX = "dashboard.";
const WIDGET_PREFIX = "widget.";

// The layout grid expresses "how narrow may this get" as minSpan and cycles
// upward from there, so allowedSpans must stay a contiguous tail of this order
// for the two to agree. A registry test holds that rule.
const SPAN_ORDER: readonly SectionSpan[] = [1, 2, "full"];

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
    settings: { limit: "number" },
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
    id: "widget.recentRuns",
    labelKey: "arbi.title",
    defaultSpan: "full",
    // A run row carries date, node, duration, rotations and vitus; one column
    // clips it, so the narrow end of the cycle stops at two.
    allowedSpans: [2, "full"],
    settings: { limit: "number" },
    canPopout: true,
  },
];

/** Tab each widget's "open" link goes to. Kept beside the registry rather than on
    the descriptor so the widget contract stays free of routing. */
export const WIDGET_HOME_VIEWS: Readonly<Record<string, ViewName>> = {
  "widget.cycles": "world",
  "widget.fissures": "world",
  "widget.foundryReady": "foundry",
  "widget.marketAlerts": "market",
  "widget.goals": "mastery",
  "widget.baro": "world",
  "widget.inventoryValue": "inventory",
  "widget.tradeSummary": "analytics",
  "widget.recentRuns": "arbi",
};

/** Setting names are shared across widgets, so their label, default and bounds
    live once here instead of once per descriptor. */
export const WIDGET_SETTING_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  limit: "dashboard.rowLimit",
  allTradables: "inventory.value.allTradables",
};

export const WIDGET_SETTING_DEFAULTS: Readonly<Record<string, boolean | number | string>> = {
  limit: 5,
  allTradables: false,
};

/** Inclusive bounds for numeric settings; a stored value outside them is clamped. */
export const WIDGET_SETTING_RANGES: Readonly<Record<string, { min: number; max: number }>> = {
  limit: { min: 1, max: 20 },
};

export function widgetById(id: string): WidgetDescriptor | null {
  return DASHBOARD_WIDGETS.find((widget) => widget.id === id) ?? null;
}

export function sectionIdFor(widgetId: string): string {
  return `${SECTION_PREFIX}${widgetId.slice(WIDGET_PREFIX.length)}`;
}

/** The dashboard's widgets as layout sections, so reorder, hide, span, undo and
    presets come from the layout store instead of a second engine. */
export function dashboardSectionDescriptors(): SectionDescriptor[] {
  return DASHBOARD_WIDGETS.map((widget) => ({
    id: sectionIdFor(widget.id),
    view: "dashboard" as const,
    labelKey: widget.labelKey,
    defaultSpan: widget.defaultSpan,
    minSpan: widget.allowedSpans[0] ?? 1,
    canCollapse: true,
    ...(widget.canPopout === true ? { canPopout: true } : {}),
  }));
}
