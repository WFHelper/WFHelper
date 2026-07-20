/**
 * Decode riven stats from inventory UpgradeFingerprint
 *
 * Converts the raw encoded fingerprint data (buffs/curses with IEEE 754 float32
 * encoded Values) into displayable stat values, grades, and attribute quality.
 * No OCR needed - this reads directly from inventory JSON.
 */

import { withScope } from "./logger";
import * as rivenData from "./rivenData";
import * as rivenGrading from "./rivenGrading";
import {
  NUM_BUFFS_ATTEN,
  NUM_BUFFS_CURSE_ATTEN,
  SPECIFIC_FIT_ATTEN,
  BASE_DRAIN,
  NON_PERCENTAGE_TAGS,
} from "./rivenConstants";
import type {
  DecodedRivenStat,
  DecodedRiven,
  VeiledRivenEntry,
  VeiledRivenGroup,
} from "../config/shared/rivenTypes";


const log = withScope("rivenFingerprint");

interface RawFingerprint {
  compat?: string;
  lim?: number;
  lvlReq?: number;
  lvl?: number;
  rerolls?: number;
  pol?: string;
  buffs?: { Tag: string; Value: number }[];
  curses?: { Tag: string; Value: number }[];
  challenge?: unknown;
}


const RIVEN_TYPE_LABELS: Record<string, string> = {
  // Lotus (unveiled / individual-veiled in Upgrades)
  LotusRifleRandomModRare: "Rifle",
  LotusShotgunRandomModRare: "Shotgun",
  LotusPistolRandomModRare: "Pistol",
  PlayerMeleeWeaponRandomModRare: "Melee",
  LotusArchgunRandomModRare: "Archgun",
  LotusModularPistolRandomModRare: "Kitgun",
  LotusModularMeleeRandomModRare: "Zaw",
  // Raw (stackable veiled in RawUpgrades)
  RawRifleRandomMod: "Rifle",
  RawShotgunRandomMod: "Shotgun",
  RawPistolRandomMod: "Pistol",
  RawMeleeRandomMod: "Melee",
  RawArchgunRandomMod: "Archgun",
  RawModularPistolRandomMod: "Kitgun",
  RawModularMeleeRandomMod: "Zaw",
};

// Uses exact inventory path segment names from external riven challenge data.
// Keys match the last path component of "/Lotus/Types/Challenges/<Name>".
// Use {n} as placeholder for the Required count.

const CHALLENGE_DESCS: Record<string, string> = {
  // Exact inventory names (with prefixes)
  RandomizedKill: "Kill {n} Enemies",
  RandomizedKillPassengers: "Kill {n} Enemies that are on a Dropship",
  RandomizedKillFallingPilots: "Kill {n} Enemies with Headshots",
  RandomizedFinisherKill: "Kill {n} Enemies with Finishers",
  RandomizedHeadshot: "Kill {n} Enemies with Headshots",
  RandomizedHeadshotGlide: "Get {n} Headshot kills in a single Aim Glide",
  RandomizedStyleKill: "Kill {n} Enemies while Sliding",
  RandomizedWallClingKillstreak:
    "Get {n} kills in a row while Wall Dashing or Wall Latching without touching the floor",
  RandomizedHeadshotUnawareBallistas: "Kill {n} unalerted Tusk Ballistas with a Headshot",
  RandomizedKillSentients: "Get the killing blow on {n} Sentients",
  RandomizedLongRangeSniper: "Kill {n} Enemies with Headshots from at least 75m away",
  RandomizedSkiffArcher: "Destroy {n} Dargyns in flight using a bow",
  RandomizedAntiAntiAir:
    "Destroy {n} Vruush Turrets while in Archwing without dying or becoming downed",
  RandomizedFlyingHeadshotSeries:
    "Land {n} consecutive headshots while in Archwing in the Plains of Eidolon",
  RandomizedFindCaches: "Find {n} Caches",
  RandomizedFindRareMedallions: "Pick up {n} Syndicate Medallions",
  RandomizedFisherman: "Catch {n} fish without missing a throw",
  SustainMeleeComboThree: "Sustain a 6x Melee Combo Multiplier for 30s",
  HighSurvivalPacifist:
    "Complete a Survival mission with level 30 or higher enemies without killing anyone",
  HighExterminationUndetected:
    "Complete an Extermination mission with level 30 or higher enemies without being detected",
  HighPerfectDefense:
    "Complete a Defense mission with level 30 or higher enemies with the defense objective taking no damage",
  HighSoloInterceptionHobbled:
    "Complete a Solo Interception mission with level 30 or higher enemies and a Hobbled Dragon Key equipped",
  LimitedSynthesis:
    "Synthesize a Simaris target without using Traps or Abilities while having a Hobbled Dragon Key equipped",
  PlainsTimedVariety: "Catch one fish, mine one gem or metal, and kill one enemy in 30 seconds",
  KahlMissions: "Complete {n} Kahl missions",
  // DJ / DJRandomized prefix variants (same challenges, different pool)
  DJRandomizedKill: "Kill {n} Enemies",
  DJRandomizedFinisherKill: "Kill {n} Enemies with Finishers",
  DJRandomizedHeadshot: "Kill {n} Enemies with Headshots",
  DJRandomizedStyleKill: "Kill {n} Enemies while Sliding",
  DJRandomizedWallClingKillstreak:
    "Get {n} kills in a row while Wall Dashing or Wall Latching without touching the floor",
  DJRandomizedKillPassengers: "Kill {n} Enemies that are on a Dropship",
  DJRandomizedHeadshotUnawareBallistas: "Kill {n} unalerted Tusk Ballistas with a Headshot",
  DJRandomizedFindCaches: "Find {n} Caches",
};

// Challenge complication path -> appended text
const COMPLICATION_DESCS: Record<string, string> = {
  ResetOnDamageTaken: "without taking damage",
  ResetOnDowned: "without dying or becoming downed",
  ResetOnMissionFailure: "without failing a mission",
  ResetOnAlarmRaised: "without raising any alarms",
  ResetOnAllyDowned: "without an ally becoming downed",
  ResetOnDisrupt: "without being disrupted by a Magnetic Status Effect",
  ResetOnGearAirSupport: "without using air support",
  ResetOnGearAmmoRestores: "without using ammo consumables",
  ResetOnGearCipher: "without using ciphers",
  ResetOnGearEnergyRestores: "without using energy consumables",
  ResetOnGearHealthRestores: "without using health consumables",
  ResetOnGearShieldRestores: "without using shield-restoring consumables",
  ResetOnProc: "without getting afflicted by a Status Effect",
  ResetOnNewDay: "in one day",
  EquippedDamageDebuffKey: "with an Extinguished Dragon Key equipped",
  EquippedHealthDebuffKey: "with a Bleeding Dragon Key equipped",
  EquippedShieldDebuffKey: "with a Decaying Dragon Key equipped",
  EquippedSpeedDebuffKey: "with a Hobbled Dragon Key equipped",
  SoloPlayer: ", while alone or in Solo Mode",
  PetPresent: "with an active pet present",
  SentinelPresent: "with an active sentinel present",
  Invisible: "while invisible",
  AimGliding: "during Aim Glide",
  Sliding: "while sliding",
  Undetected: "while undetected",
};

/**
 * Extract a readable challenge description from a veiled riven fingerprint.
 * Looks up the exact path segment name in CHALLENGE_DESCS, substitutes {n}
 * with the Required count, and appends any complication text.
 */
function describeChallengeType(
  challengeType: string,
  required?: number,
  complication?: string,
): string {
  const name = challengeType.split("/").pop() || challengeType;
  const template = CHALLENGE_DESCS[name];
  const n = required != null ? String(required) : "?";
  let desc: string;
  if (template) {
    desc = template.replace(/\{n\}/g, n);
  } else {
    // Fallback: split PascalCase into words
    desc = name.replace(/([A-Z])/g, " $1").trim();
  }
  // Append complication if present
  if (complication) {
    const compName = complication.split("/").pop() || "";
    const compText = COMPLICATION_DESCS[compName];
    if (compText) desc += " " + compText;
  }
  return desc;
}

function getRivenTypeLabel(itemType: string): string {
  for (const [key, label] of Object.entries(RIVEN_TYPE_LABELS)) {
    if (itemType.includes(key)) return label;
  }
  return "Riven";
}

// Riven fingerprint Values are NOT IEEE 754 floats. They are integers that
// encode a 0-1 roll float as `Math.round(f * 0x3FFFFFFF)`. To decode:
//   rollFloat = intValue / 0x3FFFFFFF
// Source: browse.wf/rivencalc -> RivenParser.js `rivenIntToFloat`.

function rivenIntToFloat(i: number): number {
  const f = i / 0x3FFFFFFF; // 1073741823
  return (f >= 0.0 && f <= 1.0) ? f : 0.0;
}


function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function computeBuffValue(
  baseValue: number,
  disposition: number,
  rollFloat: number,
  numBuffs: number,
  numCurses: number,
  lvl: number,
): number {
  const attenuation = SPECIFIC_FIT_ATTEN * disposition * BASE_DRAIN;
  const buffsAtten = NUM_BUFFS_ATTEN[Math.min(numBuffs, NUM_BUFFS_ATTEN.length - 1)];
  const curseBonus = Math.pow(1.25, numCurses);
  const rollMul = lerp(0.9, 1.1, rollFloat);
  return baseValue * attenuation * curseBonus * rollMul * buffsAtten * (lvl + 1);
}

function computeCurseValue(
  baseValue: number,
  disposition: number,
  rollFloat: number,
  numBuffs: number,
  numCurses: number,
  lvl: number,
): number {
  const attenuation = SPECIFIC_FIT_ATTEN * disposition * BASE_DRAIN;
  const cursesInBuffTable = NUM_BUFFS_ATTEN[Math.min(numCurses, NUM_BUFFS_ATTEN.length - 1)];
  const buffsInCurseTable = NUM_BUFFS_CURSE_ATTEN[Math.min(numBuffs, NUM_BUFFS_CURSE_ATTEN.length - 1)];
  const rollMul = lerp(0.9, 1.1, rollFloat);
  return Math.abs(baseValue) * attenuation * rollMul * buffsInCurseTable * cursesInBuffTable * (lvl + 1);
}


function parseFingerprint(raw: string): RawFingerprint | null {
  try {
    let parsed = JSON.parse(raw);
    // Some fingerprints are double-stringified
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return parsed as RawFingerprint;
  } catch {
    // Malformed JSON fingerprint - treat as absent.
    return null;
  }
}

function isRivenItemType(itemType: string): boolean {
  return itemType.includes("Randomized") || itemType.includes("RandomMod");
}

function isVeiledFingerprint(fp: RawFingerprint): boolean {
  return !!fp.challenge || !fp.compat;
}


function decodeSingleRiven(
  entry: { UpgradeFingerprint?: string; ItemType: string; ItemId?: { $oid: string } },
): DecodedRiven | null {
  if (!entry.UpgradeFingerprint) return null;

  const fp = parseFingerprint(entry.UpgradeFingerprint);
  if (!fp || isVeiledFingerprint(fp)) return null;
  if (!fp.compat) return null;

  // Resolve weapon name from compat uniqueName
  const weaponName = rivenData.getWeaponNameByUniqueName(fp.compat);
  if (!weaponName) {
    log.debug(`[Fingerprint] Unknown weapon compat: ${fp.compat}`);
    return null;
  }

  const disposition = rivenData.getWeaponDisposition(weaponName);
  if (disposition == null) return null;

  const rivenTypeKey = rivenData.resolveRivenType(weaponName);
  if (!rivenTypeKey) return null;

  const lvl = typeof fp.lvl === "number" ? fp.lvl : 8;
  const buffs = Array.isArray(fp.buffs) ? fp.buffs : [];
  const curses = Array.isArray(fp.curses) ? fp.curses : [];
  const numBuffs = buffs.length;
  const numCurses = curses.length;

  const decodedStats: DecodedRivenStat[] = [];
  let rollFloatSum = 0;
  let scoredCount = 0;

  // Decode buffs
  for (const b of buffs) {
    const rollFloat = rivenIntToFloat(b.Value);
    const entry2 = rivenData.findUpgradeEntry(rivenTypeKey, b.Tag);
    const baseValue = entry2?.baseValue ?? 0;
    const displayName = rivenData.getStatDisplayName(b.Tag);
    const isNonPct = NON_PERCENTAGE_TAGS.has(b.Tag);

    let displayValue: number;
    if (baseValue !== 0) {
      const raw = computeBuffValue(baseValue, disposition, rollFloat, numBuffs, numCurses, lvl);
      displayValue = isNonPct ? Math.round(raw * 100) / 100 : Math.round(raw * 1000) / 10;
    } else {
      displayValue = 0;
    }

    const grade = rivenGrading.floatToGrade(rollFloat, false);
    const isMultiplier = isNonPct && (
      b.Tag.includes("FactionDamage") || b.Tag === "WeaponMeleeComboInitialBonusMod"
    );

    decodedStats.push({
      tag: b.Tag,
      name: displayName,
      displayValue: isMultiplier ? Math.round((1 + displayValue) * 100) / 100 : displayValue,
      rollFloat,
      grade,
      positive: true,
      multiplier: isMultiplier,
    });

    rollFloatSum += rollFloat;
    scoredCount++;
  }

  // Decode curses
  for (const c of curses) {
    const rollFloat = rivenIntToFloat(c.Value);
    const entry2 = rivenData.findUpgradeEntry(rivenTypeKey, c.Tag);
    const baseValue = entry2?.baseValue ?? 0;
    const displayName = rivenData.getStatDisplayName(c.Tag);
    const isNonPct = NON_PERCENTAGE_TAGS.has(c.Tag);
    const isMultiplier = isNonPct && (
      c.Tag.includes("FactionDamage") || c.Tag === "WeaponMeleeComboInitialBonusMod"
    );

    // Curse direction is the opposite of the stat's buff direction: a damage
    // curse shows -X%, but a recoil curse (negative baseValue) shows +X%.
    // Multipliers stay unsigned - they render as the final factor (x0.55).
    let displayValue = 0;
    if (baseValue !== 0) {
      const raw = computeCurseValue(Math.abs(baseValue), disposition, rollFloat, numBuffs, numCurses, lvl);
      const magnitude = isNonPct ? Math.round(raw * 100) / 100 : Math.round(raw * 1000) / 10;
      displayValue = isMultiplier
        ? Math.round((1 - magnitude) * 100) / 100
        : baseValue > 0
          ? -magnitude
          : magnitude;
    }

    const grade = rivenGrading.floatToGrade(rollFloat, true);

    decodedStats.push({
      tag: c.Tag,
      name: displayName,
      displayValue,
      rollFloat,
      grade,
      positive: false,
      multiplier: isMultiplier,
    });

    rollFloatSum += (1 - rollFloat); // For curses, lower = better
    scoredCount++;
  }

  // Overall grade = average roll quality
  const avgRollFloat = scoredCount > 0 ? rollFloatSum / scoredCount : 0.5;
  const overallGrade = rivenGrading.floatToGrade(avgRollFloat, false);

  // Attribute grade (Great/Good/OK/Bad) using the per-weapon good-roll dataset.
  const positives = decodedStats.filter((s) => s.positive);
  const negatives = decodedStats.filter((s) => !s.positive);
  const attributeGrade = rivenGrading.computeAttributeGrade(
    [...positives, ...negatives].map((s) => ({ name: s.name, positive: s.positive })),
    weaponName,
  );

  // Generate the riven suffix name (game rule: buffs by roll Value, descending)
  const rivenSuffix = rivenData.generateRivenSuffix(
    rivenTypeKey,
    buffs.map((b) => ({ tag: b.Tag, value: b.Value })),
  );
  const rivenName = rivenSuffix ? `${weaponName} ${rivenSuffix}` : weaponName;

  const statPerfectness = scoredCount > 0 ? rollFloatSum / scoredCount : 0;

  return {
    itemId: entry.ItemId?.$oid || "",
    weaponName,
    weaponUniqueName: fp.compat,
    rivenName,
    masteryReq: typeof fp.lvlReq === "number" ? fp.lvlReq : 0,
    currentRank: lvl,
    maxRank: 8,
    rerolls: typeof fp.rerolls === "number" ? fp.rerolls : 0,
    polarity: fp.pol || "",
    disposition,
    stats: decodedStats,
    overallGrade,
    attributeGrade,
    statPerfectness,
    rivenType: getRivenTypeLabel(entry.ItemType),
  };
}


export function decodeAllRivens(
  inventory: Record<string, unknown>,
): { unveiled: DecodedRiven[]; veiled: VeiledRivenEntry[]; veiledUnseen: VeiledRivenGroup[] } {
  const unveiled: DecodedRiven[] = [];
  const veiled: VeiledRivenEntry[] = [];
  const unseenCounts = new Map<string, number>();

  // Process Upgrades array (unveiled rivens with unique fingerprints)
  const upgrades = inventory.Upgrades;
  if (Array.isArray(upgrades)) {
    for (const raw of upgrades) {
      if (!raw || typeof raw !== "object") continue;
      const u = raw as { ItemType?: string; UpgradeFingerprint?: string; ItemId?: { $oid: string } };
      if (!u.ItemType || !isRivenItemType(u.ItemType)) continue;

      // Check if veiled (has challenge fingerprint or no compat)
      if (u.UpgradeFingerprint) {
        const fp = parseFingerprint(u.UpgradeFingerprint);
        if (fp && isVeiledFingerprint(fp)) {
          const label = getRivenTypeLabel(u.ItemType);
          const entry: VeiledRivenEntry = { itemType: u.ItemType, label };
          // Extract challenge info if present
          if (fp.challenge && typeof fp.challenge === "object") {
            const ch = fp.challenge as {
              Type?: string;
              Progress?: number;
              Required?: number;
              Complication?: string;
            };
            if (typeof ch.Progress === "number") entry.challengeProgress = ch.Progress;
            if (typeof ch.Required === "number") entry.challengeRequired = ch.Required;
            if (typeof ch.Type === "string") {
              entry.challengeType = ch.Type;
              entry.challengeDesc = describeChallengeType(
                ch.Type,
                entry.challengeRequired,
                typeof ch.Complication === "string" ? ch.Complication : undefined,
              );
            }
          }
          veiled.push(entry);
          continue;
        }
      }

      const decoded = decodeSingleRiven({
        UpgradeFingerprint: u.UpgradeFingerprint,
        ItemType: u.ItemType,
        ItemId: u.ItemId,
      });
      if (decoded) unveiled.push(decoded);
    }
  }

  // Process RawUpgrades array (stackable veiled rivens - no fingerprint, "unseen")
  const rawUpgrades = inventory.RawUpgrades;
  if (Array.isArray(rawUpgrades)) {
    for (const raw of rawUpgrades) {
      if (!raw || typeof raw !== "object") continue;
      const u = raw as { ItemType?: string; ItemCount?: number };
      if (!u.ItemType || !isRivenItemType(u.ItemType)) continue;
      const count = typeof u.ItemCount === "number" ? u.ItemCount : 1;
      const label = getRivenTypeLabel(u.ItemType);
      unseenCounts.set(label, (unseenCounts.get(label) || 0) + count);
    }
  }

  const veiledUnseen: VeiledRivenGroup[] = [];
  for (const [label, count] of unseenCounts) {
    veiledUnseen.push({
      itemType: label,
      label: `${label} Riven Mod`,
      count,
    });
  }

  log.info(`[Fingerprint] Decoded ${unveiled.length} unveiled, ${veiled.length} veiled with challenge, ${veiledUnseen.length} unseen groups`);
  return { unveiled, veiled, veiledUnseen };
}
