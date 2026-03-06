import { describe, expect, it } from "vitest";
import {
  parseColor,
  relativeLuminance,
  contrastRatio,
  autoAdjustTextColor,
  rgbToHex,
  WCAG_AA_NORMAL,
} from "./contrastUtils.js";

describe("parseColor", () => {
  it("parses 3-digit hex", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("#000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseColor("#f0a")).toEqual({ r: 255, g: 0, b: 170 });
  });

  it("parses 6-digit hex", () => {
    expect(parseColor("#d4a843")).toEqual({ r: 212, g: 168, b: 67 });
    expect(parseColor("#0a0e17")).toEqual({ r: 10, g: 14, b: 23 });
  });

  it("parses 8-digit hex (ignores alpha)", () => {
    expect(parseColor("#d4a843ff")).toEqual({ r: 212, g: 168, b: 67 });
  });

  it("parses rgb()", () => {
    expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30 });
  });

  it("parses rgba()", () => {
    expect(parseColor("rgba(100, 200, 50, 0.5)")).toEqual({ r: 100, g: 200, b: 50 });
  });

  it("clamps rgb values to 255", () => {
    expect(parseColor("rgb(300, 200, 100)")?.r).toBe(255);
  });

  it("returns null for invalid input", () => {
    expect(parseColor("")).toBeNull();
    expect(parseColor("not-a-color")).toBeNull();
    expect(parseColor("#zz")).toBeNull();
  });
});

describe("relativeLuminance", () => {
  it("returns 1 for white", () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 4);
  });

  it("returns 0 for black", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 4);
  });
});

describe("contrastRatio", () => {
  it("returns 21 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });

  it("returns 1 for identical colours", () => {
    expect(contrastRatio("#d4a843", "#d4a843")).toBeCloseTo(1, 4);
  });

  it("returns 1 for unparseable input", () => {
    expect(contrastRatio("invalid", "#000")).toBe(1);
  });
});

describe("autoAdjustTextColor", () => {
  it("lightens dark text on a dark background", () => {
    const adjusted = autoAdjustTextColor("#333333", "#0a0e17", WCAG_AA_NORMAL);
    const ratio = contrastRatio(adjusted, "#0a0e17");
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });

  it("darkens light text on a light background", () => {
    const adjusted = autoAdjustTextColor("#cccccc", "#f0f0f0", WCAG_AA_NORMAL);
    const ratio = contrastRatio(adjusted, "#f0f0f0");
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });

  it("returns the original colour if it already passes", () => {
    const original = "#ffffff";
    const adjusted = autoAdjustTextColor(original, "#000000", WCAG_AA_NORMAL);
    expect(adjusted).toBe(original);
  });

  it("returns original on invalid input", () => {
    expect(autoAdjustTextColor("bad", "#000")).toBe("bad");
  });
});

describe("rgbToHex", () => {
  it("converts to lowercase hex", () => {
    expect(rgbToHex(255, 255, 255)).toBe("#ffffff");
    expect(rgbToHex(0, 0, 0)).toBe("#000000");
    expect(rgbToHex(212, 168, 67)).toBe("#d4a843");
  });

  it("clamps values", () => {
    expect(rgbToHex(300, -10, 128)).toBe("#ff0080");
  });
});
