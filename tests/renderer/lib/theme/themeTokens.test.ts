import { afterEach, describe, expect, it, vi } from "vitest";

import { THEME_PRESETS } from "../../../../src/config/themePresets.js";
import { DEFAULT_BASE_COLORS } from "../../../../src/config/themeDefaults.js";
import { deriveThemeColors, parseCssColor } from "../../../../src/lib/theme/derive.js";
import { loadThemeSettings } from "../../../../src/lib/theme/themeStorage.js";
import { THEME_COLOR_CSS_MAP } from "../../../../src/types/theme.js";
import type { ThemeBaseColors, ThemeColors } from "../../../../src/types/theme.js";

const BASE_KEYS = Object.keys(DEFAULT_BASE_COLORS) as Array<keyof ThemeBaseColors>;
const ALL_KEYS = Object.keys(THEME_COLOR_CSS_MAP) as Array<keyof ThemeColors>;

function stubStorage(raw: string | null): void {
  const mem = new Map<string, string>();
  if (raw !== null) mem.set("wf_theme_settings", raw);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  });
}

describe("preset completeness", () => {
  it("resolves every token in every preset", () => {
    for (const [key, preset] of Object.entries(THEME_PRESETS)) {
      for (const token of ALL_KEYS) {
        const value = preset.colors[token];
        expect(value, `${key}.${token}`).toBeTruthy();
        expect(parseCssColor(value), `${key}.${token} = ${value}`).not.toBeNull();
      }
    }
  });

  it("derives semantic tokens from each preset's own base palette", () => {
    for (const [key, preset] of Object.entries(THEME_PRESETS)) {
      const base = {} as ThemeBaseColors;
      for (const token of BASE_KEYS) base[token] = preset.colors[token];
      const derived = deriveThemeColors(base);
      for (const [token, value] of Object.entries(derived)) {
        expect(preset.colors[token as keyof ThemeColors], `${key}.${token}`).toBe(value);
      }
    }
  });

  it("leaves the 24 hand-picked colours exactly as the preset declared them", () => {
    // High Contrast Dark overrides all six grades and every state colour.
    expect(THEME_PRESETS.highContrast.colors.gradeF).toBe("#ff4444");
    expect(THEME_PRESETS.highContrast.colors.dangerBg).toBe("rgba(255, 68, 68, 0.12)");
    expect(THEME_PRESETS.default.colors.accent).toBe(DEFAULT_BASE_COLORS.accent);
  });
});

describe("settings migration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fills semantic tokens from a pre-token payload's own palette", () => {
    stubStorage(
      JSON.stringify({
        version: 1,
        activePreset: "custom",
        colors: { accent: "#ff0000", success: "#00ff00" },
        fontSizes: { globalScale: 1 },
        effects: {},
        customThemes: [],
        branding: {},
        contrastSafeMode: false,
      }),
    );

    const loaded = loadThemeSettings();
    expect(loaded.colors.accent).toBe("#ff0000");
    expect(loaded.colors.textLink).toBe("#ff0000");
    expect(loaded.colors.successBg).toBe("rgba(0, 255, 0, 0.12)");
    // Untouched base colours still fall back to the shipped defaults.
    expect(loaded.colors.bgBase).toBe(DEFAULT_BASE_COLORS.bgBase);
    expect(loaded.viewAccents).toEqual({});
  });

  it("keeps an explicitly stored semantic override", () => {
    stubStorage(JSON.stringify({ version: 1, colors: { successBg: "rgba(1, 2, 3, 0.4)" } }));
    expect(loadThemeSettings().colors.successBg).toBe("rgba(1, 2, 3, 0.4)");
  });

  it("ignores unknown keys a downgrade would leave behind", () => {
    stubStorage(
      JSON.stringify({
        version: 99,
        futureFeature: { nested: true },
        colors: { accent: "#123456", notAToken: "#ffffff" },
        viewAccents: { market: "#00ff00" },
      }),
    );

    const loaded = loadThemeSettings();
    expect(loaded.version).toBe(1);
    expect(loaded.colors.accent).toBe("#123456");
    expect("notAToken" in loaded.colors).toBe(false);
    expect(loaded.viewOverrides.market).toEqual({ colors: { accent: "#00ff00" } });
  });

  it("drops view accents that are not views or not colours", () => {
    stubStorage(
      JSON.stringify({
        version: 1,
        viewAccents: { market: "#00ff00", nope: "#ff0000", world: "url(evil)", rivens: 42 },
      }),
    );
    expect(loadThemeSettings().viewOverrides).toEqual({
      market: { colors: { accent: "#00ff00" } },
    });
  });

  it("returns an empty accent map when nothing is stored", () => {
    stubStorage(null);
    expect(loadThemeSettings().viewAccents).toEqual({});
    expect(loadThemeSettings().viewOverrides).toEqual({});
  });
});

describe("view override validation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps known views, base colour keys and in-range sizes", () => {
    stubStorage(
      JSON.stringify({
        version: 1,
        viewOverrides: {
          world: {
            colors: { bgBase: "#101010", accent: "rgba(1, 2, 3, 0.5)" },
            fontSizes: { headingSize: 1.4, bodySize: 1, smallSize: 0.8 },
          },
        },
      }),
    );

    expect(loadThemeSettings().viewOverrides).toEqual({
      world: {
        colors: { bgBase: "#101010", accent: "rgba(1, 2, 3, 0.5)" },
        fontSizes: { headingSize: 1.4, bodySize: 1, smallSize: 0.8 },
      },
    });
  });

  it("drops unknown views, unknown and derived colour keys, and bad colours", () => {
    stubStorage(
      JSON.stringify({
        version: 1,
        viewOverrides: {
          nope: { colors: { bgBase: "#101010" } },
          world: {
            colors: {
              bgBase: "#101010",
              surfacePanel: "#202020",
              notAToken: "#303030",
              bgDeep: "url(evil)",
              bgSurface: "#111111; position: fixed",
              bgRaised: 42,
            },
          },
          market: { colors: { bgBase: "javascript:alert(1)" } },
        },
      }),
    );

    expect(loadThemeSettings().viewOverrides).toEqual({
      world: { colors: { bgBase: "#101010" } },
    });
  });

  it("drops an rgb() override whose body carries junk past the channels", () => {
    stubStorage(
      JSON.stringify({
        version: 1,
        viewOverrides: {
          world: { colors: { bgBase: "rgb(1 2 3;background:red)", accent: "rgb(1 2 3 / 50%)" } },
        },
      }),
    );

    expect(loadThemeSettings().viewOverrides).toEqual({
      world: { colors: { accent: "rgb(1 2 3 / 50%)" } },
    });
  });

  it("drops out-of-range, non-numeric and unscopable font sizes", () => {
    stubStorage(
      JSON.stringify({
        version: 1,
        viewOverrides: {
          world: {
            fontSizes: { globalScale: 1.25, headingSize: 12, bodySize: "1.2", smallSize: 0.9 },
          },
          stats: { fontSizes: { globalScale: 1.25 } },
        },
      }),
    );

    // globalScale cannot be scoped to a view, so it never survives the load.
    expect(loadThemeSettings().viewOverrides).toEqual({
      world: { fontSizes: { smallSize: 0.9 } },
    });
  });

  it("folds a legacy view accent into the override that lacks one", () => {
    stubStorage(
      JSON.stringify({
        version: 1,
        viewAccents: { market: "#00ff00", world: "#0000ff" },
        viewOverrides: { world: { colors: { accent: "#ff0000", bgBase: "#101010" } } },
      }),
    );

    const loaded = loadThemeSettings();
    expect(loaded.viewOverrides.market).toEqual({ colors: { accent: "#00ff00" } });
    expect(loaded.viewOverrides.world).toEqual({
      colors: { accent: "#ff0000", bgBase: "#101010" },
    });
    // The fold consumes the legacy map, so clearing an accent cannot be undone by it.
    expect(loaded.viewAccents).toEqual({});
  });

  it("keeps a per-view accent for the dashboard, which the old map dropped", () => {
    stubStorage(JSON.stringify({ version: 1, viewAccents: { dashboard: "#00ff00" } }));
    expect(loadThemeSettings().viewOverrides.dashboard).toEqual({
      colors: { accent: "#00ff00" },
    });
  });
});
