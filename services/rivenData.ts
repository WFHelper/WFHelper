"use strict";

/**
 * rivenData.ts — Riven mod data service (main-process only)
 *
 * Loads and indexes riven-related data from warframe-public-export-plus:
 *  - Weapon disposition (omegaAttenuation)
 *  - Riven type resolution (weapon → riven mod)
 *  - Upgrade entries (base stat values per riven type)
 *  - Stat tag ↔ display name mapping
 *
 * All indexes are built lazily on first access.
 */

import { withScope } from "./logger";

const log = withScope("rivenData");

// ── Types ────────────────────────────────────────────────────────────────────

export interface UpgradeEntry {
  tag: string;
  canBeBuff: boolean;
  canBeCurse: boolean;
  baseValue: number;
  /** Resolved English display name (e.g. "Critical Chance") */
  displayName: string;
}

interface WeaponInfo {
  uniqueName: string;
  omegaAttenuation: number;
  productCategory: string;
  compatibilityTags: string[];
}

interface RivenModInfo {
  uniqueName: string;
  compat: string;
  entries: UpgradeEntry[];
}

// ── State ────────────────────────────────────────────────────────────────────

let _built = false;

/** Lowercase weapon display name → weapon info */
const _weaponByNameLc = new Map<string, WeaponInfo>();

/** Riven mod compat path → riven mod info */
const _rivenModByCompat = new Map<string, RivenModInfo>();

/** Riven mod uniqueName → riven mod info */
const _rivenModByKey = new Map<string, RivenModInfo>();

/** Upgrade tag → cleaned display name (from locTags) */
const _tagToDisplayName = new Map<string, string>();

// ── OCR stat name → upgrade tag mapping ──────────────────────────────────────
// Maps the stat names as they appear in OCR output (and in-game) to the
// internal upgrade tag identifiers. This table is manually maintained because
// the game's locTags include formatting placeholders and color tags.

const STAT_NAME_TO_TAG: Record<string, string> = {
  // Shared ranged stats
  "critical chance": "WeaponCritChanceMod",
  "critical damage": "WeaponCritDamageMod",
  "multishot": "WeaponFireIterationsMod",
  "fire rate": "WeaponFireRateMod",
  "damage": "WeaponDamageAmountMod",
  "reload speed": "WeaponReloadSpeedMod",
  "status chance": "WeaponStunChanceMod",
  "status duration": "WeaponProcTimeMod",
  "punch through": "WeaponPunctureDepthMod",
  "magazine capacity": "WeaponClipMaxMod",
  "ammo maximum": "WeaponAmmoMaxMod",
  "weapon recoil": "WeaponRecoilReductionMod",
  "recoil": "WeaponRecoilReductionMod",
  "zoom": "WeaponZoomFovMod",
  "projectile speed": "WeaponProjectileSpeedMod",
  // Physical damage
  "impact": "WeaponImpactDamageMod",
  "puncture": "WeaponArmorPiercingDamageMod",
  "slash": "WeaponSlashDamageMod",
  // Elemental damage
  "cold": "WeaponFreezeDamageMod",
  "heat": "WeaponFireDamageMod",
  "electricity": "WeaponElectricityDamageMod",
  "toxin": "WeaponToxinDamageMod",
  // Faction damage (ranged)
  "damage to grineer": "WeaponFactionDamageGrineer",
  "damage to corpus": "WeaponFactionDamageCorpus",
  "damage to infested": "WeaponFactionDamageInfested",
  // Melee-specific
  "melee damage": "WeaponMeleeDamageMod",
  "attack speed": "WeaponFireRateMod",
  "range": "WeaponMeleeRangeIncMod",
  "combo duration": "ComboDurationMod",
  "critical chance for slide attack": "SlideAttackCritChanceMod",
  "slide attack": "SlideAttackCritChanceMod",
  "finisher damage": "WeaponMeleeFinisherDamageMod",
  "heavy attack efficiency": "WeaponMeleeComboEfficiencyMod",
  "initial combo": "WeaponMeleeComboInitialBonusMod",
  "chance to gain combo count": "WeaponMeleeComboPointsOnHitMod",
  "additional combo count chance": "WeaponMeleeComboBonusOnHitMod",
};

// Reverse: tag → canonical display name (used for best-attributes display)
const TAG_TO_DISPLAY: Record<string, string> = {};
for (const [name, tag] of Object.entries(STAT_NAME_TO_TAG)) {
  // Keep first (canonical) mapping per tag
  if (!TAG_TO_DISPLAY[tag]) {
    // Title-case the display name
    TAG_TO_DISPLAY[tag] = name
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
}

// ── Weapon category → riven mod uniqueName mapping ───────────────────────────

const RIVEN_MODS_BY_CATEGORY: Record<string, string> = {
  LongGuns: "/Lotus/Upgrades/Mods/Randomized/LotusRifleRandomModRare",
  Pistols: "/Lotus/Upgrades/Mods/Randomized/LotusPistolRandomModRare",
  Melee: "/Lotus/Upgrades/Mods/Randomized/PlayerMeleeWeaponRandomModRare",
  SpaceGuns: "/Lotus/Upgrades/Mods/Randomized/LotusArchgunRandomModRare",
};

// Shotgun override: LongGuns with SHOTGUN compat tag → shotgun riven
const SHOTGUN_RIVEN_KEY = "/Lotus/Upgrades/Mods/Randomized/LotusShotgunRandomModRare";

// Modular weapon overrides
const KITGUN_RIVEN_KEY = "/Lotus/Upgrades/Mods/Randomized/LotusModularPistolRandomModRare";
const ZAW_RIVEN_KEY = "/Lotus/Upgrades/Mods/Randomized/LotusModularMeleeRandomModRare";

// ── Build logic ──────────────────────────────────────────────────────────────

function stripColorTags(text: string): string {
  // Remove <DT_*_COLOR> tags from localized strings
  return text.replace(/<[^>]+>/g, "").trim();
}

function cleanLocTag(raw: string): string {
  // locTags look like: "|val|% <DT_FIRE_COLOR>Heat" or "|val|% Critical Chance"
  // Strip the |val|%, |STAT1|%, |val|s prefixes and color tags
  let cleaned = raw.replace(/\|[^|]*\|[%s]?\s*/g, "").trim();
  cleaned = stripColorTags(cleaned);
  // Remove parenthetical qualifiers: "(x2 for Bows)", "(x2 for Heavy Attacks)"
  cleaned = cleaned.replace(/\s*\(.*?\)\s*/g, "").trim();
  return cleaned;
}

function ensureBuilt(): void {
  if (_built) return;
  _built = true;

  try {
    const pep = require("warframe-public-export-plus") as any;
    const dict: Record<string, string> = pep.dict_en || {};
    const weapons: Record<string, any> = pep.ExportWeapons || {};
    const upgrades: Record<string, any> = pep.ExportUpgrades || {};

    // ── Index weapons ──────────────────────────────────────────────────────
    let weaponCount = 0;
    for (const [uniqueName, w] of Object.entries(weapons)) {
      if (!uniqueName || uniqueName === "default") continue;
      let name = w.name;
      if (typeof name === "string" && name.startsWith("/")) {
        name = dict[name] || null;
      }
      if (!name || typeof name !== "string") continue;
      if (typeof w.omegaAttenuation !== "number") continue;

      _weaponByNameLc.set(name.toLowerCase(), {
        uniqueName,
        omegaAttenuation: w.omegaAttenuation,
        productCategory: w.productCategory || "",
        compatibilityTags: Array.isArray(w.compatibilityTags) ? w.compatibilityTags : [],
      });
      weaponCount++;
    }

    // ── Index riven mods ───────────────────────────────────────────────────
    for (const [key, mod] of Object.entries(upgrades)) {
      if (!mod.upgradeEntries || !Array.isArray(mod.upgradeEntries) || mod.upgradeEntries.length === 0) continue;
      if (!key.includes("Randomized")) continue; // skip non-riven mods with upgradeEntries

      const entries: UpgradeEntry[] = [];
      for (const ue of mod.upgradeEntries) {
        const baseValue = ue.upgradeValues?.[0]?.value ?? 0;
        const locTag = ue.upgradeValues?.[0]?.locTag;
        let displayName = locTag ? (dict[locTag] || "") : "";
        displayName = cleanLocTag(displayName);
        if (!displayName) displayName = TAG_TO_DISPLAY[ue.tag] || ue.tag;

        entries.push({
          tag: ue.tag,
          canBeBuff: !!ue.canBeBuff,
          canBeCurse: !!ue.canBeCurse,
          baseValue,
          displayName,
        });

        // Populate tag → display name from resolved locTags
        if (displayName && !_tagToDisplayName.has(ue.tag)) {
          _tagToDisplayName.set(ue.tag, displayName);
        }
      }

      const info: RivenModInfo = {
        uniqueName: key,
        compat: mod.compat || "",
        entries,
      };
      _rivenModByKey.set(key, info);
      if (mod.compat) {
        _rivenModByCompat.set(mod.compat, info);
      }
    }

    log.log(`[RivenData] Indexed ${weaponCount} weapons, ${_rivenModByKey.size} riven mod types`);
  } catch (err) {
    log.error("[RivenData] Failed to build indexes:", err);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up weapon disposition (omegaAttenuation) by display name.
 * Returns null if weapon not found.
 */
export function getWeaponDisposition(weaponName: string): number | null {
  ensureBuilt();
  const info = _weaponByNameLc.get(weaponName.toLowerCase());
  return info ? info.omegaAttenuation : null;
}

/**
 * Look up weapon product category by display name.
 */
export function getWeaponCategory(weaponName: string): string | null {
  ensureBuilt();
  const info = _weaponByNameLc.get(weaponName.toLowerCase());
  return info ? info.productCategory : null;
}

/**
 * Resolve which riven mod type applies to a weapon.
 * Returns the riven mod uniqueName or null.
 */
export function resolveRivenType(weaponName: string): string | null {
  ensureBuilt();
  const info = _weaponByNameLc.get(weaponName.toLowerCase());
  if (!info) return null;

  const cat = info.productCategory;

  // Check for shotgun (LongGuns with SHOTGUN compat tag)
  if (cat === "LongGuns" && info.compatibilityTags.includes("SHOTGUN")) {
    return SHOTGUN_RIVEN_KEY;
  }

  // Check for modular weapons (Zaw / Kitgun)
  if (cat === "Melee" && info.uniqueName.includes("PlayerMeleeWeapon")) {
    return ZAW_RIVEN_KEY;
  }
  if (cat === "Pistols" && info.uniqueName.includes("LotusPistol")) {
    return KITGUN_RIVEN_KEY;
  }

  return RIVEN_MODS_BY_CATEGORY[cat] || null;
}

/**
 * Get the upgrade entries for a riven mod type.
 */
export function getRivenTypeEntries(rivenTypeKey: string): UpgradeEntry[] {
  ensureBuilt();
  return _rivenModByKey.get(rivenTypeKey)?.entries || [];
}

/**
 * Map an OCR stat display name to the internal upgrade tag.
 * Returns null if no match found.
 */
export function statNameToTag(statName: string): string | null {
  const lc = statName.toLowerCase().trim();
  return STAT_NAME_TO_TAG[lc] || null;
}

/**
 * Get the canonical display name for an upgrade tag.
 */
export function getStatDisplayName(tag: string): string {
  ensureBuilt();
  return _tagToDisplayName.get(tag) || TAG_TO_DISPLAY[tag] || tag;
}

/**
 * Find the UpgradeEntry for a stat within a specific riven type.
 * Matches by tag.
 */
export function findUpgradeEntry(rivenTypeKey: string, tag: string): UpgradeEntry | null {
  const entries = getRivenTypeEntries(rivenTypeKey);
  // Some melee stats have different faction damage tags
  // (WeaponMeleeFactionDamageCorpus vs WeaponFactionDamageCorpus)
  // Try exact match first, then fall back to suffix match
  let found = entries.find((e) => e.tag === tag);
  if (!found) {
    // Try matching without the "Melee" prefix — e.g. "WeaponMeleeFactionDamageCorpus"
    // when we looked up "WeaponFactionDamageCorpus"
    const meleeFallback = tag.replace("WeaponFaction", "WeaponMeleeFaction");
    found = entries.find((e) => e.tag === meleeFallback);
  }
  if (!found) {
    // Try matching without the "Melee" prefix — e.g. "WeaponDamageAmountMod"
    // when melee uses "WeaponMeleeDamageMod"
    if (tag === "WeaponDamageAmountMod") {
      found = entries.find((e) => e.tag === "WeaponMeleeDamageMod");
    }
  }
  return found || null;
}

/**
 * Get weapon URL slug for warframe.market API.
 * E.g. "Rubico Prime" → "rubico_prime"
 */
export function getWeaponWfmSlug(weaponName: string): string {
  return weaponName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}
