"use strict";

/**
 * rivenGrading.ts — Riven stat grading service (main-process only)
 *
 * Ports the grading algorithm from AlecaFrame's RivenParser.js:
 *  - Reverse-calculates the 0–1 roll float from the displayed stat value
 *  - Maps roll float to a letter grade (S, A+, A, ..., F)
 *
 * The core formula:
 *   displayedValue = baseValue * 10 * lerp(0.9, 1.1, rollFloat)
 *                    * disposition * numBuffsAtten[buffs] * numCursesAtten[curses]
 *
 * To reverse (unparse):
 *   rollFloat = inverseLerp(0.9, 1.1, displayedValue / (baseValue * 10 * disposition * ...))
 */

import { withScope } from "./logger";
import * as rivenData from "./rivenData";

const log = withScope("rivenGrading");

// ── Types ────────────────────────────────────────────────────────────────────

export interface GradedStat {
  name: string;
  positive: boolean;
  value: number | null;
  multiplier?: boolean;
  grade: string;
  rollFloat: number;
}

export interface RivenGradeResult {
  stats: GradedStat[];
  overallGrade: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Buff attenuation by number of buffs on the riven.
 * Index = number of buffs (0-5). Index 0 is unused.
 */
const NUM_BUFFS_ATTEN = [0, 1, 0.66, 0.5, 0.4, 0.35];

/**
 * Curse attenuation by number of curses on the riven.
 * Index = number of curses (0-5). Index 0 is unused (no curse = 1.0 multiplier is applied).
 * These values multiply into the buff calculation when a curse is present.
 */
const NUM_CURSES_ATTEN = [0, 1, 0.33, 0.5, 1.25, 1.5];

/**
 * Grade thresholds mapped from lerp(-10, 10, rollFloat).
 * Score ≥ threshold → grade.
 */
const GRADE_THRESHOLDS: { min: number; grade: string }[] = [
  { min: 9.5, grade: "S" },
  { min: 7.5, grade: "A+" },
  { min: 5.5, grade: "A" },
  { min: 3.5, grade: "A-" },
  { min: 1.5, grade: "B+" },
  { min: -0.5, grade: "B" },
  { min: -2.5, grade: "B-" },
  { min: -4.5, grade: "C+" },
  { min: -6.5, grade: "C" },
  { min: -8.5, grade: "C-" },
];

// ── Math helpers ─────────────────────────────────────────────────────────────

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

// ── Grading functions ────────────────────────────────────────────────────────

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
 * Formula (from RivenParser.js):
 *   displayed = round(baseValue * 10 * lerp(0.9, 1.1, roll) * disposition * buffsAtten * cursesAtten)
 *
 * Note: the game rounds the displayed value to 1 decimal. We reverse from the
 * displayed value, so there's inherent ±0.05% imprecision.
 */
export function unparseBuff(
  displayedValue: number,
  baseValue: number,
  disposition: number,
  numBuffs: number,
  numCurses: number,
): number {
  const buffsAtten = NUM_BUFFS_ATTEN[numBuffs] ?? NUM_BUFFS_ATTEN[NUM_BUFFS_ATTEN.length - 1];
  const cursesAtten = numCurses > 0
    ? (NUM_CURSES_ATTEN[numCurses] ?? NUM_CURSES_ATTEN[NUM_CURSES_ATTEN.length - 1])
    : 1;

  const scale = baseValue * 10 * disposition * buffsAtten * cursesAtten;
  if (scale === 0) return 0.5; // fallback: mid-roll

  // displayedValue is percentage (e.g. 190.9 for +190.9%)
  // The formula: displayed = round(scale * lerp(0.9, 1.1, roll) * 100, 1)
  // → displayed / 100 = scale * lerp(0.9, 1.1, roll)
  // → roll = inverseLerp(0.9, 1.1, displayed / 100 / scale)
  const ratio = displayedValue / 100 / scale;
  return clamp01(inverseLerp(0.9, 1.1, ratio));
}

/**
 * Reverse-calculate the roll float from a displayed curse value.
 *
 * Curses use the same formula but with negative output.
 * The displayed value is always shown as negative (e.g. −52.3%).
 * We take the absolute value for calculation.
 */
export function unparseCurse(
  displayedValue: number,
  baseValue: number,
  disposition: number,
  numBuffs: number,
  numCurses: number,
): number {
  // Curse uses absolute value of baseValue and displayed
  const absDisplayed = Math.abs(displayedValue);
  const absBase = Math.abs(baseValue);

  const buffsAtten = NUM_BUFFS_ATTEN[numBuffs] ?? NUM_BUFFS_ATTEN[NUM_BUFFS_ATTEN.length - 1];
  const cursesAtten = numCurses > 0
    ? (NUM_CURSES_ATTEN[numCurses] ?? NUM_CURSES_ATTEN[NUM_CURSES_ATTEN.length - 1])
    : 1;

  const scale = absBase * 10 * disposition * buffsAtten * cursesAtten;
  if (scale === 0) return 0.5;

  const ratio = absDisplayed / 100 / scale;
  return clamp01(inverseLerp(0.9, 1.1, ratio));
}

/**
 * Grade a complete riven given weapon name and OCR'd stats.
 *
 * Returns null if the weapon can't be found or riven type can't be resolved.
 */
export function gradeRiven(
  weaponName: string,
  stats: { name: string; positive: boolean; value: number | null; multiplier?: boolean }[],
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
        displayedValue = stat.positive
          ? (stat.value - 1) * 100
          : (1 - stat.value) * 100;
      }

      if (stat.positive) {
        rollFloat = unparseBuff(displayedValue, entry.baseValue, disposition, numBuffs, numCurses);
      } else {
        rollFloat = unparseCurse(displayedValue, entry.baseValue, disposition, numBuffs, numCurses);
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

  return { stats: gradedStats, overallGrade };
}
