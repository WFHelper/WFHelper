import { describe, expect, it } from "vitest";

import {
  DASHBOARD_WIDGETS,
  WIDGET_HOME_VIEWS,
  WIDGET_SETTING_DEFAULTS,
  WIDGET_SETTING_LABEL_KEYS,
  WIDGET_SETTING_RANGES,
  dashboardSectionDescriptors,
  sectionIdFor,
  widgetById,
} from "../../../../src/lib/widgets/registry.js";

// Vitest has no Svelte plugin, so a component cannot be imported here; that every
// widget actually mounts is asserted against the running app in e2e/dashboard.spec.ts.
// widget.foundryReady -> FoundryReadyWidget.svelte
function componentNameFor(widgetId: string): string {
  const name = widgetId.slice("widget.".length);
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}Widget`;
}

describe("dashboard widget registry", () => {
  it("registers every widget under the widget.<name> id shape", () => {
    for (const widget of DASHBOARD_WIDGETS) {
      expect(widget.id.startsWith("widget.")).toBe(true);
      expect(widget.id.length).toBeGreaterThan("widget.".length);
    }
    const ids = DASHBOARD_WIDGETS.map((widget) => widget.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names a component for every widget under the shared convention", () => {
    const names = DASHBOARD_WIDGETS.map((widget) => componentNameFor(widget.id));
    for (const name of names) expect(name).toMatch(/^[A-Z][A-Za-z]+Widget$/);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every widget a label key and a home view", () => {
    for (const widget of DASHBOARD_WIDGETS) {
      expect(widget.labelKey, `${widget.id} has no label key`).toBeTruthy();
      expect(WIDGET_HOME_VIEWS[widget.id], `${widget.id} has no home view`).toBeTruthy();
    }
  });

  it("includes the default span in allowedSpans", () => {
    for (const widget of DASHBOARD_WIDGETS) {
      expect(widget.allowedSpans, `${widget.id} cannot use its default span`).toContain(
        widget.defaultSpan,
      );
      expect(widget.allowedSpans.length).toBeGreaterThan(0);
    }
  });

  it("keeps allowedSpans a tail of the grid's span order, which minSpan encodes", () => {
    // The layout section only carries minSpan and cycles upward from it, so any
    // other shape would let the span button land on a span the widget rejects.
    const order = [1, 2, "full"];
    for (const widget of DASHBOARD_WIDGETS) {
      const start = order.indexOf(widget.allowedSpans[0] as number | string);
      expect(start, `${widget.id} starts on an unknown span`).toBeGreaterThanOrEqual(0);
      expect([...widget.allowedSpans]).toEqual(order.slice(start));
    }
  });

  it("declares a label, a default and a range for every setting it uses", () => {
    for (const widget of DASHBOARD_WIDGETS) {
      for (const [name, kind] of Object.entries(widget.settings ?? {})) {
        expect(WIDGET_SETTING_LABEL_KEYS[name], `${name} has no label`).toBeTruthy();
        expect(WIDGET_SETTING_DEFAULTS[name], `${name} has no default`).toBeDefined();
        expect(typeof WIDGET_SETTING_DEFAULTS[name]).toBe(kind);
        if (kind === "number") expect(WIDGET_SETTING_RANGES[name]).toBeDefined();
      }
    }
  });

  it("maps widget ids onto dashboard section ids", () => {
    for (const widget of DASHBOARD_WIDGETS) {
      const sectionId = sectionIdFor(widget.id);
      expect(sectionId).toBe(`dashboard.${widget.id.slice("widget.".length)}`);
      expect(widgetById(widget.id)?.id).toBe(widget.id);
    }
    expect(widgetById("widget.workshop2")).toBeNull();
  });

  it("derives layout sections that carry minSpan and the popout flag", () => {
    const sections = dashboardSectionDescriptors();
    expect(sections).toHaveLength(DASHBOARD_WIDGETS.length);
    for (const [index, section] of sections.entries()) {
      const widget = DASHBOARD_WIDGETS[index];
      expect(section.view).toBe("dashboard");
      expect(section.id).toBe(sectionIdFor(widget.id));
      expect(section.labelKey).toBe(widget.labelKey);
      expect(section.defaultSpan).toBe(widget.defaultSpan);
      expect(section.minSpan).toBe(widget.allowedSpans[0]);
      expect(section.canPopout ?? false).toBe(widget.canPopout ?? false);
    }
  });

  it("offers a popout for the widgets that are useful in their own window", () => {
    const popoutIds = DASHBOARD_WIDGETS.filter((widget) => widget.canPopout === true).map(
      (widget) => widget.id,
    );
    expect(popoutIds).toEqual([
      "widget.cycles",
      "widget.fissures",
      "widget.marketAlerts",
      "widget.baro",
      "widget.recentRuns",
    ]);
  });
});
