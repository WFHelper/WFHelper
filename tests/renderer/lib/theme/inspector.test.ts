import { describe, expect, it } from "vitest";

import {
  buildTokenValueMap,
  matchComputedColors,
  toHexInputValue,
} from "../../../../src/lib/theme/inspector.js";
import { DEFAULT_COLORS } from "../../../../src/config/themeDefaults.js";
import { THEME_COLOR_CSS_MAP } from "../../../../src/types/theme.js";

/** Stand-in for getComputedStyle on :root or a [data-view] scope. */
function resolverFor(colors: Record<string, string>): (cssVar: string) => string {
  const byVar = new Map<string, string>();
  for (const [key, cssVar] of Object.entries(THEME_COLOR_CSS_MAP)) {
    const value = colors[key];
    if (value) byVar.set(cssVar, value);
  }
  return (cssVar) => byVar.get(cssVar) ?? "";
}

describe("value normalisation", () => {
  const map = buildTokenValueMap(resolverFor({ ...DEFAULT_COLORS, accent: "#ffffff" }));

  it("collapses equivalent notations onto one token", () => {
    const fromHex = matchComputedColors({ color: "#ffffff" }, map);
    const fromShortHex = matchComputedColors({ color: "#fff" }, map);
    const fromRgb = matchComputedColors({ color: "rgb(255, 255, 255)" }, map);
    const fromRgba = matchComputedColors({ color: "rgba(255, 255, 255, 1)" }, map);
    expect(fromHex.map((m) => m.colorKey)).toContain("accent");
    expect(fromShortHex.map((m) => m.colorKey)).toEqual(fromHex.map((m) => m.colorKey));
    expect(fromRgb.map((m) => m.colorKey)).toEqual(fromHex.map((m) => m.colorKey));
    expect(fromRgba.map((m) => m.colorKey)).toEqual(fromHex.map((m) => m.colorKey));
  });

  it("treats a different alpha as a different colour", () => {
    expect(matchComputedColors({ color: "rgba(255, 255, 255, 0.5)" }, map)).toEqual([]);
  });
});

describe("buildTokenValueMap", () => {
  it("groups tokens that currently share a value", () => {
    const map = buildTokenValueMap(resolverFor(DEFAULT_COLORS));
    const keys = matchComputedColors({ color: DEFAULT_COLORS.textPrimary }, map).map(
      (m) => m.colorKey,
    );
    expect(keys).toContain("textPrimary");
    expect(keys).toContain("textHeading");
    expect(keys).toContain("textBody");
    // Declaration order puts the base palette ahead of the derived roles.
    expect(keys[0]).toBe("textPrimary");
  });

  it("skips vars that resolve to nothing", () => {
    const map = buildTokenValueMap(() => "");
    expect(map.size).toBe(0);
  });
});

describe("matchComputedColors", () => {
  const map = buildTokenValueMap(resolverFor(DEFAULT_COLORS));

  it("names the token behind each painted property", () => {
    const matches = matchComputedColors(
      { color: "rgb(232, 228, 220)", "background-color": "rgb(17, 24, 39)" },
      map,
    );
    const pairs = matches.map((m) => `${m.property}:${m.colorKey}`);
    expect(pairs).toContain("color:textPrimary");
    expect(pairs).toContain("background-color:bgSurface");
    expect(matches.every((m) => m.cssVar.startsWith("--"))).toBe(true);
  });

  it("reports properties in inspection order and ignores unmatched paint", () => {
    const matches = matchComputedColors(
      { "background-color": "rgb(17, 24, 39)", color: "rgb(1, 2, 3)" },
      map,
    );
    expect(matches.map((m) => m.property)).toEqual(["background-color", "background-color"]);
    // bgSurface and the surfacePanel role share a value, so both are offered.
    expect(matches.map((m) => m.colorKey)).toEqual(["bgSurface", "surfacePanel"]);
  });

  it("returns nothing for a fully transparent element", () => {
    expect(
      matchComputedColors({ "background-color": "rgba(0, 0, 0, 0)", fill: "none" }, map),
    ).toEqual([]);
  });

  it("resolves against the scope it was given, so a per-view accent still matches", () => {
    const viewMap = buildTokenValueMap(
      resolverFor({ ...DEFAULT_COLORS, accent: "#ff0000", textLink: "#ff0000" }),
    );
    const matches = matchComputedColors({ color: "rgb(255, 0, 0)" }, viewMap);
    expect(matches.map((m) => m.colorKey)).toEqual(["accent", "textLink"]);
  });
});

describe("toHexInputValue", () => {
  it("flattens rgba and falls back on unparseable input", () => {
    expect(toHexInputValue("rgba(212, 168, 67, 0.1)")).toBe("#d4a843");
    expect(toHexInputValue("#d4a843")).toBe("#d4a843");
    expect(toHexInputValue("var(--accent)")).toBe("#888888");
  });
});
