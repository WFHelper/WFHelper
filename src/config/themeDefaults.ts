import type {
  ThemeBaseColors,
  ThemeBranding,
  ThemeColors,
  ThemeEffects,
  ThemeFontSizes,
  ThemeSettings,
} from "../types/theme.js";
import { deriveThemeColors } from "../lib/theme/derive.js";

export const DEFAULT_BASE_COLORS: Readonly<ThemeBaseColors> = Object.freeze({
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
  gradeS: "#4ade80",
  gradeA: "#6aab7a",
  gradeB: "#facc15",
  gradeC: "#f97316",
  gradeD: "#f97316",
  gradeF: "#ef4444",
  gradeDefault: "#8b93a5",
});

export const DEFAULT_COLORS: Readonly<ThemeColors> = Object.freeze({
  ...DEFAULT_BASE_COLORS,
  ...deriveThemeColors(DEFAULT_BASE_COLORS),
});

export const DEFAULT_FONT_SIZES: Readonly<ThemeFontSizes> = Object.freeze({
  globalScale: 1.0,
});

export const GLASS_BLUR_MIN_PX = 2;
export const GLASS_BLUR_MAX_PX = 24;

export const DEFAULT_EFFECTS: Readonly<ThemeEffects> = Object.freeze({
  cornerStyle: "soft",
  surfaceStyle: "full",
  glass: false,
  glassBlurPx: 5,
  relicCardStyle: "ornate",
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
  effects: { ...DEFAULT_EFFECTS },
  customThemes: [],
  branding: { ...DEFAULT_BRANDING },
  contrastSafeMode: false,
  viewAccents: {},
  viewOverrides: {},
});

/** Limits for font size global scale */
export const FONT_SCALE_MIN = 0.75;
export const FONT_SCALE_MAX = 1.5;
export const FONT_SCALE_STEP = 0.05;

/** Limits for a per-view heading/body/small size override, in rem */
export const VIEW_FONT_SIZE_MIN = 0.5;
export const VIEW_FONT_SIZE_MAX = 3;

/** Base font size in px (from app.css html rule) */
export const BASE_FONT_SIZE_PX = 15;

/** Default app name shown in titlebar */
export const DEFAULT_APP_NAME = "WFHELPER";
