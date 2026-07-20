/**
 * Riven mod data service (main-process only)
 *
 * Loads and indexes riven-related data from warframe-public-export-plus:
 *  - Weapon disposition (omegaAttenuation)
 *  - Riven type resolution (weapon -> riven mod)
 *  - Upgrade entries (base stat values per riven type)
 *  - Stat tag ↔ display name mapping
 *
 * All indexes are built lazily on first access.
 */

import { withScope } from "./logger";
import { levenshteinDistance } from "./rewardScannerUtils";

const log = withScope("rivenData");


interface UpgradeEntry {
  tag: string;
  canBeBuff: boolean;
  canBeCurse: boolean;
  baseValue: number;
  /** Resolved English display name (e.g. "Critical Chance") */
  displayName: string;
  /** Omega prefix syllable (e.g. "crita") - empty if stat has no name contribution */
  prefix: string;
  /** Omega suffix syllable (e.g. "cron") - empty if stat has no name contribution */
  suffix: string;
}

interface WeaponInfo {
  uniqueName: string;
  omegaAttenuation: number;
  productCategory: string;
  holsterCategory: string;
  compatibilityTags: string[];
}

interface RivenModInfo {
  uniqueName: string;
  compat: string;
  entries: UpgradeEntry[];
}


let _built = false;

/** Lowercase weapon display name -> weapon info */
const _weaponByNameLc = new Map<string, WeaponInfo>();

/** Lowercase weapon name -> display-cased name (for findWeaponInText) */
const _weaponDisplayNames = new Map<string, string>();

/** Normalized weapon name -> display-cased name */
const _weaponDisplayNamesNormalized = new Map<string, string>();

/** Weapon uniqueName -> display name (reverse lookup for fingerprint compat) */
const _weaponByUniqueName = new Map<string, string>();

/** Riven mod compat path -> riven mod info */
const _rivenModByCompat = new Map<string, RivenModInfo>();

/** Riven mod uniqueName -> riven mod info */
const _rivenModByKey = new Map<string, RivenModInfo>();

/** Upgrade tag -> cleaned display name (from locTags) */
const _tagToDisplayName = new Map<string, string>();

// Maps the stat names as they appear in OCR output (and in-game) to the
// internal upgrade tag identifiers. This table is manually maintained because
// the game's locTags include formatting placeholders and color tags.

const STAT_NAME_TO_TAG: Record<string, string> = {
  // Shared ranged stats
  "critical chance": "WeaponCritChanceMod",
  "critical damage": "WeaponCritDamageMod",
  multishot: "WeaponFireIterationsMod",
  "fire rate": "WeaponFireRateMod",
  damage: "WeaponDamageAmountMod",
  "reload speed": "WeaponReloadSpeedMod",
  "status chance": "WeaponStunChanceMod",
  "status duration": "WeaponProcTimeMod",
  "punch through": "WeaponPunctureDepthMod",
  "magazine capacity": "WeaponClipMaxMod",
  "ammo maximum": "WeaponAmmoMaxMod",
  "weapon recoil": "WeaponRecoilReductionMod",
  recoil: "WeaponRecoilReductionMod",
  zoom: "WeaponZoomFovMod",
  "projectile speed": "WeaponProjectileSpeedMod",
  // Physical damage
  impact: "WeaponImpactDamageMod",
  puncture: "WeaponArmorPiercingDamageMod",
  slash: "WeaponSlashDamageMod",
  // Elemental damage
  cold: "WeaponFreezeDamageMod",
  heat: "WeaponFireDamageMod",
  electricity: "WeaponElectricityDamageMod",
  toxin: "WeaponToxinDamageMod",
  // Faction damage (ranged)
  "damage to grineer": "WeaponFactionDamageGrineer",
  "damage to corpus": "WeaponFactionDamageCorpus",
  "damage to infested": "WeaponFactionDamageInfested",
  // Melee-specific
  "melee damage": "WeaponMeleeDamageMod",
  "attack speed": "WeaponFireRateMod",
  range: "WeaponMeleeRangeIncMod",
  "combo duration": "ComboDurationMod",
  "critical chance for slide attack": "SlideAttackCritChanceMod",
  "slide attack": "SlideAttackCritChanceMod",
  "finisher damage": "WeaponMeleeFinisherDamageMod",
  "heavy attack efficiency": "WeaponMeleeComboEfficiencyMod",
  "initial combo": "WeaponMeleeComboInitialBonusMod",
  "chance to gain combo count": "WeaponMeleeComboPointsOnHitMod",
  "additional combo count chance": "WeaponMeleeComboBonusOnHitMod",
};

// Reverse: tag -> canonical display name (used for best-attributes display)
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

// WFM uses its own attribute identifiers for the /auctions/search endpoint.
// These do NOT match a simple lowercase+underscore of the display name.
// Source: https://api.warframe.market/v1/riven/attributes

const TAG_TO_WFM_URL_NAME: Record<string, string> = {
  WeaponCritChanceMod: "critical_chance",
  WeaponCritDamageMod: "critical_damage",
  WeaponFireIterationsMod: "multishot",
  WeaponFireRateMod: "fire_rate_/_attack_speed",
  WeaponDamageAmountMod: "base_damage_/_melee_damage",
  WeaponReloadSpeedMod: "reload_speed",
  WeaponStunChanceMod: "status_chance",
  WeaponProcTimeMod: "status_duration",
  WeaponPunctureDepthMod: "punch_through",
  WeaponClipMaxMod: "magazine_capacity",
  WeaponAmmoMaxMod: "ammo_maximum",
  WeaponRecoilReductionMod: "recoil",
  WeaponZoomFovMod: "zoom",
  WeaponProjectileSpeedMod: "projectile_speed",
  WeaponImpactDamageMod: "impact_damage",
  WeaponArmorPiercingDamageMod: "puncture_damage",
  WeaponSlashDamageMod: "slash_damage",
  WeaponFreezeDamageMod: "cold_damage",
  WeaponFireDamageMod: "heat_damage",
  WeaponElectricityDamageMod: "electric_damage",
  WeaponToxinDamageMod: "toxin_damage",
  WeaponFactionDamageGrineer: "damage_vs_grineer",
  WeaponFactionDamageCorpus: "damage_vs_corpus",
  WeaponFactionDamageInfested: "damage_vs_infested",
  WeaponMeleeDamageMod: "base_damage_/_melee_damage",
  WeaponMeleeRangeIncMod: "range",
  ComboDurationMod: "combo_duration",
  SlideAttackCritChanceMod: "critical_chance_on_slide_attack",
  WeaponMeleeFinisherDamageMod: "finisher_damage",
  WeaponMeleeComboEfficiencyMod: "channeling_efficiency",
  WeaponMeleeComboInitialBonusMod: "channeling_damage",
  WeaponMeleeComboPointsOnHitMod: "chance_to_gain_combo_count",
  WeaponMeleeComboBonusOnHitMod: "chance_to_gain_extra_combo_count",
  WeaponMeleeFactionDamageGrineer: "damage_vs_grineer",
  WeaponMeleeFactionDamageCorpus: "damage_vs_corpus",
  WeaponMeleeFactionDamageInfested: "damage_vs_infested",
};


const RIVEN_MODS_BY_CATEGORY: Record<string, string> = {
  LongGuns: "/Lotus/Upgrades/Mods/Randomized/LotusRifleRandomModRare",
  Pistols: "/Lotus/Upgrades/Mods/Randomized/LotusPistolRandomModRare",
  Melee: "/Lotus/Upgrades/Mods/Randomized/PlayerMeleeWeaponRandomModRare",
  SpaceGuns: "/Lotus/Upgrades/Mods/Randomized/LotusArchgunRandomModRare",
};

// Shotgun override: LongGuns with SHOTGUN compat tag -> shotgun riven
const SHOTGUN_RIVEN_KEY = "/Lotus/Upgrades/Mods/Randomized/LotusShotgunRandomModRare";

// Modular weapon overrides
const KITGUN_RIVEN_KEY = "/Lotus/Upgrades/Mods/Randomized/LotusModularPistolRandomModRare";
const ZAW_RIVEN_KEY = "/Lotus/Upgrades/Mods/Randomized/LotusModularMeleeRandomModRare";


function stripColorTags(text: string): string {
  // Remove <DT_*_COLOR> tags from localized strings
  return text.replace(/<[^>]+>/g, "").trim();
}

function normalizeWeaponOcrText(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const WEAPON_OCR_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  euphona: "Euphona Prime",
  gotva: "Gotva Prime",
  reaper: "Reaper Prime",
});

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
    /* eslint-disable @typescript-eslint/no-explicit-any -- untyped warframe-public-export-plus */
    const pep = require("warframe-public-export-plus") as Record<string, any>;
    const dict: Record<string, string> = pep.dict_en || {};
    const weapons: Record<string, Record<string, any>> = pep.ExportWeapons || {};
    const upgrades: Record<string, Record<string, any>> = pep.ExportUpgrades || {};
    /* eslint-enable @typescript-eslint/no-explicit-any */

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
        holsterCategory: w.holsterCategory || "",
        compatibilityTags: Array.isArray(w.compatibilityTags) ? w.compatibilityTags : [],
      });
      _weaponDisplayNames.set(name.toLowerCase(), name);
      _weaponDisplayNamesNormalized.set(normalizeWeaponOcrText(name), name);
      _weaponByUniqueName.set(uniqueName, name);
      weaponCount++;
    }

    for (const [key, mod] of Object.entries(upgrades)) {
      if (
        !mod.upgradeEntries ||
        !Array.isArray(mod.upgradeEntries) ||
        mod.upgradeEntries.length === 0
      )
        continue;
      if (!key.includes("Randomized")) continue; // skip non-riven mods with upgradeEntries

      const entries: UpgradeEntry[] = [];
      for (const ue of mod.upgradeEntries) {
        const baseValue = ue.upgradeValues?.[0]?.value ?? 0;
        const locTag = ue.upgradeValues?.[0]?.locTag;
        let displayName = locTag ? dict[locTag] || "" : "";
        displayName = cleanLocTag(displayName);
        if (!displayName) displayName = TAG_TO_DISPLAY[ue.tag] || ue.tag;

        entries.push({
          tag: ue.tag,
          canBeBuff: !!ue.canBeBuff,
          canBeCurse: !!ue.canBeCurse,
          baseValue,
          displayName,
          prefix: (ue.prefixTag && dict[ue.prefixTag]) || "",
          suffix: (ue.suffixTag && dict[ue.suffixTag]) || "",
        });

        // Populate tag -> display name from resolved locTags
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

    log.info(`[RivenData] Indexed ${weaponCount} weapons, ${_rivenModByKey.size} riven mod types`);
  } catch (err) {
    log.error("[RivenData] Failed to build indexes:", err);
  }
}


/**
 * Reverse-lookup weapon display name from uniqueName (e.g. /Lotus/Weapons/...).
 * Used to resolve riven fingerprint compat field.
 */
export function getWeaponNameByUniqueName(uniqueName: string): string | null {
  ensureBuilt();
  return _weaponByUniqueName.get(uniqueName) || null;
}

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

  // Check for shotgun. Current export data marks shotguns via holsterCategory
  // only (compatibilityTags carry trigger tags now, and six shotguns have no
  // tags at all); keep the old tag check for older data.
  if (
    cat === "LongGuns" &&
    (info.holsterCategory === "SHOTGUN" || info.compatibilityTags.includes("SHOTGUN"))
  ) {
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
function getRivenTypeEntries(rivenTypeKey: string): UpgradeEntry[] {
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

/** Convert a game upgrade tag to the WFM riven auction attribute url_name. */
export function tagToWfmUrlName(tag: string): string | null {
  return TAG_TO_WFM_URL_NAME[tag] || null;
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
    // Try matching without the "Melee" prefix - e.g. "WeaponMeleeFactionDamageCorpus"
    // when we looked up "WeaponFactionDamageCorpus"
    const meleeFallback = tag.replace("WeaponFaction", "WeaponMeleeFaction");
    found = entries.find((e) => e.tag === meleeFallback);
  }
  if (!found) {
    // Try matching without the "Melee" prefix - e.g. "WeaponDamageAmountMod"
    // when melee uses "WeaponMeleeDamageMod"
    if (tag === "WeaponDamageAmountMod") {
      found = entries.find((e) => e.tag === "WeaponMeleeDamageMod");
    }
  }
  return found || null;
}

/**
 * Generate the riven suffix name from buffs with their fingerprint Values.
 *
 * Mirrors RivenParser.js (calamity-inc/warframe-riven-info, the same source
 * as the fingerprint float decode):
 *  - Curses do NOT affect the name.
 *  - Buffs sort by fingerprint Value DESCENDING (tie: lower baseValue first).
 *  - First buff: TitleCase(prefix). Middle buff (3-buff rolls): "-" + prefix.
 *    Last buff: suffix, no separator.
 *
 * Examples: "Satidra" (multishot > fire rate), "Critacan" (crit chance >
 * multishot), "Visi-satican" (3 buffs).
 */
export function generateRivenSuffix(
  rivenTypeKey: string,
  buffs: Array<{ tag: string; value: number }>,
): string {
  const entries = getRivenTypeEntries(rivenTypeKey);
  if (entries.length === 0 || buffs.length === 0) return "";

  const findEntry = (tag: string) => {
    let e = entries.find((x) => x.tag === tag);
    if (!e) {
      const meleeFallback = tag.replace("WeaponFaction", "WeaponMeleeFaction");
      e = entries.find((x) => x.tag === meleeFallback);
    }
    if (!e && tag === "WeaponDamageAmountMod") {
      e = entries.find((x) => x.tag === "WeaponMeleeDamageMod");
    }
    return e;
  };

  const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  const sorted = [...buffs].sort((a, b) => {
    if (a.value === b.value) {
      return (findEntry(a.tag)?.baseValue ?? 0) - (findEntry(b.tag)?.baseValue ?? 0);
    }
    return b.value - a.value;
  });

  if (sorted.length === 1) {
    const entry = findEntry(sorted[0].tag);
    if (!entry?.prefix) return "";
    return titleCase(entry.prefix) + (entry.suffix || "").toLowerCase();
  }

  let name = "";
  for (let i = 0; i < sorted.length; i++) {
    const entry = findEntry(sorted[i].tag);
    if (!entry) continue;
    if (i === sorted.length - 1) {
      name += (entry.suffix || "").toLowerCase();
    } else if (name === "") {
      if (entry.prefix) name += titleCase(entry.prefix);
    } else {
      if (entry.prefix) name += "-" + entry.prefix.toLowerCase();
    }
  }
  return name;
}

/**
 * Try to find a known weapon name inside OCR text (case-insensitive).
 * Used to extract the weapon from riven card text before the cycle dialog
 * reveals it.  Prefers the longest match to avoid e.g. "Bo" matching inside
 * "Boar".  Returns the canonical (properly cased) weapon name or null.
 */
export function findWeaponInText(text: string): string | null {
  ensureBuilt();
  const lc = text.toLowerCase();
  let bestExact: string | null = null;
  let bestExactLen = 0;
  for (const [nameLc] of _weaponByNameLc) {
    if (nameLc.length <= bestExactLen) continue;
    if (nameLc.length < 3) continue; // skip very short names to avoid false positives
    if (lc.includes(nameLc)) {
      // Keys are lowercased; recover the display-cased name from the parallel map.
      bestExact = _weaponDisplayNames.get(nameLc) || nameLc;
      bestExactLen = nameLc.length;
    }
  }

  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => normalizeWeaponOcrText(line))
    .filter((line) => line.length >= 4)
    .slice(0, 4);

  for (const line of lines) {
    const alias = WEAPON_OCR_ALIASES[line];
    if (alias) return alias;
  }

  let bestCandidate: { name: string; distance: number; tokenCount: number } | null = null;

  for (const line of lines) {
    const words = line.split(" ").filter((word) => word.length >= 2);
    if (words.length === 0) continue;

    for (let start = 0; start < words.length; start += 1) {
      for (let len = 1; len <= 4 && start + len <= words.length; len += 1) {
        const phrase = words
          .slice(start, start + len)
          .join(" ")
          .trim();
        if (phrase.length < 4) continue;

        const directAlias = WEAPON_OCR_ALIASES[phrase];
        if (directAlias) return directAlias;

        for (const [normalizedWeapon, displayName] of _weaponDisplayNamesNormalized) {
          if (!normalizedWeapon) continue;

          const phraseWords = phrase.split(" ");
          const weaponWords = normalizedWeapon.split(" ");
          if (Math.abs(phraseWords.length - weaponWords.length) > 1) continue;

          const maxDistance =
            normalizedWeapon.length >= 14 ? 3 : normalizedWeapon.length >= 8 ? 2 : 1;
          const distance = levenshteinDistance(phrase, normalizedWeapon);
          if (distance > maxDistance) continue;

          if (
            !bestCandidate ||
            distance < bestCandidate.distance ||
            (distance === bestCandidate.distance &&
              weaponWords.length > bestCandidate.tokenCount) ||
            (distance <= bestCandidate.distance + 1 &&
              weaponWords.length > bestCandidate.tokenCount)
          ) {
            bestCandidate = {
              name: displayName,
              distance,
              tokenCount: weaponWords.length,
            };
          }
        }
      }
    }
  }

  if (bestCandidate?.name) {
    if (!bestExact) return bestCandidate.name;
    const bestCandidateWords = normalizeWeaponOcrText(bestCandidate.name).split(" ").length;
    const bestExactWords = normalizeWeaponOcrText(bestExact).split(" ").length;
    if (bestCandidateWords > bestExactWords) return bestCandidate.name;
  }

  return bestExact ?? bestCandidate?.name ?? null;
}

/** Variant suffixes to strip when deriving the riven weapon family name. */
const VARIANT_SUFFIXES = [" Prime", " Wraith", " Vandal", " Prisma", " Dex"];
const VARIANT_PREFIXES = ["MK1-", "Mk1-", "Kuva ", "Tenet "];

/**
 * Derive the base weapon family slug for WFM riven auction search.
 * Rivens apply to the weapon family, not a specific variant.
 * E.g. "Boar Prime" -> "boar", "Kuva Bramma" -> "bramma"
 */
export function getRivenFamilySlug(weaponName: string): string {
  let name = weaponName.trim();
  for (const suffix of VARIANT_SUFFIXES) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  for (const prefix of VARIANT_PREFIXES) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * All variants sharing a weapon's riven family (e.g. Boar -> Boar, Boar Prime),
 * with their dispositions. Includes the weapon itself.
 */
export function getFamilyVariants(
  weaponName: string,
): Array<{ name: string; disposition: number }> {
  ensureBuilt();
  const slug = getRivenFamilySlug(weaponName);
  if (!slug) return [];
  const out: Array<{ name: string; disposition: number }> = [];
  for (const name of _weaponDisplayNames.values()) {
    if (getRivenFamilySlug(name) !== slug) continue;
    const info = _weaponByNameLc.get(name.toLowerCase());
    if (info) out.push({ name, disposition: info.omegaAttenuation });
  }
  return out;
}

/**
 * Get all weapon display names that have riven disposition.
 * Returns an alphabetically sorted array.
 */
export function getAllRivenWeaponNames(): string[] {
  ensureBuilt();
  const names = [..._weaponDisplayNames.values()];
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

/**
 * Get the common riven stat tags used for WFM auction attribute filters.
 * Returns array of { tag, wfmUrlName, displayName }.
 */
export function getRivenStatOptions(): { tag: string; wfmUrlName: string; displayName: string }[] {
  ensureBuilt();
  const result: { tag: string; wfmUrlName: string; displayName: string }[] = [];
  const seen = new Set<string>();
  for (const [tag, wfmName] of Object.entries(TAG_TO_WFM_URL_NAME)) {
    if (seen.has(wfmName)) continue;
    seen.add(wfmName);
    const displayName = _tagToDisplayName.get(tag) || TAG_TO_DISPLAY[tag] || tag;
    result.push({ tag, wfmUrlName: wfmName, displayName });
  }
  result.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return result;
}

