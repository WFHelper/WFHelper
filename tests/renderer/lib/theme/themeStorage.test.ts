import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { asOverrideColor, loadThemeSettings } from "../../../../src/lib/theme/themeStorage.js";
import { DEFAULT_BASE_COLORS } from "../../../../src/config/themeDefaults.js";
import { VIEW_NAMES } from "../../../../src/types/views.js";

function store(settings: unknown): void {
  localStorage.setItem("wf_theme_settings", JSON.stringify(settings));
}

function stubStorage(): void {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => void mem.set(key, value),
    removeItem: (key: string) => void mem.delete(key),
  });
}

describe("persisted colour grammar", () => {
  it("accepts every hex length and every numeric colour function", () => {
    for (const value of [
      "#abc",
      "#abcd",
      "#d4a843",
      "#d4a84380",
      "#D4A843",
      "rgb(1, 2, 3)",
      "rgba(1 2 3 / 50%)",
      "hsl(210, 40%, 50%)",
      "hsla(210 40% 50% / 0.5)",
      "oklch(0.7 0.1 250)",
    ]) {
      expect(asOverrideColor(value)).toBe(value);
    }
    expect(asOverrideColor("  #d4a843  ")).toBe("#d4a843");
  });

  it("rejects a name, a non-colour function and anything that is not a string", () => {
    for (const value of ["", "   ", "red", "transparent", "var(--accent)", "#12", "#1234567"]) {
      expect(asOverrideColor(value)).toBeUndefined();
    }
    expect(asOverrideColor("color-mix(in srgb, red, blue)")).toBeUndefined();
    expect(asOverrideColor(42)).toBeUndefined();
    expect(asOverrideColor(null)).toBeUndefined();
  });

  it("rejects a value that could carry a second declaration or a fetch", () => {
    expect(asOverrideColor("rgb(1 2 3);background:url(https://evil.example/a)")).toBeUndefined();
    expect(asOverrideColor("rgb(1 2 3) }")).toBeUndefined();
    expect(asOverrideColor("url(https://evil.example/a.png)")).toBeUndefined();
  });

  it("caps a per-view colour at 40 characters", () => {
    const atCap = `rgb(${"1".repeat(35)})`;
    expect(atCap.length).toBe(40);
    expect(asOverrideColor(atCap)).toBe(atCap);
    expect(asOverrideColor(`rgb(${"1".repeat(36)})`)).toBeUndefined();
  });
});

describe("palette colour length", () => {
  beforeEach(stubStorage);

  afterEach(() => vi.unstubAllGlobals());

  // The palette goes through setProperty, not a style attribute, so it takes a
  // longer value than a per-view override does.
  it("caps a palette colour at 96 characters", () => {
    const atCap = `rgb(${"1".repeat(91)})`;
    expect(atCap.length).toBe(96);
    store({ version: 1, colors: { bgDeep: atCap } });
    expect(loadThemeSettings().colors.bgDeep).toBe(atCap);

    store({ version: 1, colors: { bgDeep: `rgb(${"1".repeat(92)})` } });
    expect(loadThemeSettings().colors.bgDeep).toBe(DEFAULT_BASE_COLORS.bgDeep);
  });
});

describe("per-view override keys", () => {
  beforeEach(stubStorage);

  afterEach(() => vi.unstubAllGlobals());

  it("keeps an override for every view the app knows", () => {
    const viewOverrides = Object.fromEntries(
      VIEW_NAMES.map((view) => [view, { colors: { accent: "#123456" } }]),
    );
    store({ version: 1, viewOverrides });
    expect(Object.keys(loadThemeSettings().viewOverrides).sort()).toEqual([...VIEW_NAMES].sort());
  });

  it("drops a key that is not a view", () => {
    store({
      version: 1,
      viewOverrides: {
        world: { colors: { accent: "#123456" } },
        "not-a-view": { colors: { accent: "#123456" } },
        constructor: { colors: { accent: "#123456" } },
      },
    });
    expect(Object.keys(loadThemeSettings().viewOverrides)).toEqual(["world"]);
  });

  it("drops a colour key that only looks like one because it is on Object", () => {
    store({
      version: 1,
      viewOverrides: {
        world: { colors: { accent: "#123456", constructor: "#654321", toString: "#111111" } },
      },
    });
    expect(loadThemeSettings().viewOverrides.world?.colors).toEqual({ accent: "#123456" });
  });

  it("takes the same colour grammar for the global palette and a view override", () => {
    store({
      version: 1,
      colors: { accent: "oklch(0.7 0.1 250)" },
      viewOverrides: { world: { colors: { accent: "oklch(0.7 0.1 250)", bgBase: "red" } } },
    });
    const settings = loadThemeSettings();
    expect(settings.colors.accent).toBe("oklch(0.7 0.1 250)");
    expect(settings.viewOverrides.world?.colors).toEqual({ accent: "oklch(0.7 0.1 250)" });
  });
});
