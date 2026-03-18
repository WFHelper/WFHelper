"use strict";

/**
 * Shared riven mod constants used by both rivenGrading and rivenFingerprint.
 * Values sourced from the game's riven mod formulae (via RivenParser.js).
 */

/** Buff attenuation indexed by number of buffs. Raw C float values. */
export const NUM_BUFFS_ATTEN = [0, 1, 0.66000003, 0.5, 0.40000001, 0.34999999];

/** Curse-specific attenuation indexed by number of buffs (NOT curses). */
export const NUM_BUFFS_CURSE_ATTEN = [0, 1, 0.33000001, 0.5, 1.25, 1.5];

/** SPECIFIC_FIT_ATTENUATION constant from game code. */
export const SPECIFIC_FIT_ATTEN = 1.5;

/** getBaseDrain(RIVEN_BASE_DRAIN) */
export const BASE_DRAIN = 10;

/**
 * Stats where the displayed value is NOT percentage-based.
 * Faction damage tags display as a direct multiplier, and
 * combo/range stats display with different precision.
 */
export const NON_PERCENTAGE_TAGS = new Set([
  "WeaponFactionDamageGrineer",
  "WeaponFactionDamageCorpus",
  "WeaponFactionDamageInfested",
  "WeaponMeleeFactionDamageGrineer",
  "WeaponMeleeFactionDamageCorpus",
  "WeaponMeleeFactionDamageInfested",
  "WeaponMeleeComboInitialBonusMod",
  "ComboDurationMod",
  "WeaponMeleeRangeIncMod",
]);
