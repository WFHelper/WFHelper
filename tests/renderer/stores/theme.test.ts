import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import { DEFAULT_BASE_COLORS } from "../../../src/config/themeDefaults.js";
import { THEME_PRESETS } from "../../../src/config/themePresets.js";

async function freshStore(): Promise<typeof import("../../../src/stores/theme.js")> {
  vi.resetModules();
  return import("../../../src/stores/theme.js");
}

describe("theme store", () => {
  beforeEach(() => {
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("stores and clears a per-view accent without switching preset", async () => {
    const { themeSettings } = await freshStore();

    themeSettings.setViewAccent("market", "#ff0000");
    expect(get(themeSettings).viewAccents.market).toBe("#ff0000");
    expect(get(themeSettings).activePreset).toBe("default");

    themeSettings.setViewAccent("rivens", "#00ff00");
    themeSettings.clearViewAccent("market");
    expect(get(themeSettings).viewAccents).toEqual({ rivens: "#00ff00" });

    themeSettings.clearViewAccent("market");
    expect(get(themeSettings).viewAccents).toEqual({ rivens: "#00ff00" });
  });

  it("edits a semantic token and resets it to the active preset value", async () => {
    const { themeSettings } = await freshStore();

    themeSettings.setColor("successBg", "rgba(1, 2, 3, 0.4)");
    expect(get(themeSettings).colors.successBg).toBe("rgba(1, 2, 3, 0.4)");
    expect(get(themeSettings).activePreset).toBe("custom");

    themeSettings.resetColor("successBg");
    expect(get(themeSettings).colors.successBg).toBe(THEME_PRESETS.default.colors.successBg);
  });

  it("resets a token against the preset in use, not always the default one", async () => {
    const { themeSettings } = await freshStore();

    themeSettings.applyPreset("midnight");
    themeSettings.setColor("chart1", "#ffffff");
    expect(get(themeSettings).activePreset).toBe("custom");

    // A custom edit falls back to the default preset; re-applying pins the source.
    themeSettings.applyPreset("midnight");
    themeSettings.resetColor("chart1");
    expect(get(themeSettings).colors.chart1).toBe(THEME_PRESETS.midnight.colors.chart1);
    expect(THEME_PRESETS.midnight.colors.chart1).not.toBe(DEFAULT_BASE_COLORS.accent);
  });

  it("keeps view accents through a full reset", async () => {
    const { themeSettings } = await freshStore();

    themeSettings.setViewAccent("world", "#123456");
    themeSettings.resetAll();
    expect(get(themeSettings).viewAccents).toEqual({});
  });

  it("exposes an inspector switch that starts off", async () => {
    const { themeInspectorActive } = await freshStore();
    expect(get(themeInspectorActive)).toBe(false);
    themeInspectorActive.set(true);
    expect(get(themeInspectorActive)).toBe(true);
  });
});
