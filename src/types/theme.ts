export interface ThemeColors {
  bgDeep: string;
  bgBase: string;
  bgSurface: string;
  bgRaised: string;
  bgHover: string;
  accent: string;
  accentDim: string;
  accentBright: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  border: string;
  borderStrong: string;
}

export interface ThemeFontSizes {
  /** Global scale multiplier, 0.75–1.5; default 1.0 */
  globalScale: number;
  /** Optional per-category overrides (rem values) */
  headingSize?: number;
  bodySize?: number;
  smallSize?: number;
}

export interface ThemeBranding {
  /** Data-URL of a user-provided logo image, or null for default */
  logoDataUrl: string | null;
  /** Custom app name, or null for default "WARFRAME COMPANION" */
  appName: string | null;
}

export interface ThemeSettings {
  /** Schema version for future migrations */
  version: 1;
  /** Name of active preset, or "custom" */
  activePreset: string;
  colors: ThemeColors;
  fontSizes: ThemeFontSizes;
  branding: ThemeBranding;
  /** Enable contrast-safe mode: auto-adjusts text colors when backgrounds are too similar */
  contrastSafeMode: boolean;
}

/** Keys of ThemeColors mapped to CSS custom property names */
export const THEME_COLOR_CSS_MAP: Record<keyof ThemeColors, string> = {
  bgDeep: "--bg-deep",
  bgBase: "--bg-base",
  bgSurface: "--bg-surface",
  bgRaised: "--bg-raised",
  bgHover: "--bg-hover",
  accent: "--accent",
  accentDim: "--accent-dim",
  accentBright: "--accent-bright",
  textPrimary: "--text-primary",
  textSecondary: "--text-secondary",
  textMuted: "--text-muted",
  success: "--success",
  warning: "--warning",
  danger: "--danger",
  info: "--info",
  border: "--border",
  borderStrong: "--border-strong",
} as const;
