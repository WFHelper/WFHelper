import type {
  ThemeBaseColors,
  ThemeColors,
  ThemeDerivedColors,
  ThemeFontSizes,
  ThemeSettings,
} from "../../types/theme.js";
import { THEME_COLOR_CSS_MAP } from "../../types/theme.js";
import type { ViewName } from "../../types/views.js";
import { DEFAULT_BASE_COLORS } from "../../config/themeDefaults.js";
import { accentGlowColor, contrastSafeColors } from "./applyTheme.js";
import { deriveAccentRamp, deriveThemeColors } from "./derive.js";

const BASE_COLOR_KEYS = Object.keys(DEFAULT_BASE_COLORS) as Array<keyof ThemeBaseColors>;
const ALL_COLOR_KEYS = Object.keys(THEME_COLOR_CSS_MAP) as Array<keyof ThemeColors>;

const OPTIONAL_FONT_VARS: ReadonlyArray<[Exclude<keyof ThemeFontSizes, "globalScale">, string]> = [
  ["headingSize", "--font-heading-size"],
  ["bodySize", "--font-body-size"],
  ["smallSize", "--font-small-size"],
];

/** True for the hand-picked colours; the rest are derived and cannot be scoped to a view. */
export function isBaseColorKey(key: keyof ThemeColors): key is keyof ThemeBaseColors {
  return key in DEFAULT_BASE_COLORS;
}

/** The accent a view paints with. A legacy per-view accent is already folded in here. */
export function effectiveViewAccent(settings: ThemeSettings, view: ViewName): string | undefined {
  return settings.viewOverrides[view]?.colors?.accent;
}

function baseColorsOf(colors: ThemeColors): ThemeBaseColors {
  const base = {} as ThemeBaseColors;
  for (const key of BASE_COLOR_KEYS) base[key] = colors[key];
  return base;
}

/** A scoped accent carries its ramp, so --accent-dim/-bright never stay on the global hue. */
function withAccentRamp(
  colors: Partial<ThemeBaseColors>,
  globalAccent: string,
): Partial<ThemeBaseColors> {
  if (!colors.accent || colors.accent === globalAccent) return colors;
  const ramp = deriveAccentRamp(colors.accent);
  const next = { ...colors };
  if (next.accentDim == null) next.accentDim = ramp.accentDim;
  if (next.accentBright == null) next.accentBright = ramp.accentBright;
  return next;
}

/** The view's palette: overrides merged over the global base, then re-derived. A semantic
    token the merge did not move keeps its global value, so a global edit survives here. */
function mergedColors(settings: ThemeSettings, overrides: Partial<ThemeBaseColors>): ThemeColors {
  const globalBase = baseColorsOf(settings.colors);
  const base: ThemeBaseColors = { ...globalBase, ...overrides };
  const globalDerived = deriveThemeColors(globalBase);
  const derived = deriveThemeColors(base);

  const merged: ThemeColors = { ...settings.colors, ...base };
  for (const key of Object.keys(derived) as Array<keyof ThemeDerivedColors>) {
    if (derived[key] !== globalDerived[key]) merged[key] = derived[key];
  }
  return merged;
}

function pushFontVars(
  out: string[],
  global: ThemeFontSizes,
  override: Partial<ThemeFontSizes> | undefined,
): void {
  if (!override) return;
  // No --font-global-size here: rem resolves against the root, so a scoped global
  // scale would move nothing.
  for (const [key, cssVar] of OPTIONAL_FONT_VARS) {
    const value = override[key];
    if (value != null && value !== global[key]) out.push(`${cssVar}: ${value}rem`);
  }
}

/** Inline `style` payload scoping one view's overrides. Empty when the view has none.
    Inline attributes are the only option: the window CSP forbids generated stylesheets. */
export function viewOverrideStyle(settings: ThemeSettings, view: ViewName): string {
  const override = settings.viewOverrides[view];
  const picked: Partial<ThemeBaseColors> = { ...override?.colors };

  const declarations: string[] = [];
  const globalBase = baseColorsOf(settings.colors);
  const changed = BASE_COLOR_KEYS.some(
    (key) => picked[key] != null && picked[key] !== globalBase[key],
  );

  if (changed) {
    const merged = mergedColors(settings, withAccentRamp(picked, globalBase.accent));
    const applied = settings.contrastSafeMode ? contrastSafeColors(merged) : merged;
    const globalApplied = settings.contrastSafeMode
      ? contrastSafeColors(settings.colors)
      : settings.colors;

    for (const key of ALL_COLOR_KEYS) {
      const value = applied[key];
      if (value && value !== globalApplied[key]) {
        declarations.push(`${THEME_COLOR_CSS_MAP[key]}: ${value}`);
      }
    }
    if (applied.accent !== globalApplied.accent) {
      declarations.push(`--accent-glow: ${accentGlowColor(applied.accent)}`);
    }
  }

  pushFontVars(declarations, settings.fontSizes, override?.fontSizes);
  return declarations.join("; ");
}
