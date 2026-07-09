/**
 * CSS vars forwarded renderer -> overlay windows for theming. src/main.ts builds
 * the payload, ipc/overlayIpc.ts sanitizes against this list. New themed vars go
 * here plus THEME_*_CSS_MAP in src/types/theme.ts.
 */

/** Color tokens (mirror of THEME_COLOR_CSS_MAP values + derived --accent-glow). */
export const OVERLAY_FORWARDED_COLOR_VARS = [
  "--bg-deep",
  "--bg-base",
  "--bg-surface",
  "--bg-raised",
  "--bg-hover",
  "--accent",
  "--accent-dim",
  "--accent-bright",
  "--accent-glow",
  "--text-primary",
  "--text-secondary",
  "--text-muted",
  "--success",
  "--warning",
  "--danger",
  "--info",
  "--border",
  "--border-strong",
] as const;

/** Font tokens (resolved at runtime from :root, not in any map). */
export const OVERLAY_FORWARDED_FONT_VARS = [
  "--font-display",
  "--font-body",
  "--font-heading-size",
  "--font-body-size",
  "--font-small-size",
] as const;

/** Effect tokens (mirror of THEME_EFFECT_CSS_MAP values). */
export const OVERLAY_FORWARDED_EFFECT_VARS = [
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-xl",
  "--ui-panel-bg",
  "--ui-panel-border",
  "--ui-panel-shadow",
  "--ui-control-bg",
  "--ui-control-border",
  "--ui-backdrop-blur",
] as const;

/** Union of every CSS var forwarded to overlay windows. */
export const OVERLAY_FORWARDED_CSS_VARS: readonly string[] = [
  ...OVERLAY_FORWARDED_COLOR_VARS,
  ...OVERLAY_FORWARDED_FONT_VARS,
  ...OVERLAY_FORWARDED_EFFECT_VARS,
];
