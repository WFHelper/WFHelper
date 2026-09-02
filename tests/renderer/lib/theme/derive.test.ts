import { describe, expect, it } from "vitest";

import {
  deriveThemeColors,
  parseCssColor,
  viewAccentStyle,
  viewAccentVars,
} from "../../../../src/lib/theme/derive.js";
import { DEFAULT_BASE_COLORS, DEFAULT_COLORS } from "../../../../src/config/themeDefaults.js";

describe("parseCssColor", () => {
  it("reads short and long hex, with and without alpha", () => {
    expect(parseCssColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseCssColor("#d4a843")).toEqual({ r: 212, g: 168, b: 67, a: 1 });
    expect(parseCssColor("#00000080")?.a).toBeCloseTo(0.502, 2);
  });

  it("reads rgb() in comma and slash notation", () => {
    expect(parseCssColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseCssColor("rgba(1, 2, 3, 0.5)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseCssColor("rgb(1 2 3 / 50%)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
  });

  it("rejects anything that is not a colour", () => {
    expect(parseCssColor("")).toBeNull();
    expect(parseCssColor("var(--accent)")).toBeNull();
    expect(parseCssColor("transparent")).toBeNull();
    expect(parseCssColor("#12")).toBeNull();
    expect(parseCssColor("rgb(1, 2)")).toBeNull();
  });
});

describe("accent ramp", () => {
  it("emits nothing without an accent", () => {
    expect(viewAccentStyle(undefined)).toBe("");
    expect(viewAccentVars(undefined)).toBe("");
  });

  it("darkens dim, lightens bright and keeps the glow at 15% alpha", () => {
    expect(viewAccentStyle("#808080")).toBe(
      "--accent: #808080; --accent-dim: #5c5c5c; --accent-bright: #a4a4a4; " +
        "--accent-glow: rgba(128, 128, 128, 0.15)",
    );
  });

  it("scopes the shell vars separately so the sidebar can opt in", () => {
    const vars = viewAccentVars("#808080");
    expect(vars).toContain("--view-accent: #808080");
    expect(vars).toContain("--view-accent-glow: rgba(128, 128, 128, 0.15)");
    expect(vars).not.toContain("--accent:");
  });
});

describe("deriveThemeColors", () => {
  it("ties every semantic token back to the base palette", () => {
    const derived = deriveThemeColors(DEFAULT_BASE_COLORS);
    expect(derived.textHeading).toBe(DEFAULT_BASE_COLORS.textPrimary);
    expect(derived.textBody).toBe(DEFAULT_BASE_COLORS.textPrimary);
    expect(derived.textLink).toBe(DEFAULT_BASE_COLORS.accent);
    expect(derived.textPositive).toBe(DEFAULT_BASE_COLORS.success);
    expect(derived.textNegative).toBe(DEFAULT_BASE_COLORS.danger);
    expect(derived.surfacePanel).toBe(DEFAULT_BASE_COLORS.bgSurface);
    expect(derived.surfaceCard).toBe(DEFAULT_BASE_COLORS.bgRaised);
    expect(derived.surfaceInput).toBe(DEFAULT_BASE_COLORS.bgRaised);
    expect(derived.surfaceTooltip).toBe(DEFAULT_BASE_COLORS.bgDeep);
    expect(derived.surfacePanelBorder).toBe(DEFAULT_BASE_COLORS.border);
    expect(derived.chartAxis).toBe(DEFAULT_BASE_COLORS.textMuted);
  });

  it("builds state ramps by darkening and by dropping alpha to 12%", () => {
    const derived = deriveThemeColors({
      ...DEFAULT_BASE_COLORS,
      success: "#00ff00",
      danger: "#808080",
    });
    expect(derived.successBg).toBe("rgba(0, 255, 0, 0.12)");
    expect(derived.dangerDim).toBe("#575757");
    expect(derived.dangerBg).toBe("rgba(128, 128, 128, 0.12)");
  });

  it("picks readable ink for text drawn on the accent", () => {
    expect(deriveThemeColors({ ...DEFAULT_BASE_COLORS, accent: "#ffffff" }).textOnAccent).toBe(
      "#12151a",
    );
    expect(deriveThemeColors({ ...DEFAULT_BASE_COLORS, accent: "#101010" }).textOnAccent).toBe(
      "#f7f8fa",
    );
  });

  it("blends the sixth chart series away from the other five", () => {
    const derived = deriveThemeColors({
      ...DEFAULT_BASE_COLORS,
      info: "#000000",
      danger: "#ffffff",
    });
    expect(derived.chart6).toBe("#808080");
  });

  it("keeps the hover wash at its historical value so presets do not shift", () => {
    expect(deriveThemeColors(DEFAULT_BASE_COLORS).surfaceHover).toBe("rgba(255, 255, 255, 0.05)");
  });

  it("follows a recoloured base palette instead of the shipped defaults", () => {
    const derived = deriveThemeColors({ ...DEFAULT_BASE_COLORS, success: "#00ff00" });
    expect(derived.textPositive).toBe("#00ff00");
    expect(derived.chart3).toBe("#00ff00");
  });

  it("leaves the 24 base colours untouched in DEFAULT_COLORS", () => {
    for (const key of Object.keys(DEFAULT_BASE_COLORS) as Array<keyof typeof DEFAULT_BASE_COLORS>) {
      expect(DEFAULT_COLORS[key]).toBe(DEFAULT_BASE_COLORS[key]);
    }
  });
});
