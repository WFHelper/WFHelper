// Overlay IPC accepts only these theme variables. Keep them aligned with THEME_*_CSS_MAP.

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
  "--text-heading",
  "--text-body",
  "--text-link",
  "--text-on-accent",
  "--text-positive",
  "--text-negative",
  "--success-dim",
  "--success-bg",
  "--warning-dim",
  "--warning-bg",
  "--danger-dim",
  "--danger-bg",
  "--info-dim",
  "--info-bg",
  "--surface-panel",
  "--surface-panel-border",
  "--surface-card",
  "--surface-hover",
  "--surface-selected",
  "--surface-input",
  "--surface-tooltip",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
  "--chart-axis",
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
