/**
 * Best riven attributes per weapon category (renderer-side static lookup).
 * Mirrors services/rivenBestAttributes.ts data for display in the riven detail modal.
 */

export interface BestAttributes {
  positives: string[];
  negatives: string[];
}

const RIFLE: BestAttributes = {
  positives: ["Critical Chance", "Critical Damage", "Multishot", "Damage", "Electricity", "Toxin", "Heat", "Cold"],
  negatives: ["Zoom", "Ammo Maximum", "Weapon Recoil", "Projectile Speed"],
};

const SHOTGUN: BestAttributes = {
  positives: ["Critical Chance", "Critical Damage", "Multishot", "Status Chance", "Damage", "Electricity", "Toxin", "Heat"],
  negatives: ["Zoom", "Ammo Maximum", "Weapon Recoil", "Projectile Speed"],
};

const PISTOL: BestAttributes = {
  positives: ["Critical Chance", "Critical Damage", "Multishot", "Damage", "Electricity", "Toxin", "Heat", "Cold"],
  negatives: ["Zoom", "Ammo Maximum", "Weapon Recoil", "Projectile Speed"],
};

const MELEE: BestAttributes = {
  positives: ["Critical Chance", "Critical Damage", "Melee Damage", "Attack Speed", "Range", "Electricity", "Toxin", "Heat"],
  negatives: ["Finisher Damage", "Heavy Attack Efficiency", "Combo Duration", "Slide Attack"],
};

const ARCHGUN: BestAttributes = {
  positives: ["Critical Chance", "Critical Damage", "Multishot", "Damage", "Electricity", "Toxin"],
  negatives: ["Zoom", "Ammo Maximum", "Weapon Recoil"],
};

const TYPE_MAP: Record<string, BestAttributes> = {
  Rifle: RIFLE,
  Shotgun: SHOTGUN,
  Pistol: PISTOL,
  Kitgun: PISTOL,
  Melee: MELEE,
  Zaw: MELEE,
  Archgun: ARCHGUN,
};

export function getBestAttributes(rivenType: string): BestAttributes {
  return TYPE_MAP[rivenType] ?? RIFLE;
}
