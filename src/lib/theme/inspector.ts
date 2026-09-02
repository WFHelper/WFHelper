import type { ThemeColors } from "../../types/theme.js";
import { THEME_COLOR_CSS_MAP } from "../../types/theme.js";
import { parseCssColor, toHexPair } from "./derive.js";

/** Computed properties the inspector reads off an element. */
export const INSPECTED_PROPERTIES = ["color", "background-color", "border-color", "fill"] as const;

export type InspectedProperty = (typeof INSPECTED_PROPERTIES)[number];

export interface TokenMatch {
  property: InspectedProperty;
  colorKey: keyof ThemeColors;
  cssVar: string;
  value: string;
}

/** Canonical `r,g,b,a` so #fff, rgb(255 255 255) and rgba(255,255,255,1) collide. */
function normalizeColorValue(value: string): string | null {
  const parsed = parseCssColor(value);
  if (!parsed) return null;
  // Fully transparent paints nothing, so it must not match a token.
  if (parsed.a <= 0) return null;
  const round = (n: number) => Math.round(Math.max(0, Math.min(255, n)));
  const alpha = Math.round(Math.max(0, Math.min(1, parsed.a)) * 1000) / 1000;
  return `${round(parsed.r)},${round(parsed.g)},${round(parsed.b)},${alpha}`;
}

/**
 * Map every currently applied token value to the token keys carrying it.
 * `resolve` returns the live value of a CSS var (`:root` or a `[data-view]` scope).
 */
export function buildTokenValueMap(
  resolve: (cssVar: string) => string,
): Map<string, Array<keyof ThemeColors>> {
  const map = new Map<string, Array<keyof ThemeColors>>();
  for (const [key, cssVar] of Object.entries(THEME_COLOR_CSS_MAP) as Array<
    [keyof ThemeColors, string]
  >) {
    const normalized = normalizeColorValue(resolve(cssVar));
    if (!normalized) continue;
    const existing = map.get(normalized);
    if (existing) {
      existing.push(key);
    } else {
      map.set(normalized, [key]);
    }
  }
  return map;
}

/** Tokens that explain an element's computed colours, in `INSPECTED_PROPERTIES` order. */
export function matchComputedColors(
  computed: Partial<Record<InspectedProperty, string>>,
  map: ReadonlyMap<string, Array<keyof ThemeColors>>,
): TokenMatch[] {
  const matches: TokenMatch[] = [];
  const seen = new Set<string>();

  for (const property of INSPECTED_PROPERTIES) {
    const raw = computed[property];
    if (!raw) continue;
    const normalized = normalizeColorValue(raw);
    if (!normalized) continue;
    const keys = map.get(normalized);
    if (!keys) continue;

    for (const colorKey of keys) {
      const id = `${property}:${colorKey}`;
      if (seen.has(id)) continue;
      seen.add(id);
      matches.push({
        property,
        colorKey,
        cssVar: THEME_COLOR_CSS_MAP[colorKey],
        value: raw.trim(),
      });
    }
  }

  return matches;
}

/** Native colour inputs only accept `#rrggbb`; approximate anything else. */
export function toHexInputValue(value: string): string {
  const parsed = parseCssColor(value);
  if (!parsed) return "#888888";
  return `#${toHexPair(parsed.r)}${toHexPair(parsed.g)}${toHexPair(parsed.b)}`;
}
