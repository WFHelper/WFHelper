/**
 * WCAG 2.1 contrast-ratio utilities.
 * All colour inputs are CSS hex strings (#rgb or #rrggbb) or rgb()/rgba() strings.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse a CSS colour string into {r, g, b} in 0-255 range. */
function parseColor(color: string): Rgb | null {
  const trimmed = color.trim();

  // #rgb or #rrggbb
  const hexMatch = /^#([0-9a-f]{3,8})$/i.exec(trimmed);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      };
    }
    if (hex.length >= 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
  }

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(trimmed);
  if (rgbMatch) {
    return {
      r: Math.min(255, parseInt(rgbMatch[1], 10)),
      g: Math.min(255, parseInt(rgbMatch[2], 10)),
      b: Math.min(255, parseInt(rgbMatch[3], 10)),
    };
  }

  return null;
}

/** Convert an sRGB channel (0-255) to linear RGB. */
function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Compute WCAG relative luminance from an Rgb value. */
function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * srgbToLinear(rgb.r) + 0.7152 * srgbToLinear(rgb.g) + 0.0722 * srgbToLinear(rgb.b);
}

/**
 * Compute WCAG contrast ratio between two colours.
 * Returns a value >= 1 (higher = more contrast).
 */
export function contrastRatio(color1: string, color2: string): number {
  const rgb1 = parseColor(color1);
  const rgb2 = parseColor(color2);
  if (!rgb1 || !rgb2) return 1;

  const l1 = relativeLuminance(rgb1);
  const l2 = relativeLuminance(rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);

  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA minimum for normal text (>= 4.5:1). */
export const WCAG_AA_NORMAL = 4.5;

/**
 * Auto-adjust a foreground colour to meet a minimum contrast ratio against
 * the given background. Lightens or darkens the text colour.
 * Returns the adjusted hex colour string.
 */
export function autoAdjustTextColor(
  fgHex: string,
  bgHex: string,
  minRatio: number = WCAG_AA_NORMAL,
): string {
  const fg = parseColor(fgHex);
  const bg = parseColor(bgHex);
  if (!fg || !bg) return fgHex;

  const bgLum = relativeLuminance(bg);

  // Determine if we should lighten or darken
  const shouldLighten = bgLum < 0.5;

  let r = fg.r;
  let g = fg.g;
  let b = fg.b;

  for (let i = 0; i < 80; i++) {
    const currentLum = relativeLuminance({ r, g, b });
    const lighter = Math.max(currentLum, bgLum);
    const darker = Math.min(currentLum, bgLum);
    const ratio = (lighter + 0.05) / (darker + 0.05);

    if (ratio >= minRatio) break;

    if (shouldLighten) {
      r = Math.min(255, r + 3);
      g = Math.min(255, g + 3);
      b = Math.min(255, b + 3);
    } else {
      r = Math.max(0, r - 3);
      g = Math.max(0, g - 3);
      b = Math.max(0, b - 3);
    }
  }

  return rgbToHex(r, g, b);
}

/** Convert RGB components (0-255) to a hex string. */
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
