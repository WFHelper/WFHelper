import type { ThemeBaseColors, ThemeDerivedColors } from "../../types/theme.js";

/** Parsed sRGB colour with straight (non-premultiplied) alpha. */
interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

// Derivation runs in JS rather than CSS color-mix() because the results are
// persisted into presets, forwarded to overlay windows as concrete strings, and
// compared by the inspector's value-to-token map, which all need real values.

const HEX_RE = /^#([0-9a-f]{3,8})$/i;
// A body of "anything but )" let junk like "rgb(1 2 3;background:red)" pass the
// colour gate and get persisted into a per-view style attribute, so the two CSS
// spellings are matched exactly: comma-separated channels, or space-separated
// with an optional slash alpha.
const RGB_CHANNEL = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)%?`;
const RGB_COMMA_BODY = `${RGB_CHANNEL}(?:\\s*,\\s*${RGB_CHANNEL}){2,3}`;
const RGB_SPACE_BODY = `${RGB_CHANNEL}(?:\\s+${RGB_CHANNEL}){2}(?:\\s*/\\s*${RGB_CHANNEL})?`;
const RGB_FN_RE = new RegExp(`^rgba?\\(\\s*(${RGB_COMMA_BODY}|${RGB_SPACE_BODY})\\s*\\)$`, "i");

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function channelFromToken(token: string): number {
  if (token.endsWith("%")) return clamp((parseFloat(token) / 100) * 255, 0, 255);
  return clamp(parseFloat(token), 0, 255);
}

function alphaFromToken(token: string): number {
  if (token.endsWith("%")) return clamp(parseFloat(token) / 100, 0, 1);
  return clamp(parseFloat(token), 0, 1);
}

/** Parse hex, rgb() and rgba() in both comma and slash notation. Null when unparseable. */
export function parseCssColor(value: string): Rgba | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const hex = HEX_RE.exec(trimmed);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      const parts = digits.split("").map((d) => parseInt(d + d, 16));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length === 4 ? parts[3] / 255 : 1 };
    }
    if (digits.length === 6 || digits.length === 8) {
      const parts: number[] = [];
      for (let i = 0; i < digits.length; i += 2) parts.push(parseInt(digits.slice(i, i + 2), 16));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length === 4 ? parts[3] / 255 : 1 };
    }
    return null;
  }

  const fn = RGB_FN_RE.exec(trimmed);
  if (!fn) return null;
  const tokens = fn[1].split(/[,/\s]+/).filter(Boolean);
  if (tokens.length < 3) return null;
  const r = channelFromToken(tokens[0]);
  const g = channelFromToken(tokens[1]);
  const b = channelFromToken(tokens[2]);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  const a = tokens.length > 3 ? alphaFromToken(tokens[3]) : 1;
  return { r, g, b, a: Number.isFinite(a) ? a : 1 };
}

export function toHexPair(value: number): string {
  return Math.round(clamp(value, 0, 255))
    .toString(16)
    .padStart(2, "0");
}

function formatColor(color: Rgba): string {
  if (color.a >= 1) return `#${toHexPair(color.r)}${toHexPair(color.g)}${toHexPair(color.b)}`;
  const r = Math.round(clamp(color.r, 0, 255));
  const g = Math.round(clamp(color.g, 0, 255));
  const b = Math.round(clamp(color.b, 0, 255));
  return `rgba(${r}, ${g}, ${b}, ${Math.round(clamp(color.a, 0, 1) * 1000) / 1000})`;
}

/** Same colour at a new alpha. Unparseable input is returned untouched. */
function withAlpha(value: string, alpha: number): string {
  const parsed = parseCssColor(value);
  if (!parsed) return value;
  return formatColor({ ...parsed, a: clamp(alpha, 0, 1) });
}

/** Blend two colours in sRGB; `weight` is the share taken from `value`. */
function mixColors(value: string, other: string, weight: number): string {
  const a = parseCssColor(value);
  const b = parseCssColor(other);
  if (!a || !b) return value;
  const w = clamp(weight, 0, 1);
  return formatColor({
    r: a.r * w + b.r * (1 - w),
    g: a.g * w + b.g * (1 - w),
    b: a.b * w + b.b * (1 - w),
    a: a.a * w + b.a * (1 - w),
  });
}

/** Darken (amount < 0) or lighten (amount > 0) toward black/white, keeping alpha. */
function shade(value: string, amount: number): string {
  const parsed = parseCssColor(value);
  if (!parsed) return value;
  const t = clamp(Math.abs(amount), 0, 1);
  const target = amount < 0 ? 0 : 255;
  return formatColor({
    r: parsed.r + (target - parsed.r) * t,
    g: parsed.g + (target - parsed.g) * t,
    b: parsed.b + (target - parsed.b) * t,
    a: parsed.a,
  });
}

function srgbToLinear(channel: number): number {
  const c = clamp(channel, 0, 255) / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance(value: string): number {
  const parsed = parseCssColor(value);
  if (!parsed) return 0;
  return (
    0.2126 * srgbToLinear(parsed.r) +
    0.7152 * srgbToLinear(parsed.g) +
    0.0722 * srgbToLinear(parsed.b)
  );
}

const ON_LIGHT_TEXT = "#12151a";
const ON_DARK_TEXT = "#f7f8fa";

/** Pick the readable ink for text drawn on top of `value`. */
function readableTextOn(value: string): string {
  return luminance(value) > 0.42 ? ON_LIGHT_TEXT : ON_DARK_TEXT;
}

/** Accent ramp for a user-picked hex; mirrors how the built-in accents relate. */
export function deriveAccentRamp(accent: string): {
  accent: string;
  accentDim: string;
  accentBright: string;
  accentGlow: string;
} {
  return {
    accent,
    accentDim: shade(accent, -0.28),
    accentBright: shade(accent, 0.28),
    accentGlow: withAlpha(accent, 0.15),
  };
}

/** The four ramp declarations under one custom-property prefix. */
function accentDeclarations(accent: string, prefix: string): string {
  const ramp = deriveAccentRamp(accent);
  return [
    `${prefix}: ${ramp.accent}`,
    `${prefix}-dim: ${ramp.accentDim}`,
    `${prefix}-bright: ${ramp.accentBright}`,
    `${prefix}-glow: ${ramp.accentGlow}`,
  ].join("; ");
}

/** Inline `style` payload for a per-view accent override. */
export function viewAccentStyle(accent: string | undefined): string {
  return accent ? accentDeclarations(accent, "--accent") : "";
}

/** Inline `style` payload exposing the active view's accent to the shell (sidebar). */
export function viewAccentVars(accent: string | undefined): string {
  return accent ? accentDeclarations(accent, "--view-accent") : "";
}

// Hover wash is the one non-derived default: it is a fixed white veil today and
// deriving it from the palette would visibly change every existing preset.
const SURFACE_HOVER_DEFAULT = "rgba(255, 255, 255, 0.05)";

const STATE_DIM_AMOUNT = -0.32;
const STATE_BG_ALPHA = 0.12;

/** Semantic tokens computed from the 24 base colours. */
export function deriveThemeColors(base: ThemeBaseColors): ThemeDerivedColors {
  return {
    textHeading: base.textPrimary,
    textBody: base.textPrimary,
    textLink: base.accent,
    textOnAccent: readableTextOn(base.accent),
    textPositive: base.success,
    textNegative: base.danger,

    successDim: shade(base.success, STATE_DIM_AMOUNT),
    successBg: withAlpha(base.success, STATE_BG_ALPHA),
    warningDim: shade(base.warning, STATE_DIM_AMOUNT),
    warningBg: withAlpha(base.warning, STATE_BG_ALPHA),
    dangerDim: shade(base.danger, STATE_DIM_AMOUNT),
    dangerBg: withAlpha(base.danger, STATE_BG_ALPHA),
    infoDim: shade(base.info, STATE_DIM_AMOUNT),
    infoBg: withAlpha(base.info, STATE_BG_ALPHA),

    surfacePanel: base.bgSurface,
    surfacePanelBorder: base.border,
    surfaceCard: base.bgRaised,
    surfaceHover: SURFACE_HOVER_DEFAULT,
    surfaceSelected: withAlpha(base.accent, 0.15),
    surfaceInput: base.bgRaised,
    surfaceTooltip: base.bgDeep,

    chart1: base.accent,
    chart2: base.info,
    chart3: base.success,
    chart4: base.warning,
    chart5: base.danger,
    chart6: mixColors(base.info, base.danger, 0.5),
    chartAxis: base.textMuted,

    // Game-conventional hues, not derived: players read relic eras and riven
    // pips by colour, so every preset starts from the same values.
    relicLith: "#9ca3af",
    relicMeso: "#f59e0b",
    relicNeo: "#60a5fa",
    relicAxi: "#ef4444",
    relicRequiem: "#a855f7",
    rivenPip: "#5ec8ff",
    rivenReroll: "#f06dff",
  };
}
