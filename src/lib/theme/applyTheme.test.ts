import { describe, expect, it, beforeEach, vi } from "vitest";
import { applyTheme } from "./applyTheme.js";
import { cloneDefaultTheme } from "./themeStorage.js";
import { THEME_COLOR_CSS_MAP, THEME_EFFECT_CSS_MAP } from "../../types/theme.js";

// Mock document.documentElement.style
const styleProps = new Map<string, string>();
const mockStyle = {
  setProperty: vi.fn((key: string, value: string) => styleProps.set(key, value)),
  removeProperty: vi.fn((key: string) => styleProps.delete(key)),
};

Object.defineProperty(globalThis, "document", {
  value: { documentElement: { style: mockStyle } },
  writable: true,
});

beforeEach(() => {
  styleProps.clear();
  vi.clearAllMocks();
});

describe("applyTheme", () => {
  it("sets all colour CSS variables", () => {
    const theme = cloneDefaultTheme();
    applyTheme(theme);

    for (const cssVar of Object.values(THEME_COLOR_CSS_MAP)) {
      expect(styleProps.has(cssVar)).toBe(true);
    }
  });

  it("sets accent-glow derived from accent colour", () => {
    const theme = cloneDefaultTheme();
    theme.colors.accent = "#ff0000";
    applyTheme(theme);

    expect(styleProps.get("--accent-glow")).toBe("rgba(255, 0, 0, 0.15)");
  });

  it("sets font-size based on globalScale", () => {
    const theme = cloneDefaultTheme();
    theme.fontSizes.globalScale = 1.2;
    applyTheme(theme);

    const fontSize = styleProps.get("font-size");
    expect(fontSize).toContain("px");
  });

  it("sets effect CSS variables", () => {
    const theme = cloneDefaultTheme();
    theme.effects.cornerStyle = "round";
    theme.effects.surfaceStyle = "border";
    applyTheme(theme);

    for (const cssVar of Object.values(THEME_EFFECT_CSS_MAP)) {
      expect(styleProps.has(cssVar)).toBe(true);
    }
    expect(styleProps.get("--radius-lg")).toBe("1.05rem");
    expect(styleProps.get("--ui-panel-bg")).toBe("transparent");
    expect(styleProps.get("--ui-panel-border")).toBe("var(--border)");
  });

  it("sets sharp corners to zero radius", () => {
    const theme = cloneDefaultTheme();
    theme.effects.cornerStyle = "sharp";
    applyTheme(theme);

    expect(styleProps.get("--radius-sm")).toBe("0px");
    expect(styleProps.get("--radius-xl")).toBe("0px");
  });

  it("enables real blur for full glass surfaces", () => {
    const theme = cloneDefaultTheme();
    theme.effects.glass = true;
    applyTheme(theme);

    expect(styleProps.get("--ui-backdrop-blur")).toBe("blur(10px)");
  });

  it("sets per-category font size variables when defined", () => {
    const theme = cloneDefaultTheme();
    theme.fontSizes.headingSize = 2.0;
    theme.fontSizes.bodySize = 1.0;
    theme.fontSizes.smallSize = 0.75;
    applyTheme(theme);

    expect(styleProps.get("--font-heading-size")).toBe("2rem");
    expect(styleProps.get("--font-body-size")).toBe("1rem");
    expect(styleProps.get("--font-small-size")).toBe("0.75rem");
  });

  it("removes per-category font size variables when undefined", () => {
    const theme = cloneDefaultTheme();
    // No headingSize/bodySize/smallSize set
    applyTheme(theme);

    expect(mockStyle.removeProperty).toHaveBeenCalledWith("--font-heading-size");
    expect(mockStyle.removeProperty).toHaveBeenCalledWith("--font-body-size");
    expect(mockStyle.removeProperty).toHaveBeenCalledWith("--font-small-size");
  });

  it("adjusts text colours in contrast-safe mode", () => {
    const theme = cloneDefaultTheme();
    theme.contrastSafeMode = true;
    // Use a very dark bg and a dark text that would fail contrast
    theme.colors.bgBase = "#0a0e17";
    theme.colors.textPrimary = "#333333";
    applyTheme(theme);

    // The text-primary should have been lightened
    const textPrimary = styleProps.get("--text-primary");
    expect(textPrimary).toBeDefined();
    expect(textPrimary).not.toBe("#333333");
  });
});
