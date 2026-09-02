/// <reference types="node" />

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LAYOUT_PRESETS } from "../../../../src/config/layoutPresets.js";
import { dashboardSectionDescriptors } from "../../../../src/lib/widgets/registry.js";

/** Yields [view, argument source] for every registerSections call, matching
    brackets so a nested array cannot end the block early. */
function* registerSectionsCalls(source: string): Generator<[string, string]> {
  const call = /registerSections\(\s*"([a-z]+)"\s*,\s*\[/g;
  for (let match = call.exec(source); match; match = call.exec(source)) {
    const view = match[1];
    if (view === undefined) continue;
    const start = match.index + match[0].length;
    let depth = 1;
    let index = start;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === "[") depth += 1;
      else if (char === "]") depth -= 1;
      index += 1;
    }
    yield [view, source.slice(start, index - 1)];
  }
}

/** The views register their sections from `<script context="module">` blocks and
    vitest has no Svelte plugin, so the ids are read out of the view sources. The
    dashboard builds its sections from the widget registry, which imports cleanly. */
function registeredSections(): Map<string, Set<string>> {
  const byView = new Map<string, Set<string>>([
    ["dashboard", new Set(dashboardSectionDescriptors().map((section) => section.id))],
  ]);
  const viewsDir = path.join(process.cwd(), "src", "views");
  for (const file of fs.readdirSync(viewsDir)) {
    if (!file.endsWith(".svelte")) continue;
    const source = fs.readFileSync(path.join(viewsDir, file), "utf8");
    for (const [view, block] of registerSectionsCalls(source)) {
      const ids = byView.get(view) ?? new Set<string>();
      for (const match of block.matchAll(/\bid:\s*"([^"]+)"/g)) {
        if (match[1] !== undefined) ids.add(match[1]);
      }
      byView.set(view, ids);
    }
  }
  return byView;
}

const REGISTERED = registeredSections();

const presetViews = (): string[] => [
  ...new Set(LAYOUT_PRESETS.flatMap((preset) => Object.keys(preset.views))),
];

const sorted = (ids: Iterable<string>): string[] => [...ids].sort();

describe("layout presets", () => {
  it("reads a section list for every view a preset arranges", () => {
    // Guards the scan itself: an empty set would make the id check below pass
    // by looking at nothing.
    for (const view of presetViews()) {
      expect(REGISTERED.get(view)?.size ?? 0, `${view} registers no sections`).toBeGreaterThan(0);
    }
  });

  it("prefixes every entry with the view that owns it", () => {
    const wrong: string[] = [];
    for (const preset of LAYOUT_PRESETS) {
      for (const [view, entries] of Object.entries(preset.views)) {
        for (const entry of entries ?? []) {
          if (!entry.id.startsWith(`${view}.`)) wrong.push(`${preset.id}: ${entry.id}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("names only sections the view actually registers", () => {
    const unknown: string[] = [];
    for (const preset of LAYOUT_PRESETS) {
      for (const [view, entries] of Object.entries(preset.views)) {
        const ids = REGISTERED.get(view) ?? new Set<string>();
        for (const entry of entries ?? []) {
          if (!ids.has(entry.id)) unknown.push(`${preset.id}/${view}: ${entry.id}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("never lists the same section twice in one view", () => {
    for (const preset of LAYOUT_PRESETS) {
      for (const [view, entries] of Object.entries(preset.views)) {
        const ids = (entries ?? []).map((entry) => entry.id);
        expect(new Set(ids).size, `${preset.id}/${view} repeats an id`).toBe(ids.length);
      }
    }
  });

  it("gives every preset the full market and analytics section list", () => {
    for (const preset of LAYOUT_PRESETS) {
      const market = (preset.views.market ?? []).map((entry) => entry.id);
      const analytics = (preset.views.analytics ?? []).map((entry) => entry.id);
      expect(sorted(market), `${preset.id}/market`).toEqual(sorted(REGISTERED.get("market") ?? []));
      expect(sorted(analytics), `${preset.id}/analytics`).toEqual(
        sorted(REGISTERED.get("analytics") ?? []),
      );
    }
  });

  it("leaves the protected market and analytics sections visible", () => {
    for (const preset of LAYOUT_PRESETS) {
      const market = preset.views.market ?? [];
      const analytics = preset.views.analytics ?? [];
      expect(
        market.filter((entry) => entry.hidden === true),
        preset.id,
      ).toEqual([]);
      expect(analytics.find((entry) => entry.id === "analytics.ledger")?.hidden).not.toBe(true);
      expect(analytics.find((entry) => entry.id === "analytics.summary")?.hidden).not.toBe(true);
    }
  });

  it("keeps Compact Trader focused on orders, alerts and the top sellers", () => {
    const preset = LAYOUT_PRESETS.find((entry) => entry.id === "compactTrader");
    const market = (preset?.views.market ?? []).map((entry) => entry.id);
    expect(market.slice(0, 3)).toEqual(["market.reviewBanner", "market.orders", "market.alerts"]);
    const analytics = preset?.views.analytics ?? [];
    expect(analytics[1]?.id).toBe("analytics.topTraded");
    expect(analytics.find((entry) => entry.id === "analytics.yearCompare")?.hidden).toBe(true);
    expect(analytics.find((entry) => entry.id === "analytics.partners")?.hidden).toBe(true);
  });
});
