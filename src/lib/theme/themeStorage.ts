import type {
  CustomThemePreset,
  ThemeBaseColors,
  ThemeCornerStyle,
  ThemeColors,
  ThemeDerivedColors,
  ThemeEffects,
  ThemeFontSizes,
  RelicCardStyle,
  ThemeSettings,
  ThemeSurfaceStyle,
} from "../../types/theme.js";
import type { ViewName } from "../../types/views.js";
import {
  DEFAULT_BASE_COLORS,
  DEFAULT_BRANDING,
  DEFAULT_EFFECTS,
  DEFAULT_FONT_SIZES,
  DEFAULT_THEME,
  GLASS_BLUR_MAX_PX,
  GLASS_BLUR_MIN_PX,
} from "../../config/themeDefaults.js";
import { deriveThemeColors } from "./derive.js";

const STORAGE_KEY = "wf_theme_settings";
const CURRENT_VERSION = 1;

/** Fill missing fields in a partial theme -> complete ThemeSettings. */
function migrateAndNormalize(raw: Record<string, unknown>): ThemeSettings {
  const version = typeof raw.version === "number" ? raw.version : 0;

  // Currently only version 1 exists; future migrations go here.
  if (version < CURRENT_VERSION) {
    // Treat as fresh and merge with defaults.
  }

  const rawColors = (raw.colors && typeof raw.colors === "object" ? raw.colors : {}) as Record<
    string,
    unknown
  >;
  const rawFontSizes = (
    raw.fontSizes && typeof raw.fontSizes === "object" ? raw.fontSizes : {}
  ) as Record<string, unknown>;
  const rawBranding = (
    raw.branding && typeof raw.branding === "object" ? raw.branding : {}
  ) as Record<string, unknown>;
  const rawEffects = (raw.effects && typeof raw.effects === "object" ? raw.effects : {}) as Record<
    string,
    unknown
  >;

  return {
    version: CURRENT_VERSION as 1,
    activePreset:
      typeof raw.activePreset === "string" && raw.activePreset ? raw.activePreset : "default",
    colors: normalizeColors(rawColors),
    fontSizes: buildFontSizes(
      asNumber(rawFontSizes.globalScale, DEFAULT_FONT_SIZES.globalScale, 0.75, 1.5),
      asOptionalNumber(rawFontSizes.headingSize, 0.5, 5),
      asOptionalNumber(rawFontSizes.bodySize, 0.5, 5),
      asOptionalNumber(rawFontSizes.smallSize, 0.3, 3),
    ),
    effects: normalizeEffects(rawEffects),
    customThemes: normalizeCustomThemes(raw.customThemes),
    branding: {
      logoDataUrl:
        typeof rawBranding.logoDataUrl === "string" &&
        rawBranding.logoDataUrl.startsWith("data:image/")
          ? rawBranding.logoDataUrl
          : DEFAULT_BRANDING.logoDataUrl,
      appName:
        typeof rawBranding.appName === "string" ? rawBranding.appName : DEFAULT_BRANDING.appName,
    },
    contrastSafeMode: typeof raw.contrastSafeMode === "boolean" ? raw.contrastSafeMode : false,
    viewAccents: normalizeViewAccents(raw.viewAccents),
  };
}

const SAFE_COLOR_FUNCTION_RE = /^(?:rgb|rgba|hsl|hsla|oklch)\(\s*[-+0-9.%\s,/]+\)$/i;
const SAFE_HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function asColorString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 96 || /[;{}]/.test(trimmed)) return fallback;
  if (SAFE_HEX_COLOR_RE.test(trimmed) || SAFE_COLOR_FUNCTION_RE.test(trimmed)) {
    return trimmed;
  }
  return fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function asOptionalNumber(value: unknown, min: number, max: number): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, n));
}

function normalizeColors(rawColors: Record<string, unknown>): ThemeColors {
  const base: ThemeBaseColors = {
    bgDeep: asColorString(rawColors.bgDeep, DEFAULT_BASE_COLORS.bgDeep),
    bgBase: asColorString(rawColors.bgBase, DEFAULT_BASE_COLORS.bgBase),
    bgSurface: asColorString(rawColors.bgSurface, DEFAULT_BASE_COLORS.bgSurface),
    bgRaised: asColorString(rawColors.bgRaised, DEFAULT_BASE_COLORS.bgRaised),
    bgHover: asColorString(rawColors.bgHover, DEFAULT_BASE_COLORS.bgHover),
    accent: asColorString(rawColors.accent, DEFAULT_BASE_COLORS.accent),
    accentDim: asColorString(rawColors.accentDim, DEFAULT_BASE_COLORS.accentDim),
    accentBright: asColorString(rawColors.accentBright, DEFAULT_BASE_COLORS.accentBright),
    textPrimary: asColorString(rawColors.textPrimary, DEFAULT_BASE_COLORS.textPrimary),
    textSecondary: asColorString(rawColors.textSecondary, DEFAULT_BASE_COLORS.textSecondary),
    textMuted: asColorString(rawColors.textMuted, DEFAULT_BASE_COLORS.textMuted),
    success: asColorString(rawColors.success, DEFAULT_BASE_COLORS.success),
    warning: asColorString(rawColors.warning, DEFAULT_BASE_COLORS.warning),
    danger: asColorString(rawColors.danger, DEFAULT_BASE_COLORS.danger),
    info: asColorString(rawColors.info, DEFAULT_BASE_COLORS.info),
    border: asColorString(rawColors.border, DEFAULT_BASE_COLORS.border),
    borderStrong: asColorString(rawColors.borderStrong, DEFAULT_BASE_COLORS.borderStrong),
    gradeS: asColorString(rawColors.gradeS, DEFAULT_BASE_COLORS.gradeS),
    gradeA: asColorString(rawColors.gradeA, DEFAULT_BASE_COLORS.gradeA),
    gradeB: asColorString(rawColors.gradeB, DEFAULT_BASE_COLORS.gradeB),
    gradeC: asColorString(rawColors.gradeC, DEFAULT_BASE_COLORS.gradeC),
    gradeD: asColorString(rawColors.gradeD, DEFAULT_BASE_COLORS.gradeD),
    gradeF: asColorString(rawColors.gradeF, DEFAULT_BASE_COLORS.gradeF),
    gradeDefault: asColorString(rawColors.gradeDefault, DEFAULT_BASE_COLORS.gradeDefault),
  };

  // Settings saved before the semantic tokens existed fall back to the values
  // derived from their own base palette, not from the shipped default palette.
  const derived = deriveThemeColors(base);
  const semantic = {} as ThemeDerivedColors;
  for (const key of Object.keys(derived) as Array<keyof ThemeDerivedColors>) {
    semantic[key] = asColorString(rawColors[key], derived[key]);
  }

  return { ...base, ...semantic };
}

const VIEW_ACCENT_KEYS: ReadonlySet<string> = new Set<ViewName>([
  "setup",
  "inventory",
  "foundry",
  "mastery",
  "stats",
  "world",
  "market",
  "analytics",
  "relics",
  "wiki",
  "rivens",
  "arbi",
  "settings",
]);

function normalizeViewAccents(value: unknown): Partial<Record<ViewName, string>> {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const accents: Partial<Record<ViewName, string>> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!VIEW_ACCENT_KEYS.has(key) || typeof entry !== "string") continue;
    const color = asColorString(entry, "");
    if (color) accents[key as ViewName] = color;
  }
  return accents;
}

function asCornerStyle(value: unknown, fallback: ThemeCornerStyle): ThemeCornerStyle {
  return value === "sharp" || value === "soft" || value === "round" ? value : fallback;
}

function asSurfaceStyle(value: unknown, fallback: ThemeSurfaceStyle): ThemeSurfaceStyle {
  return value === "full" || value === "border" || value === "minimal" ? value : fallback;
}

function asRelicCardStyle(value: unknown, fallback: RelicCardStyle): RelicCardStyle {
  return value === "ornate" || value === "plain" ? value : fallback;
}

function asBlurPx(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : NaN;
  return Number.isNaN(parsed)
    ? fallback
    : Math.min(GLASS_BLUR_MAX_PX, Math.max(GLASS_BLUR_MIN_PX, parsed));
}

function normalizeEffects(rawEffects: Record<string, unknown>): ThemeEffects {
  return {
    cornerStyle: asCornerStyle(rawEffects.cornerStyle, DEFAULT_EFFECTS.cornerStyle),
    surfaceStyle: asSurfaceStyle(rawEffects.surfaceStyle, DEFAULT_EFFECTS.surfaceStyle),
    glass: typeof rawEffects.glass === "boolean" ? rawEffects.glass : DEFAULT_EFFECTS.glass,
    glassBlurPx: asBlurPx(rawEffects.glassBlurPx, DEFAULT_EFFECTS.glassBlurPx),
    relicCardStyle: asRelicCardStyle(rawEffects.relicCardStyle, DEFAULT_EFFECTS.relicCardStyle),
  };
}

function normalizeCustomThemes(value: unknown): CustomThemePreset[] {
  if (!Array.isArray(value)) return [];

  const themes: CustomThemePreset[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id.startsWith("custom:")) continue;
    if (typeof raw.label !== "string" || !raw.label.trim()) continue;

    const rawColors = (raw.colors && typeof raw.colors === "object" ? raw.colors : {}) as Record<
      string,
      unknown
    >;
    const rawFontSizes = (
      raw.fontSizes && typeof raw.fontSizes === "object" ? raw.fontSizes : {}
    ) as Record<string, unknown>;
    const rawEffects = (
      raw.effects && typeof raw.effects === "object" ? raw.effects : {}
    ) as Record<string, unknown>;

    themes.push({
      id: raw.id,
      label: raw.label.trim().slice(0, 40),
      colors: normalizeColors(rawColors),
      fontSizes: buildFontSizes(
        asNumber(rawFontSizes.globalScale, DEFAULT_FONT_SIZES.globalScale, 0.75, 1.5),
        asOptionalNumber(rawFontSizes.headingSize, 0.5, 5),
        asOptionalNumber(rawFontSizes.bodySize, 0.5, 5),
        asOptionalNumber(rawFontSizes.smallSize, 0.3, 3),
      ),
      effects: normalizeEffects(rawEffects),
    });
  }

  return themes;
}

/** Omit undefined font sizes to satisfy exactOptionalPropertyTypes. */
function buildFontSizes(
  globalScale: number,
  headingSize: number | undefined,
  bodySize: number | undefined,
  smallSize: number | undefined,
): ThemeFontSizes {
  const result: ThemeFontSizes = { globalScale };
  if (headingSize != null) result.headingSize = headingSize;
  if (bodySize != null) result.bodySize = bodySize;
  if (smallSize != null) result.smallSize = smallSize;
  return result;
}

/** Deep-clone DEFAULT_THEME so callers get an independent copy. */
export function cloneDefaultTheme(): ThemeSettings {
  return {
    ...DEFAULT_THEME,
    colors: { ...DEFAULT_THEME.colors },
    fontSizes: { ...DEFAULT_THEME.fontSizes },
    effects: { ...DEFAULT_THEME.effects },
    customThemes: DEFAULT_THEME.customThemes.map(cloneCustomTheme),
    branding: { ...DEFAULT_THEME.branding },
    viewAccents: { ...DEFAULT_THEME.viewAccents },
  };
}

function cloneCustomTheme(theme: CustomThemePreset): CustomThemePreset {
  return {
    ...theme,
    colors: { ...theme.colors },
    fontSizes: { ...theme.fontSizes },
    effects: { ...theme.effects },
  };
}

/** Load theme settings from localStorage. Returns DEFAULT_THEME on failure. */
export function loadThemeSettings(): ThemeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaultTheme();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return cloneDefaultTheme();
    return migrateAndNormalize(parsed as Record<string, unknown>);
  } catch {
    return cloneDefaultTheme();
  }
}

/** Save theme settings to localStorage. */
export function saveThemeSettings(settings: ThemeSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage quota exceeded or serialize failure; silently fail.
  }
}

/** Remove theme settings from localStorage (reset). */
export function clearThemeSettings(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
