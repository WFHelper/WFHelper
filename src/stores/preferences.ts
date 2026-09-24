import { writable } from "svelte/store";

import { VALUE_MIN_PLATINUM_PRESETS } from "../lib/inventory/valueTotals.js";
import {
  persistedBoolean,
  persistedPresetNumber,
  persistedString,
  readStorage,
  writeStorage,
} from "../lib/persistence.js";

export const hideFounderMasteryItems = persistedBoolean("wf_hide_founder_mastery_items", false);
export const hideFoundryClaims = persistedBoolean("wf_hide_foundry_claims", true);
export const autoFocusSearch = persistedBoolean("wf_auto_focus_search", false);
export const showMasteredBadges = persistedBoolean("wf_show_mastered_badges", true);
export const showOwnedParentBadges = persistedBoolean("wf_show_owned_parent_badges", true);
// The parent-owned toggle used to hide F as well, so it seeds the F toggle once.
if (readStorage("wf_show_foundry_ready_badges") == null) {
  writeStorage(
    "wf_show_foundry_ready_badges",
    readStorage("wf_show_owned_parent_badges") === "0" ? "0" : "1",
  );
}
export const showFoundryReadyBadges = persistedBoolean("wf_show_foundry_ready_badges", true);
export const showVaultedBadges = persistedBoolean("wf_show_vaulted_badges", true);
export const inventoryValueAllTradables = persistedBoolean(
  "wf_inventory_value_all_tradables",
  false,
);
export const inventoryValueMinPlatinum = persistedPresetNumber(
  "wf_inventory_value_min_plat",
  VALUE_MIN_PLATINUM_PRESETS,
  0,
);

export const SETTINGS_CATEGORIES = [
  "general",
  "notifications",
  "inventory",
  "overlay",
  "appearance",
  "about",
] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];
export const SETTINGS_CATEGORY_STORAGE_KEY = "wf_settings_category";
// Advanced was its own category before it moved into General; a saved one still opens there.
const savedAdvancedCategory = readStorage(SETTINGS_CATEGORY_STORAGE_KEY) === "advanced";
if (savedAdvancedCategory) writeStorage(SETTINGS_CATEGORY_STORAGE_KEY, "general");
export const settingsCategory = persistedString<SettingsCategory>(
  SETTINGS_CATEGORY_STORAGE_KEY,
  SETTINGS_CATEGORIES,
  "general",
);
export type SettingsSectionTarget = "advanced" | "missions";
export const settingsSectionTarget = writable<SettingsSectionTarget | null>(
  savedAdvancedCategory ? "advanced" : null,
);
