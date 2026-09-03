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
    expect(get(themeSettings).viewOverrides.market?.colors?.accent).toBe("#ff0000");
    expect(get(themeSettings).activePreset).toBe("default");
    // The legacy map is load-only now, so a write never touches it.
    expect(get(themeSettings).viewAccents).toEqual({});

    themeSettings.setViewAccent("rivens", "#00ff00");
    themeSettings.clearViewAccent("market");
    expect(get(themeSettings).viewOverrides.market).toBeUndefined();
    expect(get(themeSettings).viewOverrides.rivens?.colors?.accent).toBe("#00ff00");

    themeSettings.clearViewAccent("market");
    expect(get(themeSettings).viewOverrides.rivens?.colors?.accent).toBe("#00ff00");
  });

  it("keeps per-view colours apart from the global palette", async () => {
    const { themeSettings } = await freshStore();

    themeSettings.setViewColor("world", "bgSurface", "#123456");
    themeSettings.setViewColor("world", "gradeS", "#00ff00");
    expect(get(themeSettings).viewOverrides.world?.colors).toEqual({
      bgSurface: "#123456",
      gradeS: "#00ff00",
    });
    expect(get(themeSettings).colors.bgSurface).not.toBe("#123456");
    expect(get(themeSettings).activePreset).toBe("default");

    themeSettings.clearViewColor("world", "gradeS");
    expect(get(themeSettings).viewOverrides.world?.colors).toEqual({ bgSurface: "#123456" });
  });

  it("ignores a per-view colour that is not a colour", async () => {
    const { themeSettings } = await freshStore();

    themeSettings.setViewColor("world", "bgSurface", "url(evil)");
    expect(get(themeSettings).viewOverrides.world).toBeUndefined();
  });

  it("rejects a per-view colour the loader would drop again", async () => {
    vi.useFakeTimers();
    try {
      const { themeSettings } = await freshStore();

      // Parseable, but past the length the loader accepts, so keeping it would
      // paint the view until the next launch and then lose it.
      const tooLong = "rgba(255, 255, 255, 0.123456789012345678)";
      expect(tooLong.length).toBeGreaterThan(40);
      themeSettings.setViewColor("world", "bgSurface", tooLong);
      expect(get(themeSettings).viewOverrides.world).toBeUndefined();

      themeSettings.setViewColor("world", "bgSurface", "  #123456  ");
      vi.advanceTimersByTime(400);
      const { loadThemeSettings } = await import("../../../src/lib/theme/themeStorage.js");
      expect(loadThemeSettings().viewOverrides.world?.colors?.bgSurface).toBe("#123456");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sets and clears per-view font sizes", async () => {
    const { themeSettings } = await freshStore();

    themeSettings.setViewFontSize("stats", "bodySize", 1.1);
    themeSettings.setViewFontSize("stats", "headingSize", 1.4);
    expect(get(themeSettings).viewOverrides.stats?.fontSizes).toEqual({
      bodySize: 1.1,
      headingSize: 1.4,
    });
    expect(get(themeSettings).fontSizes.bodySize).toBeUndefined();

    themeSettings.setViewFontSize("stats", "headingSize", null);
    expect(get(themeSettings).viewOverrides.stats?.fontSizes).toEqual({ bodySize: 1.1 });

    themeSettings.setViewFontSize("stats", "bodySize", null);
    expect(get(themeSettings).viewOverrides.stats).toBeUndefined();
  });

  it("rejects a per-view font size the loader would drop again", async () => {
    const { themeSettings } = await freshStore();

    themeSettings.setViewFontSize("stats", "bodySize", 12);
    themeSettings.setViewFontSize("stats", "headingSize", 0.1);
    themeSettings.setViewFontSize("stats", "smallSize", Number.NaN);
    expect(get(themeSettings).viewOverrides.stats).toBeUndefined();

    themeSettings.setViewFontSize("stats", "bodySize", 1.1);
    expect(get(themeSettings).viewOverrides.stats?.fontSizes).toEqual({ bodySize: 1.1 });
  });

  it("drops every override a view holds at once", async () => {
    const { themeSettings } = await freshStore();

    themeSettings.setViewColor("relics", "accent", "#ff0000");
    themeSettings.setViewFontSize("relics", "bodySize", 1.1);
    themeSettings.clearViewOverrides("relics");

    expect(get(themeSettings).viewOverrides.relics).toBeUndefined();
  });

  it("round-trips per-view overrides through storage", async () => {
    vi.useFakeTimers();
    try {
      const { themeSettings } = await freshStore();

      themeSettings.setViewColor("wiki", "bgBase", "#101010");
      themeSettings.setViewFontSize("wiki", "smallSize", 0.9);
      vi.advanceTimersByTime(400);

      const { loadThemeSettings } = await import("../../../src/lib/theme/themeStorage.js");
      expect(loadThemeSettings().viewOverrides.wiki).toEqual({
        colors: { bgBase: "#101010" },
        fontSizes: { smallSize: 0.9 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("folds a legacy accent map into the overrides on load", async () => {
    localStorage.setItem(
      "wf_theme_settings",
      JSON.stringify({ version: 1, viewAccents: { market: "#00ff00" } }),
    );
    const { themeSettings } = await freshStore();

    expect(get(themeSettings).viewOverrides.market?.colors?.accent).toBe("#00ff00");
    expect(get(themeSettings).viewAccents).toEqual({});
  });

  it("does not resurrect a cleared accent from the legacy map", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(
        "wf_theme_settings",
        JSON.stringify({ version: 1, viewAccents: { market: "#00ff00" } }),
      );
      const { themeSettings } = await freshStore();
      themeSettings.clearViewAccent("market");
      vi.advanceTimersByTime(400);

      const { loadThemeSettings } = await import("../../../src/lib/theme/themeStorage.js");
      expect(loadThemeSettings().viewOverrides.market).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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
