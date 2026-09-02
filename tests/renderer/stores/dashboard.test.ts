import { get } from "svelte/store";
import { describe, expect, it } from "vitest";

import { DASHBOARD_WIDGETS } from "../../../src/lib/widgets/registry.js";
import { DASHBOARD_STORAGE_KEY } from "../../../src/lib/widgets/types.js";
import {
  dashboardLayout,
  normalizeDashboardLayout,
  setWidgetSetting,
  settingBoolean,
  settingNumber,
  widgetSettings,
} from "../../../src/stores/dashboard.js";

const FISSURES = "widget.fissures";
const VALUE = "widget.inventoryValue";

function idsOf(layout: { widgets: { id: string }[] }): string[] {
  return layout.widgets.map((widget) => widget.id);
}

describe("dashboard storage key", () => {
  it("is the versioned key the contract names", () => {
    expect(DASHBOARD_STORAGE_KEY).toBe("wf_dashboard_v1");
  });
});

describe("normalizeDashboardLayout", () => {
  it("returns every registered widget at its defaults for junk input", () => {
    for (const raw of [null, undefined, 7, "{}", [], { version: 2, widgets: [] }]) {
      const layout = normalizeDashboardLayout(raw);
      expect(layout.version).toBe(1);
      expect(idsOf(layout)).toEqual(DASHBOARD_WIDGETS.map((widget) => widget.id));
    }
  });

  it("drops a widget id this build does not know", () => {
    const layout = normalizeDashboardLayout({
      version: 1,
      widgets: [
        { id: "widget.workshop2", span: 1, hidden: false, settings: { limit: 3 } },
        { id: FISSURES, span: 1, hidden: false, settings: { limit: 3 } },
      ],
    });
    expect(idsOf(layout)).not.toContain("widget.workshop2");
    expect(settingNumber(widgetSettings(layout, FISSURES), "limit", 0)).toBe(3);
  });

  it("keeps a widget the stored file never held, at its registry defaults", () => {
    const layout = normalizeDashboardLayout({
      version: 1,
      widgets: [{ id: FISSURES, span: 1, hidden: true, settings: { limit: 9 } }],
    });
    expect(idsOf(layout)).toEqual(DASHBOARD_WIDGETS.map((widget) => widget.id));
    expect(settingNumber(widgetSettings(layout, VALUE), "limit", -1)).toBe(-1);
    expect(settingBoolean(widgetSettings(layout, VALUE), "allTradables", true)).toBe(false);
  });

  it("ignores a repeated widget entry", () => {
    const layout = normalizeDashboardLayout({
      version: 1,
      widgets: [
        { id: FISSURES, span: 1, hidden: false, settings: { limit: 4 } },
        { id: FISSURES, span: 1, hidden: false, settings: { limit: 8 } },
      ],
    });
    expect(idsOf(layout).filter((id) => id === FISSURES)).toHaveLength(1);
    expect(settingNumber(widgetSettings(layout, FISSURES), "limit", 0)).toBe(4);
  });

  it("drops a setting whose stored type is wrong instead of coercing it", () => {
    const layout = normalizeDashboardLayout({
      version: 1,
      widgets: [
        { id: FISSURES, span: 1, hidden: false, settings: { limit: "8" } },
        { id: VALUE, span: 1, hidden: false, settings: { allTradables: 1 } },
      ],
    });
    expect(settingNumber(widgetSettings(layout, FISSURES), "limit", -1)).toBe(5);
    expect(settingBoolean(widgetSettings(layout, VALUE), "allTradables", true)).toBe(false);
  });

  it("drops a setting the widget does not declare", () => {
    const layout = normalizeDashboardLayout({
      version: 1,
      widgets: [{ id: VALUE, span: 1, hidden: false, settings: { limit: 3, nonsense: true } }],
    });
    const settings = widgetSettings(layout, VALUE);
    expect(settings).not.toHaveProperty("limit");
    expect(settings).not.toHaveProperty("nonsense");
  });

  it("clamps a numeric setting to its declared range", () => {
    const low = normalizeDashboardLayout({
      version: 1,
      widgets: [{ id: FISSURES, span: 1, hidden: false, settings: { limit: 0 } }],
    });
    const high = normalizeDashboardLayout({
      version: 1,
      widgets: [{ id: FISSURES, span: 1, hidden: false, settings: { limit: 999 } }],
    });
    const fractional = normalizeDashboardLayout({
      version: 1,
      widgets: [{ id: FISSURES, span: 1, hidden: false, settings: { limit: 4.6 } }],
    });
    expect(settingNumber(widgetSettings(low, FISSURES), "limit", 0)).toBe(1);
    expect(settingNumber(widgetSettings(high, FISSURES), "limit", 0)).toBe(20);
    expect(settingNumber(widgetSettings(fractional, FISSURES), "limit", 0)).toBe(5);
  });

  it("rejects a non-finite number and a malformed widget entry", () => {
    const layout = normalizeDashboardLayout({
      version: 1,
      widgets: [
        null,
        "widget.fissures",
        { span: 1 },
        { id: 4 },
        { id: FISSURES, settings: { limit: Number.NaN } },
      ],
    });
    expect(idsOf(layout)).toEqual(DASHBOARD_WIDGETS.map((widget) => widget.id));
    expect(settingNumber(widgetSettings(layout, FISSURES), "limit", 0)).toBe(5);
  });

  it("falls back to the default span when the stored one is not allowed", () => {
    const layout = normalizeDashboardLayout({
      version: 1,
      widgets: [
        { id: "widget.recentRuns", span: 1, hidden: false },
        { id: FISSURES, span: "wide", hidden: false },
      ],
    });
    const runs = layout.widgets.find((widget) => widget.id === "widget.recentRuns");
    const fissures = layout.widgets.find((widget) => widget.id === FISSURES);
    // recentRuns starts at span 2, so a stored 1 is not one of its allowed spans.
    expect(runs?.span).toBe("full");
    expect(fissures?.span).toBe(1);
  });
});

describe("setWidgetSetting", () => {
  it("writes a value the widget declares and leaves the others alone", () => {
    setWidgetSetting(FISSURES, "limit", 7);
    expect(settingNumber(widgetSettings(get(dashboardLayout), FISSURES), "limit", 0)).toBe(7);
    expect(settingNumber(widgetSettings(get(dashboardLayout), "widget.goals"), "limit", 0)).toBe(5);
  });

  it("clamps on the way in", () => {
    setWidgetSetting(FISSURES, "limit", 500);
    expect(settingNumber(widgetSettings(get(dashboardLayout), FISSURES), "limit", 0)).toBe(20);
  });

  it("ignores an unknown widget, an unknown setting and a wrong type", () => {
    setWidgetSetting(FISSURES, "limit", 6);
    setWidgetSetting("widget.workshop2", "limit", 2);
    setWidgetSetting(FISSURES, "nonsense", 2);
    setWidgetSetting(FISSURES, "limit", true);
    expect(settingNumber(widgetSettings(get(dashboardLayout), FISSURES), "limit", 0)).toBe(6);
    expect(widgetSettings(get(dashboardLayout), FISSURES)).not.toHaveProperty("nonsense");
  });
});
