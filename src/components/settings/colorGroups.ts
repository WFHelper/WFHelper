import type { MessageKey } from "../../lib/i18n.js";
import type { ThemeBaseColors } from "../../types/theme.js";

interface ColorGroup {
  labelKey: MessageKey;
  keys: Array<{
    key: keyof ThemeBaseColors;
    labelKey: MessageKey;
    /** Ink drawn on bgBase, so the global grid can show it a contrast badge. */
    isText?: boolean;
  }>;
}

/** The base-colour swatch grid, shared by the global picker and the per-view panel
    so no token needs a second name in either place. */
export const COLOR_GROUPS: ColorGroup[] = [
  {
    labelKey: "appearance.colorsBackgrounds",
    keys: [
      { key: "bgDeep", labelKey: "appearance.label.bgDeep" },
      { key: "bgBase", labelKey: "appearance.label.bgBase" },
      { key: "bgSurface", labelKey: "appearance.label.bgSurface" },
      { key: "bgRaised", labelKey: "appearance.label.bgRaised" },
      { key: "bgHover", labelKey: "appearance.label.bgHover" },
    ],
  },
  {
    labelKey: "appearance.colorsAccent",
    keys: [
      { key: "accent", labelKey: "common.primary" },
      { key: "accentDim", labelKey: "common.muted" },
      { key: "accentBright", labelKey: "appearance.label.accentBright" },
    ],
  },
  {
    labelKey: "appearance.colorsText",
    keys: [
      { key: "textPrimary", labelKey: "common.primary", isText: true },
      { key: "textSecondary", labelKey: "appearance.label.textSecondary", isText: true },
      { key: "textMuted", labelKey: "common.muted", isText: true },
    ],
  },
  {
    labelKey: "appearance.colorsSemantic",
    keys: [
      { key: "success", labelKey: "appearance.label.success" },
      { key: "warning", labelKey: "appearance.label.warning" },
      { key: "danger", labelKey: "appearance.label.danger" },
      { key: "info", labelKey: "appearance.label.info" },
    ],
  },
  {
    labelKey: "appearance.colorsBorders",
    keys: [
      { key: "border", labelKey: "common.border" },
      { key: "borderStrong", labelKey: "appearance.label.borderStrong" },
    ],
  },
  {
    labelKey: "appearance.colorsGrades",
    keys: [
      { key: "gradeS", labelKey: "appearance.label.gradeS" },
      { key: "gradeA", labelKey: "appearance.label.gradeA" },
      { key: "gradeB", labelKey: "appearance.label.gradeB" },
      { key: "gradeC", labelKey: "appearance.label.gradeC" },
      { key: "gradeD", labelKey: "appearance.label.gradeD" },
      { key: "gradeF", labelKey: "appearance.label.gradeF" },
      { key: "gradeDefault", labelKey: "common.default" },
    ],
  },
];
