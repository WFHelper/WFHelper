// Inverts browse.wf/calamity RivenParser.js display values back to roll floats.

import { withScope } from "./logger";
import * as rivenData from "./rivenData";
import {
  NUM_BUFFS_ATTEN,
  NUM_BUFFS_CURSE_ATTEN,
  SPECIFIC_FIT_ATTEN,
  BASE_DRAIN,
  NON_PERCENTAGE_TAGS,
} from "./rivenConstants";
import { getGoodRolls, type GoodRollData } from "./rivenBestAttributes";
import { clamp01 } from "./rewardScannerUtils";
import { lerp } from "../config/shared/numeric";

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

/** Rivens are rank 8 (lvl 0..8). */
export const MAX_RIVEN_MOD_RANK = 8;

/** RivenParser.js thresholds map lerp(-10, 10, rollFloat) to letter grades. */
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

function inverseLerp(a: number, b: number, v: number): number {
  if (b === a) return 0;
  return (v - a) / (b - a);
}

export function floatToGrade(rollFloat: number, isCurse: boolean): string {
  const f = isCurse ? 1 - rollFloat : rollFloat;
  const score = lerp(-10, 10, f);
  for (const { min, grade } of GRADE_THRESHOLDS) {
    if (score >= min) return grade;
  }
  return "F";
}

/** Inverts RivenParser.js's buff formula for percentage or raw special-stat values.
 * Forward: base * (1.5*disp*10) * 1.25^curses * lerp(0.9,1.1,roll) * buffsAtten * (lvl+1). */
export function unparseBuff(
  displayedValue: number,
  baseValue: number,
  disposition: number,
  numBuffs: number,
  numCurses: number,
  tag?: string,
  lvl: number = MAX_RIVEN_MOD_RANK,
): number {
  const buffsAtten = NUM_BUFFS_ATTEN[Math.min(numBuffs, NUM_BUFFS_ATTEN.length - 1)];
  const curseAtten = Math.pow(1.25, numCurses);
  const attenuation = SPECIFIC_FIT_ATTEN * disposition * BASE_DRAIN;

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
  // OCR values are unsigned; abs(baseValue) handles negative-base stats such as recoil.
  value /= Math.abs(baseValue);

  // value is now lerp(0.9, 1.1, rollFloat) -> invert
  return (value - 0.9) / 0.2;
}

/** Inverts RivenParser.js's curse formula after OCR has removed the displayed sign.
 * Forward: -base * (1.5*disp*10) * lerp(0.9,1.1,roll) * curseAtten * buffsAtten * (lvl+1). */
export function unparseCurse(
  displayedValue: number,
  baseValue: number,
  disposition: number,
  numBuffs: number,
  numCurses: number,
  tag?: string,
  lvl: number = MAX_RIVEN_MOD_RANK,
): number {
  const attenuation = SPECIFIC_FIT_ATTEN * disposition * BASE_DRAIN;
  // Note the swapped indexing: buffs table by curse count, curse table by buff count
  const cursesInBuffTable = NUM_BUFFS_ATTEN[Math.min(numCurses, NUM_BUFFS_ATTEN.length - 1)];
  const buffsInCurseTable =
    NUM_BUFFS_CURSE_ATTEN[Math.min(numBuffs, NUM_BUFFS_CURSE_ATTEN.length - 1)];

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

  return (value - 0.9) / 0.2;
}

interface ScannedStat {
  name: string;
  positive: boolean;
  displayPositive?: boolean;
  value: number | null;
  multiplier?: boolean;
}

// Sibling tags an OCR-garbled stat name can be: "+190.2% Critical Damage" on a
// melee is really Melee Damage.
const STAT_CONFUSION_SIBLINGS: Record<string, string[]> = {
  WeaponDamageAmountMod: ["WeaponMeleeDamageMod", "WeaponCritDamageMod"],
  WeaponMeleeDamageMod: ["WeaponDamageAmountMod", "WeaponCritDamageMod"],
  WeaponCritDamageMod: ["WeaponMeleeDamageMod", "WeaponDamageAmountMod"],
  WeaponCritChanceMod: ["SlideAttackCritChanceMod", "WeaponStunChanceMod"],
  SlideAttackCritChanceMod: ["WeaponCritChanceMod"],
  WeaponStunChanceMod: ["WeaponCritChanceMod"],
};

// Riven type data lists both damage tags with identical bases; cards use one by class.
function weaponDamageTag(tag: string, isMelee: boolean): string {
  if (isMelee && tag === "WeaponDamageAmountMod") return "WeaponMeleeDamageMod";
  if (!isMelee && tag === "WeaponMeleeDamageMod") return "WeaponDamageAmountMod";
  return tag;
}

// Display values round to 0.1%, so a legitimate min/max roll can sit a hair outside [0,1].
const FIT_TOLERANCE = 0.02;
const CORRECTION_MISFIT_THRESHOLD = 0.1;

// A riven card carries at most three buffs and one curse.
const MAX_RIVEN_BUFFS = 3;
const MAX_RIVEN_CURSES = 1;

// Both counts scale every displayed value, so an OCR line the scan dropped reads
// the survivors high; the scanned counts are a lower bound.
function plausibleStatCounts(numBuffs: number, numCurses: number): [number, number][] {
  const counts: [number, number][] = [];
  for (let buffs = numBuffs; buffs <= Math.max(numBuffs, MAX_RIVEN_BUFFS); buffs++) {
    for (let curses = numCurses; curses <= Math.max(numCurses, MAX_RIVEN_CURSES); curses++) {
      counts.push([buffs, curses]);
    }
  }
  return counts;
}

export function correctScannedStats(
  weaponName: string,
  stats: ScannedStat[],
): { stats: ScannedStat[]; corrections: number } {
  const baseDisposition = rivenData.getWeaponDisposition(weaponName);
  const rivenTypeKey = rivenData.resolveRivenType(weaponName);
  if (baseDisposition == null || !rivenTypeKey || stats.length === 0) {
    return { stats, corrections: 0 };
  }

  const isMelee = rivenData.isMeleeWeapon(weaponName);
  const statCounts = plausibleStatCounts(
    stats.filter((s) => s.positive).length,
    stats.filter((s) => !s.positive).length,
  );
  const dispositions = [
    baseDisposition,
    ...rivenData.getFamilyVariants(weaponName).map((v) => v.disposition),
  ];

  // Null when the tag cannot roll on this weapon at all.
  const violationFor = (tag: string, stat: ScannedStat, displayedValue: number): number | null => {
    const entry = rivenData.findUpgradeEntry(rivenTypeKey, tag);
    if (!entry) return null;
    // New ExportUpgrades records omit direction flags, so only reject explicit false values.
    if (stat.positive ? entry.canBeBuff === false : entry.canBeCurse === false) return null;
    let best = Infinity;
    for (const disp of dispositions) {
      for (const [numBuffs, numCurses] of statCounts) {
        // A chat-linked card shows its values at the mod's own rank, not max.
        for (let lvl = 0; lvl <= MAX_RIVEN_MOD_RANK; lvl++) {
          const f = stat.positive
            ? unparseBuff(displayedValue, entry.baseValue, disp, numBuffs, numCurses, tag, lvl)
            : unparseCurse(displayedValue, entry.baseValue, disp, numBuffs, numCurses, tag, lvl);
          best = Math.min(best, Math.max(0, f - 1) + Math.max(0, -f));
        }
      }
    }
    return best;
  };

  let corrections = 0;

  const measured = stats.map((original) => {
    const scannedTag = rivenData.statNameToTag(original.name);
    let stat = original;
    let tag = scannedTag;
    let renamedFrom: string | null = null;
    if (tag) {
      const normalizedTag = weaponDamageTag(tag, isMelee);
      if (normalizedTag !== tag) {
        renamedFrom = stat.name;
        stat = { ...stat, name: rivenData.getStatDisplayName(normalizedTag, isMelee) };
        tag = normalizedTag;
      }
    }

    const value = stat.value;
    if (tag == null || value == null || !Number.isFinite(value) || stat.multiplier) {
      return { original, stat, renamedFrom, tag, value: null, violation: null, misfits: false };
    }
    const violation = violationFor(tag, stat, value);
    return {
      original,
      stat,
      renamedFrom,
      tag,
      value,
      violation,
      misfits: violation == null || violation > CORRECTION_MISFIT_THRESHOLD,
    };
  });

  const misfitting = measured.filter((m) => m.misfits);
  if (misfitting.length > 1) {
    const detail = misfitting
      .map(
        (m) =>
          `"${m.original.name}" ${m.violation == null ? "cannot roll" : m.violation.toFixed(3)}`,
      )
      .join(", ");
    log.warn(
      `[RivenGrade] ${misfitting.length} of ${measured.length} stats are out of range for ` +
        `"${weaponName}" (${detail}) - weapon or disposition is wrong, keeping the scanned names`,
    );
    return { stats: measured.map((m) => m.original), corrections };
  }

  for (const m of measured) {
    if (!m.renamedFrom) continue;
    log.info(
      `[RivenGrade] "${m.renamedFrom}" cannot roll on "${weaponName}" - renamed "${m.stat.name}"`,
    );
    corrections++;
  }

  const corrected = measured.map(({ stat, tag, value, violation, misfits }) => {
    if (!misfits || tag == null || value == null) return stat;

    const siblings = STAT_CONFUSION_SIBLINGS[tag] ?? [];
    const fitTags = [
      ...new Set(siblings.map((sibling) => weaponDamageTag(sibling, isMelee))),
    ].filter((sibling) => {
      if (sibling === tag) return false;
      const v = violationFor(sibling, stat, value);
      return v != null && v <= FIT_TOLERANCE;
    });

    if (fitTags.length === 1) {
      const newName = rivenData.getStatDisplayName(fitTags[0], isMelee);
      log.info(
        `[RivenGrade] "${stat.name}" ${stat.positive ? "+" : "-"}${value} misfits ` +
          `"${weaponName}" - corrected to "${newName}"`,
      );
      corrections++;
      return { ...stat, name: newName };
    }

    if (violation != null) {
      log.info(
        `[RivenGrade] "${stat.name}" ${stat.positive ? "+" : "-"}${value} is out of ` +
          `range for "${weaponName}" (violation ${violation.toFixed(3)}) - kept as scanned`,
      );
    }
    return stat;
  });

  return { stats: corrected, corrections };
}

type AlecaAttrGrade = "Decisive" | "Good" | "NotHelping" | "Bad";

function gradeFromGoodRolls(
  data: GoodRollData,
  goodTags: string[],
  badTags: string[],
): { positive: AlecaAttrGrade[]; negative: AlecaAttrGrade[]; overall: string } {
  const positive: AlecaAttrGrade[] = goodTags.map(() => "NotHelping");
  const negative: AlecaAttrGrade[] = badTags.map(() => "NotHelping");

  for (let i = 0; i < badTags.length; i++) {
    const tag = badTags[i];
    if (data.acceptedBadAttrs.includes(tag)) {
      negative[i] = "Good";
    } else if (data.goodAttrs.some((g) => g.mandatory.includes(tag) || g.optional.includes(tag))) {
      negative[i] = "Bad";
    } else {
      negative[i] = "NotHelping";
    }
  }

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

/** Scores 44bananas' per-weapon good-roll data; unknown weapons return "?". */
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

/** `modRank` is the rank a warframe.market listing states, dropped again when the
 *  values contradict it. */
export function gradeRiven(
  weaponName: string,
  stats: {
    name: string;
    positive: boolean;
    displayPositive?: boolean;
    value: number | null;
    multiplier?: boolean;
  }[],
  modRank?: number | null,
): RivenGradeResult | null {
  if (!stats || stats.length === 0) return null;

  const baseDisposition = rivenData.getWeaponDisposition(weaponName);
  if (baseDisposition == null) {
    log.warn(`[RivenGrade] Weapon not found: "${weaponName}"`);
    return null;
  }

  const rivenTypeKey = rivenData.resolveRivenType(weaponName);
  if (!rivenTypeKey) {
    log.warn(`[RivenGrade] No riven type for weapon: "${weaponName}"`);
    return null;
  }

  const numBuffs = stats.filter((s) => s.positive).length;
  const numCurses = stats.filter((s) => !s.positive).length;
  const statedRank =
    modRank != null && Number.isInteger(modRank) && modRank >= 0 && modRank <= MAX_RIVEN_MOD_RANK
      ? modRank
      : null;
  let assumedLevel = statedRank ?? MAX_RIVEN_MOD_RANK;
  let assumedBuffs = numBuffs;
  let assumedCurses = numCurses;

  if (numBuffs > 3 || numCurses > 1) {
    log.warn(
      `[RivenGrade] impossible stat shape (${numBuffs} buffs / ${numCurses} curses) - skipping grade`,
    );
    return null;
  }

  const prepared = stats.map((stat) => {
    const tag = rivenData.statNameToTag(stat.name);
    const entry = tag ? rivenData.findUpgradeEntry(rivenTypeKey, tag) : null;
    const isFraction = !!tag && NON_PERCENTAGE_TAGS.has(tag);
    let displayedValue: number | null = null;
    // Half a display step: the card shows one decimal, two for an x-multiplier.
    let halfStep = 0.05;
    if (stat.value != null && Number.isFinite(stat.value)) {
      if (stat.multiplier) {
        // "x1.05" is a +0.05 multiplier, and faction damage is a non-percentage tag
        // whose displayed value IS that fraction (browse.wf: "0.05 to 0.06 Damage to Corpus").
        const fraction = stat.positive ? stat.value - 1 : 1 - stat.value;
        displayedValue = isFraction ? fraction : fraction * 100;
        halfStep = isFraction ? 0.005 : 0.5;
      } else {
        displayedValue = stat.value;
      }
    }
    return { stat, tag, entry, displayedValue, halfStep };
  });

  type Prepared = (typeof prepared)[number];
  const rawFloatAt = (
    p: Prepared,
    disp: number,
    lvl: number,
    buffs: number,
    curses: number,
    value: number = p.displayedValue!,
  ): number =>
    p.stat.positive
      ? unparseBuff(value, p.entry!.baseValue, disp, buffs, curses, p.tag!, lvl)
      : unparseCurse(value, p.entry!.baseValue, disp, buffs, curses, p.tag!, lvl);

  // Wolf Sledge Range spans 0.2 to 0.3 metres at rank 0, so half a display step is
  // half the roll: ask whether the rounding interval can reach [0,1].
  const fitsAt = (
    p: Prepared,
    disp: number,
    lvl: number,
    buffs: number,
    curses: number,
  ): boolean => {
    const a = rawFloatAt(p, disp, lvl, buffs, curses, p.displayedValue! - p.halfStep);
    const b = rawFloatAt(p, disp, lvl, buffs, curses, p.displayedValue! + p.halfStep);
    return Math.min(a, b) <= 1 + FIT_TOLERANCE && Math.max(a, b) >= -FIT_TOLERANCE;
  };

  // The roll screen names the family but uses the linked variant's disposition, and a
  // chat-linked mod shows its values at its own rank: an unranked card reads 1/9 of max.
  let disposition = baseDisposition;
  const gradeable = prepared.filter((p) => p.tag && p.entry && p.displayedValue != null);
  if (gradeable.length > 0) {
    const violationAt = (disp: number, lvl: number, buffs: number, curses: number): number =>
      gradeable.reduce((sum, p) => {
        const f = rawFloatAt(p, disp, lvl, buffs, curses);
        return sum + Math.max(0, f - 1) + Math.max(0, -f);
      }, 0);
    const allFitAt = (disp: number, lvl: number, buffs: number, curses: number): boolean =>
      gradeable.every((p) => fitsAt(p, disp, lvl, buffs, curses));

    if (!allFitAt(disposition, assumedLevel, assumedBuffs, assumedCurses)) {
      const candidates = [
        { name: weaponName, disposition: baseDisposition },
        ...rivenData.getFamilyVariants(weaponName),
      ];

      // Two stats are needed to pin a rank; a lone value fits several.
      const searchLvls =
        gradeable.length >= 2
          ? Array.from({ length: MAX_RIVEN_MOD_RANK + 1 }, (_, index) => MAX_RIVEN_MOD_RANK - index)
          : [];
      const refitLvls =
        statedRank != null
          ? [statedRank, ...searchLvls.filter((lvl) => lvl !== statedRank)]
          : searchLvls;
      type Refit = {
        name: string;
        disposition: number;
        lvl: number;
        buffs: number;
        curses: number;
      };
      const refitAt = (buffs: number, curses: number): Refit | null => {
        for (const lvl of refitLvls) {
          let best: Refit | null = null;
          for (const candidate of candidates) {
            if (!allFitAt(candidate.disposition, lvl, buffs, curses)) continue;
            const closer =
              !best ||
              Math.abs(candidate.disposition - baseDisposition) <
                Math.abs(best.disposition - baseDisposition);
            if (closer) best = { ...candidate, lvl, buffs, curses };
          }
          if (best) return best;
        }
        return null;
      };

      let refit: Refit | null = null;
      for (const [buffs, curses] of plausibleStatCounts(numBuffs, numCurses)) {
        refit = refitAt(buffs, curses);
        if (refit) break;
      }

      if (refit) {
        if (refit.disposition !== disposition) {
          log.info(
            `[RivenGrade] "${weaponName}" dispo misfits the rolled values - grading as "${refit.name}"`,
          );
          disposition = refit.disposition;
        }
        if (refit.lvl !== assumedLevel) {
          log.info(
            `[RivenGrade] "${weaponName}" values match rank ${refit.lvl} - grading at that rank`,
          );
          assumedLevel = refit.lvl;
        }
        if (refit.buffs !== assumedBuffs || refit.curses !== assumedCurses) {
          log.info(
            `[RivenGrade] "${weaponName}" values match ${refit.buffs} buffs / ${refit.curses} ` +
              `curses - grading as a card the scan read short`,
          );
          assumedBuffs = refit.buffs;
          assumedCurses = refit.curses;
        }
      } else {
        let best = {
          name: weaponName,
          disposition,
          buffs: assumedBuffs,
          curses: assumedCurses,
          violation: violationAt(disposition, assumedLevel, assumedBuffs, assumedCurses),
        };
        for (const [buffs, curses] of plausibleStatCounts(numBuffs, numCurses)) {
          for (const variant of candidates) {
            const violation = violationAt(variant.disposition, assumedLevel, buffs, curses);
            const closer =
              Math.abs(variant.disposition - baseDisposition) <
              Math.abs(best.disposition - baseDisposition);
            if (
              violation < best.violation - 1e-9 ||
              (violation < best.violation + 1e-9 && closer)
            ) {
              best = {
                name: variant.name,
                disposition: variant.disposition,
                buffs,
                curses,
                violation,
              };
            }
          }
        }
        if (best.disposition !== disposition) {
          log.info(
            `[RivenGrade] "${weaponName}" dispo misfits the rolled values - grading as "${best.name}"`,
          );
          disposition = best.disposition;
        }
        if (best.buffs !== assumedBuffs || best.curses !== assumedCurses) {
          log.info(
            `[RivenGrade] "${weaponName}" sits closest to ${best.buffs} buffs / ${best.curses} ` +
              `curses - grading as a card the scan read short`,
          );
          assumedBuffs = best.buffs;
          assumedCurses = best.curses;
        }
      }
    }
  }

  const gradedStats: GradedStat[] = [];
  let scoreSum = 0;
  let scoredCount = 0;
  let scoredBuffs = 0;
  let clampedBuffs = 0;

  for (const p of prepared) {
    const { stat, tag, entry } = p;
    if (!tag || !entry) {
      if (!tag) log.debug(`[RivenGrade] Unknown stat: "${stat.name}" - assigning B grade`);
      else
        log.debug(`[RivenGrade] Tag "${tag}" not in riven type ${rivenTypeKey.split("/").pop()}`);
      gradedStats.push({
        ...stat,
        grade: "B",
        rollFloat: 0.5,
      });
      scoreSum += 0; // lerp(-10, 10, 0.5) = 0
      scoredCount++;
      continue;
    }

    if (p.displayedValue != null) {
      const rollFloat = clamp01(
        rawFloatAt(p, disposition, assumedLevel, assumedBuffs, assumedCurses),
      );
      const grade = floatToGrade(rollFloat, !stat.positive);
      const score = lerp(-10, 10, !stat.positive ? 1 - rollFloat : rollFloat);

      gradedStats.push({
        ...stat,
        grade,
        rollFloat,
      });
      if (stat.positive) {
        scoredBuffs++;
        if (rollFloat === 0 || rollFloat === 1) clampedBuffs++;
      }
      scoreSum += score;
      scoredCount++;
    } else {
      gradedStats.push({
        ...stat,
        grade: "?",
        rollFloat: 0.5,
      });
    }
  }

  // Every buff pinned to the edge of its range contradicts the graded rank; a quarter
  // of the unranked listings carry max-rank rolls.
  if (statedRank != null && scoredBuffs > 0 && clampedBuffs === scoredBuffs) {
    const searched = gradeRiven(weaponName, stats);
    if (searched) return searched;
  }

  let overallGrade = "?";
  if (scoredCount > 0) {
    const avgScore = scoreSum / scoredCount;
    const avgFloat = inverseLerp(-10, 10, avgScore);
    overallGrade = floatToGrade(avgFloat, false);
  }

  const attributeGrade = computeAttributeGrade(stats, weaponName);

  return { stats: gradedStats, overallGrade, attributeGrade };
}
