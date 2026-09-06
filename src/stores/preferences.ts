import { VALUE_MIN_PLATINUM_PRESETS } from "../lib/inventory/valueTotals.js";
import { persistedBoolean, persistedPresetNumber } from "../lib/persistence.js";

export const hideFounderMasteryItems = persistedBoolean("wf_hide_founder_mastery_items", false);
export const hideFoundryClaims = persistedBoolean("wf_hide_foundry_claims", true);
export const autoFocusSearch = persistedBoolean("wf_auto_focus_search", false);
/** Widens the inventory value totals from prime parts to every tradable row. */
export const inventoryValueAllTradables = persistedBoolean(
  "wf_inventory_value_all_tradables",
  false,
);
/** Drops rows below this per-unit median out of the inventory value totals. */
export const inventoryValueMinPlatinum = persistedPresetNumber(
  "wf_inventory_value_min_plat",
  VALUE_MIN_PLATINUM_PRESETS,
  0,
);
/** Reserve an extra copy of gear another recipe consumes, so a player who wants
 *  both Bronco Prime and Akbronco Prime keeps parts for the spare build. */
export const keepWeaponVariants = persistedBoolean("wf_keep_weapon_variants", false);
