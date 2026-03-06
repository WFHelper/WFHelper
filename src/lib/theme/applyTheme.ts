import type { ThemeSettings, ThemeColors } from "../../types/theme.js";
import { THEME_COLOR_CSS_MAP } from "../../types/theme.js";
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
