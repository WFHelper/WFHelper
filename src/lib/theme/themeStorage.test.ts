import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  loadThemeSettings,
  saveThemeSettings,
  clearThemeSettings,
  cloneDefaultTheme,
} from "./themeStorage.js";
import { DEFAULT_THEME, DEFAULT_COLORS } from "../../config/themeDefaults.js";

// Mock localStorage
const store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete store[key];
  }),
};

Object.defineProperty(globalThis, "localStorage", { value: mockLocalStorage, writable: true });

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  vi.clearAllMocks();
});

describe("cloneDefaultTheme", () => {
  it("returns a deep copy of the default theme", () => {
    const clone = cloneDefaultTheme();
    expect(clone).toEqual(DEFAULT_THEME);
    expect(clone).not.toBe(DEFAULT_THEME);
    expect(clone.colors).not.toBe(DEFAULT_THEME.colors);
    expect(clone.fontSizes).not.toBe(DEFAULT_THEME.fontSizes);
    expect(clone.effects).not.toBe(DEFAULT_THEME.effects);
    expect(clone.customThemes).not.toBe(DEFAULT_THEME.customThemes);
    expect(clone.branding).not.toBe(DEFAULT_THEME.branding);
  });
});

describe("loadThemeSettings", () => {
  it("returns default when localStorage is empty", () => {
    const settings = loadThemeSettings();
    expect(settings.activePreset).toBe("default");
    expect(settings.colors.accent).toBe(DEFAULT_COLORS.accent);
  });

  it("returns default for corrupt JSON", () => {
    store["wf_theme_settings"] = "not valid json {{{";
    const settings = loadThemeSettings();
    expect(settings.activePreset).toBe("default");
  });

  it("returns default for non-object value", () => {
    store["wf_theme_settings"] = '"just a string"';
    const settings = loadThemeSettings();
    expect(settings.activePreset).toBe("default");
  });

  it("merges partial settings with defaults", () => {
    store["wf_theme_settings"] = JSON.stringify({
      version: 1,
      activePreset: "custom",
      colors: { accent: "#ff0000" },
    });
    const settings = loadThemeSettings();
    expect(settings.activePreset).toBe("custom");
    expect(settings.colors.accent).toBe("#ff0000");
    expect(settings.colors.bgBase).toBe(DEFAULT_COLORS.bgBase);
    expect(settings.effects.cornerStyle).toBe("soft");
    expect(settings.customThemes).toEqual([]);
  });

  it("normalizes saved custom themes and effects", () => {
    store["wf_theme_settings"] = JSON.stringify({
      version: 1,
      activePreset: "custom:test",
      effects: { cornerStyle: "round", surfaceStyle: "minimal", glass: true },
      customThemes: [
        {
          id: "custom:test",
          label: "My Theme",
          colors: { accent: "#00ff00" },
          fontSizes: { globalScale: 1.25 },
          effects: { cornerStyle: "sharp", surfaceStyle: "border", glass: false },
        },
      ],
    });
    const settings = loadThemeSettings();
    expect(settings.effects.cornerStyle).toBe("round");
    expect(settings.effects.surfaceStyle).toBe("minimal");
    expect(settings.effects.glass).toBe(true);
    expect(settings.customThemes).toHaveLength(1);
    expect(settings.customThemes[0]?.colors.accent).toBe("#00ff00");
    expect(settings.customThemes[0]?.effects.surfaceStyle).toBe("border");
  });

  it("validates logoDataUrl starts with data:image/", () => {
    store["wf_theme_settings"] = JSON.stringify({
      version: 1,
      branding: { logoDataUrl: "javascript:alert(1)" },
    });
    const settings = loadThemeSettings();
    expect(settings.branding.logoDataUrl).toBeNull();
  });
});

describe("saveThemeSettings", () => {
  it("persists to localStorage", () => {
    const theme = cloneDefaultTheme();
    theme.activePreset = "midnight";
    saveThemeSettings(theme);
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith("wf_theme_settings", expect.any(String));
    const saved = JSON.parse(store["wf_theme_settings"]);
    expect(saved.activePreset).toBe("midnight");
  });
});

describe("clearThemeSettings", () => {
  it("removes from localStorage", () => {
    store["wf_theme_settings"] = "{}";
    clearThemeSettings();
    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith("wf_theme_settings");
  });
});
