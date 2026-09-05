/// <reference types="node" />

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Vitest has no Svelte plugin, so the components are read as source; that the
// footer renders is asserted against the running app in e2e/dashboard.spec.ts.
const WIDGETS_DIR = path.join(process.cwd(), "src", "components", "widgets");

function widgetSources(): Map<string, string> {
  return new Map(
    fs
      .readdirSync(WIDGETS_DIR)
      .filter((file) => file.endsWith(".svelte"))
      .map((file) => [file, fs.readFileSync(path.join(WIDGETS_DIR, file), "utf8")]),
  );
}

describe("widget frame overflow footer", () => {
  it("renders the +N more footer in the frame and nowhere else", () => {
    const owners = [...widgetSources()]
      .filter(([, source]) => source.includes("data-widget-more"))
      .map(([file]) => file);
    expect(owners).toEqual(["WidgetFrame.svelte"]);
  });

  it("keeps the footer on the shared count key", () => {
    const frame = widgetSources().get("WidgetFrame.svelte") ?? "";
    expect(frame).toContain('$tr("mastery.planner.moreMaterials", { count: String(overflow) })');
  });

  it("passes an overflow count from every widget that limits its rows", () => {
    const withOverflow = [...widgetSources()]
      .filter(([, source]) => source.includes("overflow={"))
      .map(([file]) => file)
      .sort();
    expect(withOverflow).toEqual([
      "BaroWidget.svelte",
      "FissuresWidget.svelte",
      "FoundryReadyWidget.svelte",
    ]);
  });
});
