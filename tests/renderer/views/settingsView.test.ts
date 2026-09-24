/// <reference types="node" />

import fs from "node:fs";
import path from "node:path";

import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";

// Vitest has no Svelte plugin, so the components are read as source; the page is
// driven for real in e2e/settings-layout.spec.ts.
const SRC = path.join(process.cwd(), "src");
const read = (...parts: string[]): string => fs.readFileSync(path.join(SRC, ...parts), "utf8");

const settings = read("views", "SettingsView.svelte");
const template = settings.slice(settings.indexOf("</script>"));

describe("settings page", () => {
  it("still binds every saved overlay-settings field", () => {
    const keyList = settings.slice(
      settings.indexOf("const OVERLAY_FORM_KEYS = ["),
      settings.indexOf("] as const;", settings.indexOf("const OVERLAY_FORM_KEYS = [")),
    );
    const keys = [...keyList.matchAll(/"(\w+)"/g)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(20);
    for (const binding of [
      "bind:checked={form[row.key]}",
      "bind:checked={form[row.enabledKey]}",
      "bind:value={form[row.field]}",
    ]) {
      expect(template).toContain(binding);
    }
    const rowKeys = new Set(
      [...settings.matchAll(/\b(?:key|enabledKey|field): "(\w+)"/g)].map((match) => match[1]),
    );
    const unbound = keys.filter(
      (key) => !rowKeys.has(key) && !new RegExp(`form\\.${key}\\b`).test(template),
    );
    expect(unbound).toEqual([]);
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
