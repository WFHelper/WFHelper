export interface BestAttributes {
  positives: string[];
  negatives: string[];
}

export const RIVEN_BEST_ATTRIBUTE_SETS = {
  rifle: {
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
  },
  shotgun: {
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
  },
  pistol: {
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
  },
  melee: {
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
    negatives: ["Finisher Damage", "Heavy Attack Efficiency", "Combo Duration", "Slide Attack"],
  },
  archgun: {
    positives: ["Critical Chance", "Critical Damage", "Multishot", "Damage", "Electricity", "Toxin"],
    negatives: ["Zoom", "Ammo Maximum", "Weapon Recoil"],
  },
  fallback: {
    positives: ["Critical Chance", "Critical Damage", "Multishot", "Damage"],
    negatives: ["Zoom", "Ammo Maximum"],
  },
} satisfies Record<string, BestAttributes>;
