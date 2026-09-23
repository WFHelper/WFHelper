import { persistedString } from "../../lib/persistence.js";
import type { MessageKey } from "../../lib/i18n.js";

export const APPEARANCE_TABS = ["theme", "colors", "overlays", "sidebar", "css"] as const;
type AppearanceTab = (typeof APPEARANCE_TABS)[number];

export const APPEARANCE_TAB_LABEL_KEYS: Record<AppearanceTab, MessageKey> = {
  theme: "settings.appearanceTabTheme",
  colors: "appearance.colors",
  overlays: "common.overlays",
  sidebar: "settings.appearanceTabSidebar",
  css: "customCss.title",
};

export const appearanceTab = persistedString<AppearanceTab>(
  "wf_settings_appearance_tab",
  APPEARANCE_TABS,
  "theme",
);
