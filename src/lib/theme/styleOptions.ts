import type { MessageKey } from "../i18n.js";
import type { ThemeCornerStyle, ThemeSurfaceStyle } from "../../types/theme.js";

export const THEME_CORNER_OPTIONS: ReadonlyArray<{
  value: ThemeCornerStyle;
  labelKey: MessageKey;
}> = [
  { value: "sharp", labelKey: "appearance.cornerSharp" },
  { value: "soft", labelKey: "appearance.cornerSoft" },
  { value: "round", labelKey: "appearance.cornerRound" },
];

export const THEME_SURFACE_OPTIONS: ReadonlyArray<{
  value: ThemeSurfaceStyle;
  labelKey: MessageKey;
}> = [
  { value: "full", labelKey: "appearance.surfaceFull" },
  { value: "border", labelKey: "common.border" },
  { value: "minimal", labelKey: "appearance.surfaceMinimal" },
];
