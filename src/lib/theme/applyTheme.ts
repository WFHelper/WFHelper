import type { ThemeColors, ThemeEffects, ThemeSettings } from "../../types/theme.js";
import { THEME_COLOR_CSS_MAP, THEME_EFFECT_CSS_MAP } from "../../types/theme.js";
import { BASE_FONT_SIZE_PX } from "../../config/themeDefaults.js";
import { autoAdjustTextColor, WCAG_AA_NORMAL } from "./contrastUtils.js";

/**
 * Apply a ThemeSettings object to the document by setting CSS custom properties.
 * This function is called every time the theme store changes.
 */
export function applyTheme(settings: ThemeSettings): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const colors = resolveColors(settings);

  // Apply all colour tokens
  for (const [key, cssVar] of Object.entries(THEME_COLOR_CSS_MAP)) {
    const value = colors[key as keyof ThemeColors];
    if (value) {
      root.style.setProperty(cssVar, value);
    }
  }

  // Also set the computed accent glow (used in several places)
  const accent = colors.accent;
  root.style.setProperty("--accent-glow", hexToAccentGlow(accent));

  applyEffectTokens(root, settings.effects);

  // Font scale
  const scale = settings.fontSizes.globalScale;
  root.style.setProperty("font-size", `${BASE_FONT_SIZE_PX * scale}px`);

  // Per-category font size overrides
  if (settings.fontSizes.headingSize != null) {
    root.style.setProperty("--font-heading-size", `${settings.fontSizes.headingSize}rem`);
  } else {
    root.style.removeProperty("--font-heading-size");
  }
  if (settings.fontSizes.bodySize != null) {
    root.style.setProperty("--font-body-size", `${settings.fontSizes.bodySize}rem`);
  } else {
    root.style.removeProperty("--font-body-size");
  }
  if (settings.fontSizes.smallSize != null) {
    root.style.setProperty("--font-small-size", `${settings.fontSizes.smallSize}rem`);
  } else {
    root.style.removeProperty("--font-small-size");
  }
}

function applyEffectTokens(root: HTMLElement, effects: ThemeEffects): void {
  const radii = resolveRadii(effects.cornerStyle);
  for (const [key, value] of Object.entries(radii)) {
    root.style.setProperty(THEME_EFFECT_CSS_MAP[key as keyof typeof radii], value);
  }

  const surface = resolveSurfaceTokens(effects);
  root.style.setProperty(THEME_EFFECT_CSS_MAP.panelBg, surface.panelBg);
  root.style.setProperty(THEME_EFFECT_CSS_MAP.panelBorder, surface.panelBorder);
  root.style.setProperty(THEME_EFFECT_CSS_MAP.panelShadow, surface.panelShadow);
  root.style.setProperty(THEME_EFFECT_CSS_MAP.controlBg, surface.controlBg);
  root.style.setProperty(THEME_EFFECT_CSS_MAP.controlBorder, surface.controlBorder);
  root.style.setProperty(THEME_EFFECT_CSS_MAP.backdropBlur, surface.backdropBlur);
}

function resolveRadii(
  cornerStyle: ThemeEffects["cornerStyle"],
): Record<"radiusSm" | "radiusMd" | "radiusLg" | "radiusXl", string> {
  if (cornerStyle === "sharp") {
    return {
      radiusSm: "2px",
      radiusMd: "3px",
      radiusLg: "4px",
      radiusXl: "6px",
    };
  }

  if (cornerStyle === "round") {
    return {
      radiusSm: "0.55rem",
      radiusMd: "0.8rem",
      radiusLg: "1.05rem",
      radiusXl: "1.35rem",
    };
  }

  return {
    radiusSm: "0.28rem",
    radiusMd: "0.42rem",
    radiusLg: "0.62rem",
    radiusXl: "0.78rem",
  };
}

function resolveSurfaceTokens(effects: ThemeEffects): {
  panelBg: string;
  panelBorder: string;
  panelShadow: string;
  controlBg: string;
  controlBorder: string;
  backdropBlur: string;
} {
  if (effects.surfaceStyle === "minimal") {
    return {
      panelBg: "transparent",
      panelBorder: "transparent",
      panelShadow: "none",
      controlBg: "transparent",
      controlBorder: "transparent",
      backdropBlur: "none",
    };
  }

  if (effects.surfaceStyle === "border") {
    return {
      panelBg: "transparent",
      panelBorder: "var(--border)",
      panelShadow: "none",
      controlBg: "transparent",
      controlBorder: "var(--border)",
      backdropBlur: "none",
    };
  }

  if (effects.glass) {
    return {
      panelBg: "color-mix(in srgb, var(--bg-surface) 76%, transparent)",
      panelBorder: "color-mix(in srgb, var(--border-strong) 82%, transparent)",
      panelShadow: "0 14px 44px rgba(0, 0, 0, 0.34)",
      controlBg: "color-mix(in srgb, var(--bg-raised) 72%, transparent)",
      controlBorder: "color-mix(in srgb, var(--border) 90%, transparent)",
      backdropBlur: "blur(10px)",
    };
  }

  return {
    panelBg: "var(--bg-surface)",
    panelBorder: "var(--border)",
    panelShadow: "0 10px 30px rgba(0, 0, 0, 0.22)",
    controlBg: "var(--bg-raised)",
    controlBorder: "var(--border)",
    backdropBlur: "none",
  };
}

/**
 * Resolve colours, applying contrast-safe mode adjustments if enabled.
 */
function resolveColors(settings: ThemeSettings): ThemeColors {
  const colors = { ...settings.colors };

  if (settings.contrastSafeMode) {
    const bg = colors.bgBase;
    colors.textPrimary = autoAdjustTextColor(colors.textPrimary, bg, WCAG_AA_NORMAL);
    colors.textSecondary = autoAdjustTextColor(colors.textSecondary, bg, WCAG_AA_NORMAL);
    colors.textMuted = autoAdjustTextColor(colors.textMuted, bg, 3.0);
  }

  return colors;
}

/**
 * Derive an accent-glow rgba() value from a hex colour.
 * Falls back to the default accent-glow if parsing fails.
 */
function hexToAccentGlow(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return "rgba(212, 168, 67, 0.15)";
  const r = parseInt(match[1], 16);
  const g = parseInt(match[2], 16);
  const b = parseInt(match[3], 16);
  return `rgba(${r}, ${g}, ${b}, 0.15)`;
}
