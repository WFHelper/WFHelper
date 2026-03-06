import type { ThemeColors, ThemeFontSizes, ThemeBranding, ThemeSettings } from "../types/theme.js";

export const DEFAULT_COLORS: Readonly<ThemeColors> = Object.freeze({
  bgDeep: "#060a12",
  bgBase: "#0a0e17",
  bgSurface: "#111827",
  bgRaised: "#1a2234",
  bgHover: "#1f2b3f",
  accent: "#d4a843",
  accentDim: "#a07830",
  accentBright: "#f0c95c",
  textPrimary: "#e8e4dc",
  textSecondary: "#8b93a5",
  textMuted: "#8d9ab3",
  success: "#4ade80",
  warning: "#fbbf24",
  danger: "#f87171",
  info: "#60a5fa",
  border: "rgba(212, 168, 67, 0.1)",
  borderStrong: "rgba(212, 168, 67, 0.25)",
});

export const DEFAULT_FONT_SIZES: Readonly<ThemeFontSizes> = Object.freeze({
  globalScale: 1.0,
});

export const DEFAULT_BRANDING: Readonly<ThemeBranding> = Object.freeze({
  logoDataUrl: null,
  appName: null,
});

export const DEFAULT_THEME: Readonly<ThemeSettings> = Object.freeze({
  version: 1 as const,
  activePreset: "default",
  colors: { ...DEFAULT_COLORS },
  fontSizes: { ...DEFAULT_FONT_SIZES },
  branding: { ...DEFAULT_BRANDING },
  contrastSafeMode: false,
});

/** Limits for font size global scale */
export const FONT_SCALE_MIN = 0.75;
export const FONT_SCALE_MAX = 1.5;
export const FONT_SCALE_STEP = 0.05;

/** Base font size in px (from app.css html rule) */
export const BASE_FONT_SIZE_PX = 15;

/** Maximum logo file size in bytes (256 KB) */
export const LOGO_MAX_BYTES = 256 * 1024;

/** Maximum app name length */
export const APP_NAME_MAX_LENGTH = 30;

/** Default app name shown in titlebar */
export const DEFAULT_APP_NAME = "WARFRAME COMPANION";
