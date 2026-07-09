/**
 * Upgrade-tag ID -> display name ("WeaponCritDamageMod" -> "Critical Damage").
 * Kept in config/shared so the renderer avoids main-process imports.
 * AS shares FR's tag (WeaponFireRateMod); pass melee=true to label it Attack Speed.
 */

const STAT_TAG_TO_DISPLAY_NAME: Record<string, string> = {
  WeaponCritChanceMod: "Critical Chance",
  WeaponCritDamageMod: "Critical Damage",
  WeaponFireIterationsMod: "Multishot",
  WeaponFireRateMod: "Fire Rate",
  WeaponDamageAmountMod: "Damage",
  WeaponMeleeDamageMod: "Melee Damage",
  WeaponReloadSpeedMod: "Reload Speed",
  WeaponStunChanceMod: "Status Chance",
  WeaponProcTimeMod: "Status Duration",
  WeaponPunctureDepthMod: "Punch Through",
  WeaponClipMaxMod: "Magazine Capacity",
  WeaponAmmoMaxMod: "Ammo Maximum",
  WeaponRecoilReductionMod: "Weapon Recoil",
  WeaponZoomFovMod: "Zoom",
  WeaponProjectileSpeedMod: "Projectile Speed",
  WeaponImpactDamageMod: "Impact",
  WeaponArmorPiercingDamageMod: "Puncture",
  WeaponSlashDamageMod: "Slash",
  WeaponFreezeDamageMod: "Cold",
  WeaponFireDamageMod: "Heat",
  WeaponElectricityDamageMod: "Electricity",
  WeaponToxinDamageMod: "Toxin",
  WeaponFactionDamageGrineer: "Damage to Grineer",
  WeaponFactionDamageCorpus: "Damage to Corpus",
  WeaponFactionDamageInfested: "Damage to Infested",
  WeaponMeleeRangeIncMod: "Range",
  ComboDurationMod: "Combo Duration",
  SlideAttackCritChanceMod: "Slide Attack",
  WeaponMeleeFinisherDamageMod: "Finisher Damage",
  WeaponMeleeComboEfficiencyMod: "Heavy Attack Efficiency",
  WeaponMeleeComboInitialBonusMod: "Initial Combo",
  WeaponMeleeComboPointsOnHitMod: "Chance to Gain Combo Count",
  WeaponMeleeComboBonusOnHitMod: "Additional Combo Count Chance",
};

/**
 * Resolve a tag to a display name. For `WeaponFireRateMod` returns
 * "Attack Speed" when `melee` is true.
 */
export function statTagToDisplayName(tag: string, melee = false): string {
  if (melee && tag === "WeaponFireRateMod") return "Attack Speed";
  return STAT_TAG_TO_DISPLAY_NAME[tag] ?? tag;
}
