"use strict";

import type { StructuredOcrLine, StructuredOcrResult } from "../../services/ocrServer";
import { levenshteinDistance } from "../../services/rewardScannerUtils";
import * as rivenData from "../../services/rivenData";
import * as rivenGrading from "../../services/rivenGrading";

const RIVEN_STAT_ALIAS_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = Object.freeze([
  [/Dannage/gi, "Damage"],
  [/Darnage/gi, "Damage"],
  [/Darnoge/gi, "Damage"],
  [/Crit\s*ical/gi, "Critical"],
  [/Cri tical/gi, "Critical"],
  [/Critica\b/gi, "Critical"],
  [/Multi\s*shot/gi, "Multishot"],
  [/Sta tus/gi, "Status"],
  [/Statuc/gi, "Status"],
  [/Re load/gi, "Reload"],
  [/Elec tricity/gi, "Electricity"],
  [/Punc ture/gi, "Puncture"],
  [/Maga zine/gi, "Magazine"],
  [/Capaclty/gi, "Capacity"],
  [/Maxinnunn/gi, "Maximum"],
  [/Annnno/gi, "Ammo"],
  [/Mel[ae]e/gi, "Melee"],
  [/Fini sher/gi, "Finisher"],
  [/Finlsher/gi, "Finisher"],
  [/[>]?[lh]mpact/gi, "Impact"],
  [/\bG[Ll]ash\b/gi, "Slash"],
  [/\b\(Glash\b/gi, "Slash"],
  [/\bY\s*Puncture\b/gi, "Puncture"],
  [/\bA\s*Slash\b/gi, "Slash"],
  [/\bO\s*Cold\b/gi, "Cold"],
  [/\bO\s*Heat\b/gi, "Heat"],
  [/\bl\s*eat\b/gi, "Heat"],
  [/\bQ\s*Toxin\b/gi, "Toxin"],
  [/\bQ\s*Electricity\b/gi, "Electricity"],
]);

const KNOWN_RIVEN_STATS: ReadonlyArray<string> = Object.freeze([
  "Additional Combo Count Chance",
  "Chance to Gain Combo Count",
  "Critical Chance for Slide Attack",
  "Heavy Attack Efficiency",
  "Magazine Capacity",
  "Damage to Grineer",
  "Damage to Corpus",
  "Damage to Infested",
  "Critical Chance",
  "Critical Damage",
  "Finisher Damage",
  "Melee Damage",
  "Weapon Recoil",
  "Status Duration",
  "Status Chance",
  "Projectile Speed",
  "Reload Speed",
  "Attack Speed",
  "Flight Speed",
  "Fire Rate",
  "Punch Through",
  "Combo Duration",
  "Initial Combo",
  "Ammo Maximum",
  "Heavy Attack",
  "Channeling Damage",
  "Channeling Efficiency",
  "Multishot",
  "Electricity",
  "Corrosive",
  "Radiation",
  "Magnetic",
  "Cold",
  "Heat",
  "Toxin",
  "Viral",
  "Blast",
  "Gas",
  "Impact",
  "Puncture",
  "Slash",
  "Magazine",
  "Recoil",
  "Damage",
  "Range",
  "Slide",
  "Zoom",
]);

export interface RivenStat {
  name: string;
  positive: boolean;
  value: number | null;
  multiplier?: boolean;
}

const MAX_REASONABLE_VALUE = 500;

export function preprocessOcrText(raw: string): string {
  let text = raw;

  // Re-join two-word stat names that WinRT OCR splits across lines.
  // The riven card UI places a coloured icon between the stat sign/value and
  // the name, causing the OCR layout engine to emit the first word on one line
  // and "Damage" / "Chance" / etc. on the next.  Fix before any other processing
  // so the stat names are intact for all subsequent logic.
  text = text.replace(/\bFinisher\s*\n+\s*(?=Damage\b)/gi, "Finisher ");
  text = text.replace(/\bMelee\s*\n+\s*(?=Damage\b)/gi, "Melee ");
  text = text.replace(/\bCritical\s*\n+\s*(?=(?:Chance|Damage)\b)/gi, "Critical ");
  text = text.replace(/\bStatus\s*\n+\s*(?=(?:Chance|Duration)\b)/gi, "Status ");
  text = text.replace(/\bAttack\s*\n+\s*(?=Speed\b)/gi, "Attack ");
  text = text.replace(/\bReload\s*\n+\s*(?=Speed\b)/gi, "Reload ");
  text = text.replace(/\bFlight\s*\n+\s*(?=Speed\b)/gi, "Flight ");
  text = text.replace(/\bProjectile\s*\n+\s*(?=Speed\b)/gi, "Projectile ");
  text = text.replace(/\bFire\s*\n+\s*(?=Rate\b)/gi, "Fire ");
  text = text.replace(/\bCombo\s*\n+\s*(?=(?:Duration|Count)\b)/gi, "Combo ");
  text = text.replace(/\bAmmo\s*\n+\s*(?=Maximum\b)/gi, "Ammo ");
  text = text.replace(/\bPunch\s*\n+\s*(?=Through\b)/gi, "Punch ");
  text = text.replace(/\bChanneling\s*\n+\s*(?=(?:Damage|Efficiency)\b)/gi, "Channeling ");
  text = text.replace(/\bWeapon\s*\n+\s*(?=Recoil\b)/gi, "Weapon ");
  text = text.replace(/\bHeavy\s*\n+\s*(?=Attack\b)/gi, "Heavy ");
  text = text.replace(/\bInitial\s*\n+\s*(?=Combo\b)/gi, "Initial ");
  text = text.replace(/\bMagazine\s*\n+\s*(?=Capacity\b)/gi, "Magazine ");
  text = text.replace(/\bDamage\s*\n+\s*(?=to\s+(?:Grineer|Corpus|Infested)\b)/gi, "Damage ");
  text = text.replace(/\bto\s*\n+\s*(?=(?:Grineer|Corpus|Infested)\b)/gi, "to ");
  text = text.replace(/0\/0/g, "%");
  text = text.replace(/O\/O/gi, "%");
  text = text.replace(/o\/o/g, "%");
  text = text.replace(/(\d)\s*Z\b/g, "$1%");
  text = text.replace(/\bx\s*O([.,]\d)/gi, "x0$1");
  // Fix xl/xI misread: WinRT OCR reads "x1" as "xl" (lowercase L) or "xI" (capital i).
  // e.g. "xl,56 Damage to Corpus" → "x1,56 Damage to Corpus" before comma→dot pass.
  // Also handle spaced variants where WinRT separates the parts:
  // "x I , 44 Damage to Grineer" → "x1.44 Damage to Grineer".
  text = text.replace(/\bx\s+[lI1]\s*[,.]\s*(\d+)/gi, "x1.$1");
  text = text.replace(/\bx\s+[lI1]\b/gi, "x1");
  text = text.replace(/\bx[lI]([,.]?\d)/g, "x1$1");
  text = text.replace(/\bx[lI]\b/g, "x1");
  // Collapse spaced decimal on multiplier: "x1 , 44" or "x1 ,44" → "x1.44".
  text = text.replace(/\bx(\d)\s*,\s*(\d+)/g, "x$1.$2");
  text = text.replace(/,(\d)/g, ".$1");
  text = text.replace(/(\d)\s([1-9])\s*%/g, "$1.$2%");

  for (let pass = 0; pass < 5; pass++) {
    text = text.replace(/([+\-\u2013]\s*\d+)\s+(\d)/g, "$1$2");
  }

  for (let pass = 0; pass < 5; pass++) {
    text = text.replace(/(\d)\s+(\d)/g, "$1$2");
  }

  text = text.replace(/(\d)[A-Za-z](\d)/g, "$1$2");
  for (let pass = 0; pass < 3; pass++) {
    text = text.replace(/(\d)\s+(\d)/g, "$1$2");
  }

  for (const [pattern, replacement] of RIVEN_STAT_ALIAS_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }

  text = text.replace(/\(x\d+\s*(?:for\s*)?Heavy\s*Attack[a-z]*\)/gi, "");
  text = text.replace(/\(\s*(\d+[.,]\d+)/g, "x$1");
  text = text.replace(/[*()\[\]{}|\\<>^~°©®™•→←↑↓↗↘►◄▸▾▲▼■□●○]+\s*/g, " ");
  text = text.replace(/\bx\d+\s*(?:for\s*)?Heavy\s*Attack[a-z]*\b/gi, "");
  text = text.replace(/%\s+[A-Z0-9]\s+(?=[A-Z])/g, "% ");
  text = text.replace(
    /[0-9'"`]\s*(?=(?:Slash|Cold|Heat|Electricity|Toxin|Impact|Puncture|Radiation|Viral|Corrosive|Blast|Magnetic|Gas)\b)/gi,
    "",
  );
  text = text.replace(
    /\b[A-Z]\s+(?=(?:Slash|Cold|Heat|Electricity|Toxin|Impact|Puncture|Radiation|Viral|Corrosive|Blast|Magnetic|Gas)\b)/g,
    "",
  );
  text = text.replace(
    /[^\w\s+.%\-x]{1,3}\s+(?=(?:Slash|Cold|Heat|Electricity|Toxin|Impact|Puncture|Radiation|Viral|Corrosive|Blast|Magnetic|Gas)\b)/gi,
    "",
  );
  text = text.replace(
    /Critical\s+Chance[^a-zA-Z]{0,20}for\s+Slide\s+Attack/gi,
    "Critical Chance for Slide Attack",
  );
  text = text.replace(/(\d)s(?=\s|$)/g, "$1");
  text = text.replace(/\s+([+\-\u2013]\d)/g, "\n$1");
  text = text.replace(/\s+(x\d)/gi, "\n$1");

  return text;
}

export function sanitiseValue(value: number): number {
  if (value > MAX_REASONABLE_VALUE && Number.isInteger(value) && value >= 100) {
    const str = String(value);
    const corrected = parseFloat(str.slice(0, -1) + "." + str.slice(-1));
    if (Number.isFinite(corrected)) return corrected;
  }
  return value;
}

export function extractSignAndValue(
  fragment: string,
): { positive: boolean; value: number | null; multiplier?: boolean } | null {
  const signMatches = [...fragment.matchAll(/[+\-\u2013](?=\s*\d)/g)];
  const lastSign = signMatches.at(-1);
  const positive = !lastSign || (lastSign[0] !== "-" && lastSign[0] !== "\u2013");

  const percentMatches = [...fragment.matchAll(/(\d+\.?\d*)\s*%/g)];
  if (percentMatches.length > 0) {
    const parsed = parseFloat(percentMatches[percentMatches.length - 1][1]);
    if (Number.isFinite(parsed)) return { positive, value: sanitiseValue(parsed) };
  }

  const xMultiplier = [...fragment.matchAll(/x\s*(\d+\.?\d*)/gi)];
  if (xMultiplier.length > 0) {
    const parsed = parseFloat(xMultiplier[xMultiplier.length - 1][1]);
    if (Number.isFinite(parsed)) return { positive: parsed >= 1, value: parsed, multiplier: true };
  }

  const numAfterSign = [...fragment.matchAll(/[+\-\u2013]\s*(\d+\.?\d*)/g)];
  if (numAfterSign.length > 0) {
    const parsed = parseFloat(numAfterSign[numAfterSign.length - 1][1]);
    if (Number.isFinite(parsed)) return { positive, value: sanitiseValue(parsed) };
  }

  if (signMatches.length > 0 || xMultiplier.length > 0) return { positive, value: null };
  return null;
}

export function parseRivenStats(text: string): RivenStat[] {
  if (!text) return [];

  const cleaned = preprocessOcrText(text);
  const lineResults = parseStatsFromLines(cleaned);
  if (lineResults.length > 0 && lineResults.some((stat) => stat.value !== null)) {
    return lineResults;
  }

  const blob = cleaned.replace(/\r?\n/g, " ");
  const blobResults = parseStatsFromLines(blob);
  const lineScore = lineResults.reduce((score, stat) => score + (stat.value !== null ? 10 : 3), 0);
  const blobScore = blobResults.reduce((score, stat) => score + (stat.value !== null ? 10 : 3), 0);
  return blobScore > lineScore ? blobResults : lineResults;
}

function normalizeStructuredLines(
  result: StructuredOcrResult | null | undefined,
): StructuredOcrLine[] {
  if (!result?.lines?.length) return [];
  return result.lines
    .map((line, index) => ({ ...line, _index: index }))
    .filter((line) => String(line.text || "").trim().length > 0)
    .sort((a, b) => {
      const topDelta = Math.abs((a.box?.top || 0) - (b.box?.top || 0));
      if (topDelta > 6) return (a.box?.top || 0) - (b.box?.top || 0);
      return (a.box?.left || 0) - (b.box?.left || 0);
    });
}

function lineContainsKnownStat(line: string): boolean {
  const lineLower = line.toLowerCase();
  return KNOWN_RIVEN_STATS.some((stat) => lineLower.includes(stat.toLowerCase()));
}

function isStructuredStatLine(line: string): boolean {
  const cleaned = preprocessOcrText(line);
  if (lineContainsKnownStat(cleaned)) return true;
  const extracted = extractSignAndValue(cleaned);
  return !!(extracted && (extracted.value !== null || /x\s*\d/i.test(cleaned)));
}

function isStructuredFooterLine(line: string): boolean {
  return /\b(?:MR\s*\d+|FITS\s+IN|Remaining\s+Kuva|ROLL\s*\d+)\b/i.test(line);
}

export function splitRivenStructuredText(result: StructuredOcrResult | null | undefined): {
  titleText: string;
  statsText: string;
  footerText: string;
  mergedText: string;
} {
  const lines = normalizeStructuredLines(result);
  if (lines.length === 0) {
    const text = result?.text || "";
    return { titleText: text, statsText: text, footerText: "", mergedText: text };
  }

  const statEntries = lines.filter((line) => isStructuredStatLine(line.text));
  const firstStatTop = statEntries.length > 0 ? Number(statEntries[0].box?.top || 0) : null;
  const lastStatTop =
    statEntries.length > 0 ? Number(statEntries[statEntries.length - 1].box?.top || 0) : null;
  const sortedHeights = lines
    .map((line) => Math.max(1, Number(line.box?.height || 0)))
    .sort((a, b) => a - b);
  const medianHeight = sortedHeights[Math.floor(sortedHeights.length / 2)] || 12;

  const titleLines: string[] = [];
  const statLines: string[] = [];
  const footerLines: string[] = [];

  for (const line of lines) {
    const text = String(line.text || "").trim();
    if (!text) continue;
    const top = Number(line.box?.top || 0);

    if (isStructuredFooterLine(text)) {
      footerLines.push(text);
      continue;
    }

    if (firstStatTop != null) {
      if (top + medianHeight < firstStatTop && !isStructuredStatLine(text)) {
        titleLines.push(text);
        continue;
      }
      if (lastStatTop != null && top > lastStatTop + medianHeight * 1.5) {
        footerLines.push(text);
        continue;
      }
    }

    if (isStructuredStatLine(text) || titleLines.length > 0 || firstStatTop == null) {
      statLines.push(text);
    } else {
      titleLines.push(text);
    }
  }

  const titleText = titleLines.join("\n").trim();
  const statsText = statLines.join("\n").trim() || result?.text || "";
  const footerText = footerLines.join("\n").trim();
  const mergedText = [titleText, statsText, footerText].filter(Boolean).join("\n");

  return { titleText, statsText, footerText, mergedText };
}

function collapseOrphanValueLines(lines: string[]): string[] {
  const collapsed: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index].trim();
    if (!current) continue;

    const extracted = extractSignAndValue(current);
    const looksLikeValueOnly =
      !!extracted &&
      extracted.value !== null &&
      !lineContainsKnownStat(current) &&
      /^[+\-\u2013x\d\s.%]+$/i.test(current);

    if (!looksLikeValueOnly) {
      collapsed.push(current);
      continue;
    }

    let nextIndex = index + 1;
    while (nextIndex < lines.length && !lines[nextIndex].trim()) nextIndex += 1;
    if (nextIndex >= lines.length) {
      collapsed.push(current);
      continue;
    }

    const next = lines[nextIndex].trim();
    collapsed.push(`${current} ${next}`.trim());
    index = nextIndex;
  }

  return collapsed;
}

// Riven damage-type stats that can appear combined on a single roll without
// their own value (e.g. "+112% Electricity Impact" = one slot giving both).
// When such a stat has no value but the PREVIOUS stat in the same OCR line does,
// we carry the value forward rather than leaving it null.
const DAMAGE_TYPE_STAT_NAMES: ReadonlySet<string> = new Set([
  "electricity",
  "corrosive",
  "radiation",
  "magnetic",
  "cold",
  "heat",
  "toxin",
  "viral",
  "blast",
  "gas",
  "impact",
  "puncture",
  "slash",
]);

function parseStatsFromLines(text: string): RivenStat[] {
  const lines = collapseOrphanValueLines(text.split(/\r?\n/));
  const results: RivenStat[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const lineLower = line.toLowerCase();

    const hits: Array<{ stat: string; idx: number }> = [];
    for (const stat of KNOWN_RIVEN_STATS) {
      const idx = lineLower.indexOf(stat.toLowerCase());
      if (idx !== -1) hits.push({ stat, idx });
    }
    if (hits.length === 0) continue;

    hits.sort((a, b) => a.idx - b.idx || b.stat.length - a.stat.length);
    const filtered: typeof hits = [];
    let lastEnd = -1;
    for (const hit of hits) {
      if (hit.idx >= lastEnd) {
        filtered.push(hit);
        lastEnd = hit.idx + hit.stat.length;
      }
    }

    for (let index = 0; index < filtered.length; index++) {
      const { stat, idx } = filtered[index];
      const key = stat.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const prefixStart = index > 0 ? filtered[index - 1].idx + filtered[index - 1].stat.length : 0;
      const prefix = line.slice(prefixStart, idx);
      let extracted = extractSignAndValue(prefix);

      if (!extracted || extracted.value === null) {
        const suffixEnd = index + 1 < filtered.length ? filtered[index + 1].idx : line.length;
        const suffix = line.slice(idx + stat.length, suffixEnd);
        const suffixExtracted = extractSignAndValue(suffix);
        if (suffixExtracted && suffixExtracted.value !== null) {
          extracted = suffixExtracted;
        }
      }

      const positive = extracted?.positive ?? true;
      let value = extracted?.value ?? null;
      let effectivePositive = positive;
      const multiplier = extracted?.multiplier ?? false;

      // Carry-forward: when a damage-type stat has no value but the previous
      // stat in the SAME line segment does, they share a single combined roll
      // (e.g. "+112% Electricity Impact" → Impact inherits 112% from Electricity).
      if (value === null && index > 0 && DAMAGE_TYPE_STAT_NAMES.has(key)) {
        const prev = results[results.length - 1];
        if (prev && prev.value !== null) {
          value = prev.value;
          effectivePositive = prev.positive;
        }
      }

      results.push({ name: stat, positive: effectivePositive, value, ...(multiplier && { multiplier: true }) });
    }
  }

  return results;
}

function countMappedStats(stats: RivenStat[], weaponName: string): number {
  const rivenType = rivenData.resolveRivenType(weaponName);
  if (!rivenType) return 0;

  let mapped = 0;
  for (const stat of stats) {
    const tag = rivenData.statNameToTag(stat.name);
    if (!tag) continue;
    if (rivenData.findUpgradeEntry(rivenType, tag)) mapped += 1;
  }
  return mapped;
}

function extractRivenTitleSuffix(titleText: string): string {
  const normalized = String(titleText || "")
    .replace(/[^A-Za-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length < 2) return "";
  return parts.slice(-1)[0].toLowerCase();
}

function computeSuffixMatchScore(
  titleText: string,
  weaponName: string,
  stats: RivenStat[],
): number {
  const titleSuffix = extractRivenTitleSuffix(titleText);
  if (!titleSuffix || !weaponName) return 0;

  const rivenType = rivenData.resolveRivenType(weaponName);
  if (!rivenType) return 0;

  const buffTags = stats
    .filter((stat) => stat.positive)
    .map((stat) => rivenData.statNameToTag(stat.name))
    .filter((tag): tag is string => !!tag);
  const curseTags = stats
    .filter((stat) => !stat.positive)
    .map((stat) => rivenData.statNameToTag(stat.name))
    .filter((tag): tag is string => !!tag);

  const expectedSuffix = rivenData.generateRivenSuffix(rivenType, buffTags, curseTags);
  if (!expectedSuffix) return 0;

  const normalizedExpected = expectedSuffix.toLowerCase().replace(/[^a-z]/g, "");
  const normalizedTitle = titleSuffix.toLowerCase().replace(/[^a-z]/g, "");
  if (!normalizedExpected || !normalizedTitle) return 0;
  if (normalizedExpected === normalizedTitle) return 10;

  const maxLen = Math.max(normalizedExpected.length, normalizedTitle.length);
  const distance = levenshteinDistance(normalizedExpected, normalizedTitle);
  if (distance <= 1) return 7;
  if (distance <= 2 && maxLen >= 6) return 4;
  return -5;
}

function computeGradingPenalty(
  gradingCandidates: Array<NonNullable<ReturnType<typeof rivenGrading.gradeRiven>>>,
): number {
  if (gradingCandidates.length === 0) return -10;

  const penalties = gradingCandidates.map((graded) => {
    const clampedRolls = graded.stats.filter(
      (stat) => stat.value != null && (stat.rollFloat <= 0 || stat.rollFloat >= 1),
    ).length;
    const unknownGrades = graded.stats.filter((stat) => stat.grade === "?").length;
    return clampedRolls * 4 + unknownGrades * 2;
  });
  const minPenalty = Math.min(...penalties);
  return 10 - minPenalty;
}

export function scoreStatsCandidate(
  stats: RivenStat[],
  rawText: string,
  expectedWeaponName = "",
  titleText = "",
): number {
  if (!Array.isArray(stats) || stats.length === 0) return -1;

  const uniqueKeys = new Set(
    stats.map((stat) => `${stat.name.toLowerCase()}|${stat.positive ? 1 : 0}`),
  );
  const duplicates = Math.max(0, stats.length - uniqueKeys.size);
  const valueCount = stats.filter((stat) => stat.value !== null).length;
  const negativeCount = stats.filter((stat) => !stat.positive).length;
  const positiveCount = stats.filter((stat) => stat.positive).length;
  const unknownCount = stats.filter((stat) => !rivenData.statNameToTag(stat.name)).length;
  const multiplierCount = stats.filter((stat) => !!stat.multiplier).length;
  const absurdCount = stats.filter(
    (stat) => stat.value != null && !stat.multiplier && Math.abs(stat.value) > 420,
  ).length;

  let score = 0;
  if (stats.length >= 2 && stats.length <= 4) {
    score += 28 - Math.abs(3 - stats.length) * 5;
  } else {
    score -= 18 + Math.abs(3 - stats.length) * 6;
  }

  score += valueCount * 7;
  score -= (stats.length - valueCount) * 2;
  score += uniqueKeys.size * 3;
  score -= duplicates * 8;
  score += negativeCount <= 1 ? 6 : -12 * (negativeCount - 1);
  if (positiveCount >= 4) score -= 18;
  if (multiplierCount > 1) score -= 12 * (multiplierCount - 1);
  score -= unknownCount * 4;
  score -= absurdCount * 14;

  const effectiveWeapon =
    expectedWeaponName && expectedWeaponName !== "Riven"
      ? expectedWeaponName
      : rivenData.findWeaponInText(rawText) || "";

  if (effectiveWeapon) {
    const mappedCount = countMappedStats(stats, effectiveWeapon);
    score += mappedCount * 4;

    const gradingCandidates = [
      rivenGrading.gradeRiven(effectiveWeapon, stats, { level: 0 }),
      rivenGrading.gradeRiven(effectiveWeapon, stats, { level: 8 }),
    ]
      .filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate)
      .sort((a, b) => computeGradingPenalty([b]) - computeGradingPenalty([a]));

    const graded = gradingCandidates[0] || null;
    if (graded) {
      score += computeGradingPenalty(gradingCandidates);
      score += computeSuffixMatchScore(titleText || rawText, effectiveWeapon, stats);
    } else {
      score -= 10;
    }
  }

  return score;
}
