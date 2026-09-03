import { describe, expect, it } from "vitest";

import { DEFAULT_THEME } from "../../../../src/config/themeDefaults.js";
import { deriveThemeColors } from "../../../../src/lib/theme/derive.js";
import {
  effectiveViewAccent,
  isBaseColorKey,
  viewOverrideStyle,
} from "../../../../src/lib/theme/viewOverrides.js";
import { autoAdjustTextColor, WCAG_AA_NORMAL } from "../../../../src/lib/theme/contrastUtils.js";
import type { ThemeSettings, ViewThemeOverride } from "../../../../src/types/theme.js";
import type { ViewName } from "../../../../src/types/views.js";

function settingsWith(
  overrides: Partial<Record<ViewName, ViewThemeOverride>>,
  extra: Partial<ThemeSettings> = {},
): ThemeSettings {
  return {
    ...DEFAULT_THEME,
    colors: { ...DEFAULT_THEME.colors },
    fontSizes: { ...DEFAULT_THEME.fontSizes },
    effects: { ...DEFAULT_THEME.effects },
    branding: { ...DEFAULT_THEME.branding },
    customThemes: [],
    viewAccents: {},
    viewOverrides: overrides,
    ...extra,
  };
}

function declarations(style: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of style.split("; ")) {
    if (!part) continue;
    const at = part.indexOf(":");
    map.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return map;
}

describe("viewOverrideStyle", () => {
  it("emits nothing for a view with no override", () => {
    expect(viewOverrideStyle(settingsWith({}), "market")).toBe("");
    expect(viewOverrideStyle(settingsWith({ world: { colors: {} } }), "market")).toBe("");
  });

  it("emits nothing when an override repeats the global value", () => {
    const settings = settingsWith({ market: { colors: { accent: DEFAULT_THEME.colors.accent } } });
    expect(viewOverrideStyle(settings, "market")).toBe("");
  });

  it("carries the accent ramp, the glow and the accent-derived tokens", () => {
    const settings = settingsWith({ market: { colors: { accent: "#808080" } } });
    const style = declarations(viewOverrideStyle(settings, "market"));

    expect(style.get("--accent")).toBe("#808080");
    expect(style.get("--accent-dim")).toBe("#5c5c5c");
    expect(style.get("--accent-bright")).toBe("#a4a4a4");
    expect(style.get("--accent-glow")).toBe("rgba(128, 128, 128, 0.15)");
    expect(style.get("--text-link")).toBe("#808080");
    expect(style.get("--chart-1")).toBe("#808080");
    expect(style.get("--surface-selected")).toBe("rgba(128, 128, 128, 0.15)");
    // Nothing the accent does not reach may move.
    expect(style.has("--bg-base")).toBe(false);
    expect(style.has("--relic-lith")).toBe(false);
  });

  it("keeps an explicit ramp colour instead of deriving it", () => {
    const settings = settingsWith({
      market: { colors: { accent: "#808080", accentDim: "#111111" } },
    });
    expect(declarations(viewOverrideStyle(settings, "market")).get("--accent-dim")).toBe("#111111");
  });

  it("re-derives the surfaces a background override feeds", () => {
    const settings = settingsWith({
      world: { colors: { bgSurface: "#123456", bgRaised: "#654321" } },
    });
    const style = declarations(viewOverrideStyle(settings, "world"));

    expect(style.get("--bg-surface")).toBe("#123456");
    expect(style.get("--surface-panel")).toBe("#123456");
    expect(style.get("--surface-card")).toBe("#654321");
    expect(style.get("--surface-input")).toBe("#654321");
    expect(style.has("--accent")).toBe(false);
  });

  it("leaves a globally customised semantic token alone when the derivation does not move it", () => {
    const settings = settingsWith({ world: { colors: { accent: "#808080" } } });
    settings.colors = { ...settings.colors, surfaceHover: "rgba(9, 9, 9, 0.5)" };
    expect(declarations(viewOverrideStyle(settings, "world")).has("--surface-hover")).toBe(false);
  });

  it("ignores the legacy accent map, which the loader folds in instead", () => {
    const settings = settingsWith({}, { viewAccents: { rivens: "#808080" } });
    expect(viewOverrideStyle(settings, "rivens")).toBe("");
  });

  it("emits the font vars applyTheme would compute", () => {
    const settings = settingsWith({
      stats: { fontSizes: { globalScale: 1.2, headingSize: 1.4, smallSize: 0.7 } },
    });
    const style = declarations(viewOverrideStyle(settings, "stats"));

    expect(style.get("--font-heading-size")).toBe("1.4rem");
    expect(style.get("--font-small-size")).toBe("0.7rem");
    expect(style.has("--font-body-size")).toBe(false);
    // rem resolves against the root, so a scoped global scale is never emitted.
    expect(style.has("--font-global-size")).toBe(false);
    expect(style.has("--accent")).toBe(false);
  });

  it("skips a font override that matches the global size", () => {
    const settings = settingsWith({ stats: { fontSizes: { bodySize: 1.1 } } });
    settings.fontSizes = { ...settings.fontSizes, bodySize: 1.1 };
    expect(viewOverrideStyle(settings, "stats")).toBe("");
  });

  it("lifts overridden text colours in contrast-safe mode", () => {
    const raw = "#0b0f18";
    const settings = settingsWith(
      { foundry: { colors: { textPrimary: raw } } },
      { contrastSafeMode: true },
    );
    const style = declarations(viewOverrideStyle(settings, "foundry"));
    const lifted = autoAdjustTextColor(raw, DEFAULT_THEME.colors.bgBase, WCAG_AA_NORMAL);

    expect(lifted).not.toBe(raw);
    expect(style.get("--text-primary")).toBe(lifted);
    expect(style.get("--text-heading")).toBe(lifted);
    expect(style.get("--text-body")).toBe(lifted);
  });

  it("emits the raw text colour when contrast-safe mode is off", () => {
    const settings = settingsWith({ foundry: { colors: { textPrimary: "#0b0f18" } } });
    expect(declarations(viewOverrideStyle(settings, "foundry")).get("--text-primary")).toBe(
      "#0b0f18",
    );
  });

  it("derives every semantic token from the merged palette", () => {
    const settings = settingsWith({ world: { colors: { success: "#00ff00" } } });
    const style = declarations(viewOverrideStyle(settings, "world"));
    const derived = deriveThemeColors({ ...DEFAULT_THEME.colors, success: "#00ff00" });

    expect(style.get("--success-bg")).toBe(derived.successBg);
    expect(style.get("--text-positive")).toBe("#00ff00");
  });
});

describe("effectiveViewAccent", () => {
  it("reads the override and nothing else", () => {
    const settings = settingsWith(
      { market: { colors: { accent: "#111111" } }, stats: { fontSizes: { bodySize: 1.1 } } },
      { viewAccents: { world: "#333333" } },
    );
    expect(effectiveViewAccent(settings, "market")).toBe("#111111");
    expect(effectiveViewAccent(settings, "stats")).toBeUndefined();
    expect(effectiveViewAccent(settings, "world")).toBeUndefined();
  });
});

describe("isBaseColorKey", () => {
  it("separates the hand-picked colours from the derived ones", () => {
    expect(isBaseColorKey("accent")).toBe(true);
    expect(isBaseColorKey("gradeS")).toBe(true);
    expect(isBaseColorKey("surfacePanel")).toBe(false);
    expect(isBaseColorKey("textLink")).toBe(false);
  });
});
