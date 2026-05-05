/**
 * rivenGrading.ts — Riven stat grading service (main-process only)
 *
 * Ports the grading algorithm from browse.wf/calamity's RivenParser.js:
 *  - Reverse-calculates the 0–1 roll float from the displayed stat value
 *  - Maps roll float to a letter grade (S, A+, A, ..., F)
 *
 * The core forward formula (from RivenParser.js parseRiven):
 *   For buffs:
 *     value = baseValue * (1.5 * disposition * 10) * pow(1.25, numCurses)
 *           * lerp(0.9, 1.1, rollFloat) * numBuffsAtten[numBuffs] * (lvl + 1)
 *   For curses:
 *     value = baseValue * -1 * (1.5 * disposition * 10) * lerp(0.9, 1.1, rollFloat)
 *           * numBuffsCurseAtten[numBuffs] * numBuffsAtten[numCurses] * (lvl + 1)
 *
 * To reverse (unparse), we divide out all known factors to recover rollFloat.
 */

import { withScope } from "./logger";
import * as rivenData from "./rivenData";
import {
  NUM_BUFFS_ATTEN,
  NUM_BUFFS_CURSE_ATTEN,
  SPECIFIC_FIT_ATTEN,
  BASE_DRAIN,
  NON_PERCENTAGE_TAGS,
} from "./rivenConstants";
import {
  getGoodRolls,
  type GoodRollData,
} from "./rivenBestAttributes";

const log = withScope("rivenGrading");


interface GradedStat {
  name: string;
  positive: boolean;
  displayPositive?: boolean;
  value: number | null;
  multiplier?: boolean;
  grade: string;
  rollFloat: number;
}

export interface RivenGradeResult {
  stats: GradedStat[];
  overallGrade: string;
  /** Attribute-based riven quality: "Great" | "Good" | "OK" | "Bad" */
  attributeGrade: string;
}


/** Default riven max rank. Most rivens are rank 8 (lvl 0..8). */
const DEFAULT_LVL = 8;

/**
 * Grade thresholds mapped from lerp(-10, 10, rollFloat).
 * Score ≥ threshold → grade. Evenly spaced at 2-point intervals.
 * Matches RivenParser.js floatToGrade exactly.
 */
const GRADE_THRESHOLDS: { min: number; grade: string }[] = [
  { min: 9.5, grade: "S" },
  { min: 7.5, grade: "A+" },
  { min: 5.5, grade: "A" },
  { min: 3.5, grade: "A-" },
  { min: 1.5, grade: "B+" },
  { min: -1.5, grade: "B" },
  { min: -3.5, grade: "B-" },
  { min: -5.5, grade: "C+" },
  { min: -7.5, grade: "C" },
  { min: -9.5, grade: "C-" },
];


function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function inverseLerp(a: number, b: number, v: number): number {
  if (b === a) return 0;
  return (v - a) / (b - a);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}


/**
 * Convert a 0–1 roll float to a letter grade.
 * For curses, pass isCurse=true: the grade is inverted (low absolute curse value = good).
 */
export function floatToGrade(rollFloat: number, isCurse: boolean): string {
  const f = isCurse ? 1 - rollFloat : rollFloat;
  const score = lerp(-10, 10, f);
  for (const { min, grade } of GRADE_THRESHOLDS) {
    if (score >= min) return grade;
  }
  return "F";
}

/**
 * Reverse-calculate the roll float from a displayed buff value.
 *
 * Mirrors RivenParser.js unparseBuff():
 *   value /= (lvl + 1)
 *   value /= numBuffsAtten[numBuffs]
 *   value /= pow(1.25, numCurses)
 *   value /= (1.5 * omegaAttenuation * 10)
 *   value /= baseValue
 *   rollFloat = (value - 0.9) / 0.2
 *
 * `displayedValue` is the percentage shown in-game (e.g. +190.9%).
 * For non-percentage stats (faction damage, combo, range), pass the raw displayed number.
 */
export function unparseBuff(
  displayedValue: number,
  baseValue: number,
  disposition: number,
  numBuffs: number,
  numCurses: number,
  tag?: string,
  lvl: number = DEFAULT_LVL,
): number {
  const buffsAtten = NUM_BUFFS_ATTEN[Math.min(numBuffs, NUM_BUFFS_ATTEN.length - 1)];
  const curseAtten = Math.pow(1.25, numCurses);
  const attenuation = SPECIFIC_FIT_ATTEN * disposition * BASE_DRAIN;

  // Convert displayed value to raw multiplier
  let value: number;
  if (tag && NON_PERCENTAGE_TAGS.has(tag)) {
    value = displayedValue;
  } else {
    value = displayedValue / 100;
  }

  if (baseValue === 0 || attenuation === 0 || buffsAtten === 0 || curseAtten === 0) return 0.5;

  value /= lvl + 1;
  value /= buffsAtten;
  value /= curseAtten;
  value /= attenuation;
  // Use abs(baseValue) because our OCR input is always the absolute displayed
  // value. Some stats like recoil have negative baseValues even when appearing
  // as buffs — the sign is already handled by the buff/curse classification.
  value /= Math.abs(baseValue);

  // value is now lerp(0.9, 1.1, rollFloat) → invert
  const rollFloat = (value - 0.9) / 0.2;
  return clamp01(rollFloat);
}

/**
 * Reverse-calculate the roll float from a displayed curse value.
 *
 * Mirrors RivenParser.js unparseCurse() but adapted for OCR input where the
 * displayed value is always positive (the sign is tracked separately).
 *
 * RivenParser.js forward curse formula:
 *   rawValue = baseValue * -1 * attenuation * lerp(0.9,1.1,roll)
 *            * numBuffsCurseAtten[numBuffs] * numBuffsAtten[numCurses] * (lvl+1)
 *
 * In RivenParser.js unparseCurse, `value` is negative (raw internal), and divides by -1
 * to make it positive before extracting rollFloat. Since our OCR gives us the absolute
 * displayed value already, we skip the /-1 step.
 */
export function unparseCurse(
  displayedValue: number,
  baseValue: number,
  disposition: number,
  numBuffs: number,
  numCurses: number,
  tag?: string,
  lvl: number = DEFAULT_LVL,
): number {
  const attenuation = SPECIFIC_FIT_ATTEN * disposition * BASE_DRAIN;
  // Note the swapped indexing: buffs table by curse count, curse table by buff count
  const cursesInBuffTable = NUM_BUFFS_ATTEN[Math.min(numCurses, NUM_BUFFS_ATTEN.length - 1)];
  const buffsInCurseTable =
    NUM_BUFFS_CURSE_ATTEN[Math.min(numBuffs, NUM_BUFFS_CURSE_ATTEN.length - 1)];

  // Convert displayed value to raw multiplier (absolute value)
  let value: number;
  if (tag && NON_PERCENTAGE_TAGS.has(tag)) {
    value = Math.abs(displayedValue);
  } else {
    value = Math.abs(displayedValue) / 100;
  }

  if (baseValue === 0 || attenuation === 0 || cursesInBuffTable === 0 || buffsInCurseTable === 0)
    return 0.5;

  value /= lvl + 1;
  value /= cursesInBuffTable;
  value /= buffsInCurseTable;
  value /= attenuation;
  value /= Math.abs(baseValue);
  // RivenParser.js does: value /= baseValue; value /= -1.0;
  // Since baseValue can be negative (e.g. recoil = -0.01), dividing by baseValue
  // and then by -1 is equivalent to dividing by |baseValue|. Our OCR input is
  // already the absolute displayed value, so we just use |baseValue| directly.

  const rollFloat = (value - 0.9) / 0.2;
  return clamp01(rollFloat);
}


/**
 * Per-attribute grade:
 *   Decisive  — positive listed in some `goodAttrs[*].mandatory`
 *   Good      — positive in some `goodAttrs[*].optional`,
 *               or a negative listed in `acceptedBadAttrs`
 *   Bad       — negative listed in some `goodAttrs[*].mandatory|optional`
 *   NotHelping — anything else
 */
type AlecaAttrGrade = "Decisive" | "Good" | "NotHelping" | "Bad";

function gradeFromGoodRolls(
  data: GoodRollData,
  goodTags: string[],
  badTags: string[],
): { positive: AlecaAttrGrade[]; negative: AlecaAttrGrade[]; overall: string } {
  const positive: AlecaAttrGrade[] = goodTags.map(() => "NotHelping");
  const negative: AlecaAttrGrade[] = badTags.map(() => "NotHelping");

  // Negative grades.
  for (let i = 0; i < badTags.length; i++) {
    const tag = badTags[i];
    if (data.acceptedBadAttrs.includes(tag)) {
      negative[i] = "Good";
    } else if (
      data.goodAttrs.some((g) => g.mandatory.includes(tag) || g.optional.includes(tag))
    ) {
      negative[i] = "Bad";
    } else {
      negative[i] = "NotHelping";
    }
  }

  // Positive grades.
  for (let i = 0; i < goodTags.length; i++) {
    const tag = goodTags[i];
    if (data.goodAttrs.some((g) => g.mandatory.includes(tag))) {
      positive[i] = "Decisive";
    } else if (data.goodAttrs.some((g) => g.optional.includes(tag))) {
      positive[i] = "Good";
    } else {
      positive[i] = "NotHelping";
    }
  }

  // Does at least one full GoodRoll match? (all mandatory present, and the
  // user's positives are a subset of mandatory∪optional)
  const goodSet = new Set(goodTags);
  const matches = data.goodAttrs.filter((g) => {
    if (!g.mandatory.every((m) => goodSet.has(m))) return false;
    const allowed = new Set([...g.mandatory, ...g.optional]);
    return goodTags.every((t) => allowed.has(t));
  });
  const flag = matches.length > 0;
  const num = positive.filter((p) => p === "Decisive" || p === "Good").length;
  const hasBadNeg = negative.some((n) => n === "Bad");
  const hasNotHelpingNeg = negative.some((n) => n === "NotHelping");
  const hasAnyNeg = negative.length > 0;

  // Flatten the detailed result to the 4-level UI scale already in use.
  let overall: string;
  if (hasBadNeg) {
    overall = (flag && num >= 2) || num >= 3 ? "OK" /* HasPotential */ : "Bad";
  } else if (hasNotHelpingNeg) {
    if (flag || num >= 2) overall = "Good";
    else if (num >= 1) overall = "OK"; /* HasPotential */
    else overall = "Bad";
  } else if (flag) {
    overall = num >= 2 && hasAnyNeg ? "Great" /* Perfect */ : "Good";
  } else if (num >= 2) {
    overall = "Good";
  } else if (num >= 1) {
    overall = "OK";
  } else {
    overall = "Bad";
  }
  return { positive, negative, overall };
}

/**
 * Compute an attribute-quality grade for a riven.
 *
 * Uses scoring against the per-weapon `GoodRollData` sourced from
 * 44bananas' "good rolls for selling" sheet (see
 * `config/shared/rivenGoodRolls.ts`). Returns "?" when the weapon
 * isn't in the dataset.
 */
export function computeAttributeGrade(
  stats: { name: string; positive: boolean }[],
  weaponName: string,
): string {
  const positives = stats.filter((s) => s.positive);
  const negatives = stats.filter((s) => !s.positive);

  const data = getGoodRolls(weaponName);
  if (!data) return "?";

  const goodTags = positives.map((s) => rivenData.statNameToTag(s.name) ?? s.name);
  const badTags = negatives.map((s) => rivenData.statNameToTag(s.name) ?? s.name);
  return gradeFromGoodRolls(data, goodTags, badTags).overall;
}

/**
 * Grade a complete riven given weapon name and OCR'd stats.
 *
 * Returns null if the weapon can't be found or riven type can't be resolved.
 */
export function gradeRiven(
  weaponName: string,
  stats: {
    name: string;
    positive: boolean;
    displayPositive?: boolean;
    value: number | null;
    multiplier?: boolean;
  }[],
): RivenGradeResult | null {
  if (!stats || stats.length === 0) return null;

  const disposition = rivenData.getWeaponDisposition(weaponName);
  if (disposition == null) {
    log.warn(`[RivenGrade] Weapon not found: "${weaponName}"`);
    return null;
  }

  const rivenTypeKey = rivenData.resolveRivenType(weaponName);
  if (!rivenTypeKey) {
    log.warn(`[RivenGrade] No riven type for weapon: "${weaponName}"`);
    return null;
  }

  // Count buffs and curses
  const numBuffs = stats.filter((s) => s.positive).length;
  const numCurses = stats.filter((s) => !s.positive).length;
  const assumedLevel = DEFAULT_LVL;

  const gradedStats: GradedStat[] = [];
  let scoreSum = 0;
  let scoredCount = 0;

  for (const stat of stats) {
    // Map OCR name to upgrade tag
    const tag = rivenData.statNameToTag(stat.name);
    if (!tag) {
      log.debug(`[RivenGrade] Unknown stat: "${stat.name}" — assigning B grade`);
      gradedStats.push({
        ...stat,
        grade: "B",
        rollFloat: 0.5,
      });
      scoreSum += 0; // lerp(-10, 10, 0.5) = 0
      scoredCount++;
      continue;
    }

    // Find the upgrade entry for this tag in the riven type
    const entry = rivenData.findUpgradeEntry(rivenTypeKey, tag);
    if (!entry) {
      log.debug(`[RivenGrade] Tag "${tag}" not in riven type ${rivenTypeKey.split("/").pop()}`);
      gradedStats.push({
        ...stat,
        grade: "B",
        rollFloat: 0.5,
      });
      scoreSum += 0;
      scoredCount++;
      continue;
    }

    // If we have a numeric value, calculate the grade
    if (stat.value != null && Number.isFinite(stat.value)) {
      let rollFloat: number;
      let displayedValue = stat.value;

      // Handle x-multiplier format: x1.59 → convert to percentage-like
      // x-multiplier means the actual stat is (value - 1) * 100 for positive,
      // or (1 - value) * 100 for negative
      if (stat.multiplier) {
        displayedValue = stat.positive ? (stat.value - 1) * 100 : (1 - stat.value) * 100;
      }

      if (stat.positive) {
        rollFloat = unparseBuff(
          displayedValue,
          entry.baseValue,
          disposition,
          numBuffs,
          numCurses,
          tag,
          assumedLevel,
        );
      } else {
        rollFloat = unparseCurse(
          displayedValue,
          entry.baseValue,
          disposition,
          numBuffs,
          numCurses,
          tag,
          assumedLevel,
        );
      }

      const grade = floatToGrade(rollFloat, !stat.positive);
      const score = lerp(-10, 10, !stat.positive ? 1 - rollFloat : rollFloat);

      gradedStats.push({
        ...stat,
        grade,
        rollFloat,
      });
      scoreSum += score;
      scoredCount++;
    } else {
      // No value — can't grade, assign mid-range
      gradedStats.push({
        ...stat,
        grade: "?",
        rollFloat: 0.5,
      });
    }
  }

  // Overall grade = average of all stat scores
  let overallGrade = "?";
  if (scoredCount > 0) {
    const avgScore = scoreSum / scoredCount;
    const avgFloat = inverseLerp(-10, 10, avgScore);
    overallGrade = floatToGrade(avgFloat, false);
  }

  // Attribute-based grade (Great/Good/OK/Bad)
  const attributeGrade = computeAttributeGrade(stats, weaponName);

  return { stats: gradedStats, overallGrade, attributeGrade };
}
