/**
 * rivenBestAttributes.ts — Desired riven attributes per weapon category
 *
 * Community-sourced "best" positive and negative stats for each weapon type.
 * These are the universally agreed-upon top stats. Individual weapon
 * preferences may vary, but these cover the vast majority of cases.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface BestAttributes {
  /** Desired positive stats in order of desirability */
  positives: string[];
  /** Desired negative stats ("harmless curses") in order of desirability */
  negatives: string[];
}

// ── Data ─────────────────────────────────────────────────────────────────────

const RIFLE_BEST: BestAttributes = {
  positives: [
    "Critical Chance",
    "Critical Damage",
    "Multishot",
    "Damage",
    "Electricity",
    "Toxin",
    "Heat",
    "Cold",
  ],
  negatives: ["Zoom", "Ammo Maximum", "Weapon Recoil", "Projectile Speed"],
};

const SHOTGUN_BEST: BestAttributes = {
  positives: [
    "Critical Chance",
    "Critical Damage",
    "Multishot",
    "Status Chance",
    "Damage",
    "Electricity",
    "Toxin",
    "Heat",
  ],
  negatives: ["Zoom", "Ammo Maximum", "Weapon Recoil", "Projectile Speed"],
};

const PISTOL_BEST: BestAttributes = {
  positives: [
    "Critical Chance",
    "Critical Damage",
    "Multishot",
    "Damage",
    "Electricity",
    "Toxin",
    "Heat",
    "Cold",
  ],
  negatives: ["Zoom", "Ammo Maximum", "Weapon Recoil", "Projectile Speed"],
};

const MELEE_BEST: BestAttributes = {
  positives: [
    "Critical Chance",
    "Critical Damage",
    "Melee Damage",
    "Attack Speed",
    "Range",
    "Electricity",
    "Toxin",
    "Heat",
  ],
  negatives: [
    "Finisher Damage",
    "Heavy Attack Efficiency",
    "Combo Duration",
    "Slide Attack",
  ],
};

const ARCHGUN_BEST: BestAttributes = {
  positives: [
    "Critical Chance",
    "Critical Damage",
    "Multishot",
    "Damage",
    "Electricity",
    "Toxin",
  ],
  negatives: ["Zoom", "Ammo Maximum", "Weapon Recoil"],
};

const CATEGORY_MAP: Record<string, BestAttributes> = {
  LongGuns: RIFLE_BEST,
  Pistols: PISTOL_BEST,
  Melee: MELEE_BEST,
  SpaceGuns: ARCHGUN_BEST,
  SpaceMelee: MELEE_BEST,
  // Shotgun is a sub-category of LongGuns
  Shotgun: SHOTGUN_BEST,
};

const FALLBACK: BestAttributes = {
  positives: ["Critical Chance", "Critical Damage", "Multishot", "Damage"],
  negatives: ["Zoom", "Ammo Maximum"],
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the best positive and negative attributes for a weapon category.
 *
 * @param weaponCategory — product category from ExportWeapons (e.g. "LongGuns", "Melee")
 * @param isShotgun — set true if the weapon has SHOTGUN compat tag
 */
export function getBestAttributes(
  weaponCategory: string,
  isShotgun?: boolean,
): BestAttributes {
  if (isShotgun) return SHOTGUN_BEST;
  return CATEGORY_MAP[weaponCategory] || FALLBACK;
}
