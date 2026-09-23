/// <reference types="node" />

import fs from "node:fs";
import path from "node:path";

import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SETTINGS_CATEGORIES } from "../../../src/stores/preferences.js";
import { APPEARANCE_TABS } from "../../../src/components/settings/appearanceTabs.js";

// Vitest has no Svelte plugin, so the components are read as source; the page is
// driven for real in e2e/settings-layout.spec.ts.
const SRC = path.join(process.cwd(), "src");
const read = (...parts: string[]): string => fs.readFileSync(path.join(SRC, ...parts), "utf8");

const settings = read("views", "SettingsView.svelte");
const template = settings.slice(settings.indexOf("</script>"));

describe("settings page", () => {
  it("renders one branch per category", () => {
    for (const category of SETTINGS_CATEGORIES.slice(0, -1)) {
      expect(template).toContain(`$settingsCategory === "${category}"}`);
    }
    expect(template).toContain("<AboutCard />");
    expect(template).toContain("<SupportersCard />");
  });

  it("switches categories through the header tabs every other view uses", () => {
    expect(template).toContain(
      "<HeaderTabs options={categoryTabs} activeKey={$settingsCategory} onSelect={selectCategory} />",
    );
    expect(template).not.toContain("settings-nav");
    // Specs and the tour find category buttons by these two attributes.
    const tabs = read("components", "HeaderTabs.svelte");
    expect(tabs).toContain("data-tour-tab={option.key}");
    expect(tabs).toContain("data-active={activeKey === option.key || undefined}");
  });

  it("splits appearance into one sub-tab per group", () => {
    const appearance = template.slice(
      template.indexOf('$settingsCategory === "appearance"}'),
      template.indexOf('$settingsCategory === "advanced"}'),
    );
    expect(appearance).toContain("data-appearance-tab={tab}");
    for (const tab of APPEARANCE_TABS.slice(0, -1)) {
      expect(appearance).toContain(`$appearanceTab === "${tab}"}`);
    }
    expect(appearance).toContain("<CustomCssSection />");
  });

  it("still binds every saved overlay-settings field", () => {
    const keyList = settings.slice(
      settings.indexOf("const OVERLAY_FORM_KEYS = ["),
      settings.indexOf("] as const;", settings.indexOf("const OVERLAY_FORM_KEYS = [")),
    );
    const keys = [...keyList.matchAll(/"(\w+)"/g)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(20);
    const unbound = keys.filter((key) => !new RegExp(`form\\.${key}\\b`).test(template));
    expect(unbound).toEqual([]);
  });

  it("keeps the selectors tests and the tour reach settings through", () => {
    for (const selector of [
      'dataSetting="language"',
      'dataSetting="game-language"',
      'data-setting="notify-only-while-game-running"',
      'data-setting="notification-sound-system"',
      'dataSetting="windows-notification-seconds"',
      'dataSetting="trade-notification-seconds"',
      "dataSetting={`webhook-${row.channel}`}",
      "dataSetting={`notify-source-${row.source}`}",
      'dataSetting="inventory-source"',
      "data-no-inventory-hint",
      "data-setting-auto-focus-search",
      'dataSetting="keep-running"',
      'dataSetting="warframe-lifecycle"',
      'dataSetting="show-mastered-badges"',
      'dataSetting="show-owned-parent-badges"',
      'dataSetting="show-foundry-ready-badges"',
      'dataSetting="show-vaulted-badges"',
      'dataSetting="relicRewardsOverlay"',
      'dataSetting="relicRecommendationOverlay"',
      'dataSetting="tradeNotificationOverlay"',
      'dataSetting="rivenOverlay"',
      'dataSetting="arbiSummaryOverlay"',
      'dataSetting="warframe-ui-scale-auto"',
      'dataSetting="warframe-ui-scale"',
      'dataSetting="riven-rescan-hotkey-enabled"',
      'dataSetting="riven-rescan-hotkey"',
      "data-overlay-editor-open={kind}",
      "data-open-overlay-placement",
      "data-settings-actions",
      "data-tour-restart",
    ]) {
      expect(template, selector).toContain(selector);
    }
  });

  it("points the settings tour steps at categories that exist", () => {
    const tour = read("components", "TourOverlay.svelte");
    const targets = [...tour.matchAll(/settingsCategory\.set\("(\w+)"\)/g)].map(
      (match) => match[1],
    );
    expect(targets).toEqual(["overlay", "general"]);
    for (const target of targets) {
      expect(SETTINGS_CATEGORIES).toContain(target);
    }
    // The last tour step lands on General and says the tour restarts from there.
    const general = template.slice(
      template.indexOf('$settingsCategory === "general"}'),
      template.indexOf('$settingsCategory === "notifications"}'),
    );
    expect(general).toContain("data-tour-restart");
  });
});

describe("appearance sub-tab", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load(stored: Record<string, string> = {}) {
    const mem = new Map(Object.entries(stored));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => void mem.set(key, value),
    });
    vi.resetModules();
    const module = await import("../../../src/components/settings/appearanceTabs.js");
    return { store: module.appearanceTab, mem };
  }

  it("opens on the theme tab and restores a saved one", async () => {
    expect(get((await load()).store)).toBe("theme");
    expect(get((await load({ wf_settings_appearance_tab: "css" })).store)).toBe("css");
    expect(get((await load({ wf_settings_appearance_tab: "bogus" })).store)).toBe("theme");
  });

  it("remembers the chosen tab", async () => {
    const { store, mem } = await load();
    store.set("sidebar");
    expect(mem.get("wf_settings_appearance_tab")).toBe("sidebar");
  });
});

describe("item badges", () => {
  const sites = [
    read("components", "inventory", "InventoryCard.svelte"),
    read("components", "inventory", "InventoryList.svelte"),
  ];

  it("gates F on its own preference and C on the parent-owned one", () => {
    for (const source of sites) {
      expect(source).toContain("{#if $showFoundryReadyBadges && marks.foundry}");
      expect(source).toContain("{#if $showOwnedParentBadges && marks.crafted}");
      expect(source).not.toMatch(
        /\$showOwnedParentBadges && \(?marks\.crafted \|\| marks\.foundry/,
      );
    }
  });
});
