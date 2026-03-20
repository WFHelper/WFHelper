"use strict";

/**
 * OCR scanning for the riven rolling screen.
 *
 * Scanning strategy:
 *  1. Session opens → scanInitialCard() — OCR the centered single card
 *  2. Roll confirmed → scanNewRoll() — OCR only the RIGHT panel (new roll)
 *
 * The left panel (current/old stats) is never scanned — we already know those
 * stats from step 1 or from the previous roll cycle.
 *
 * Enhancement: brightness threshold (max channel ≥ 150) with Lanczos upscaling.
 * OCR text is preprocessed to fix broken numbers and misread stat names.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withScope } from "../../services/logger";
import { captureScreen } from "../../services/rewardScannerCapture";
import { cropRect } from "../../services/rewardScannerImage";
import { createRewardOcrRunner } from "../../services/rewardScannerOcr";
import { getSettings as getRewardScannerSettings } from "../../services/rewardScanner";
import { clamp01, computeMeanAndStd, sleep } from "../../services/rewardScannerUtils";
import * as rivenData from "../../services/rivenData";
import * as rivenGrading from "../../services/rivenGrading";

const log = withScope("rivenScan");

// __dirname at runtime is .electron-build/ipc/overlay/ — three levels up to reach project root
const OCR_SCRIPT = path.join(__dirname, "..", "..", "..", "scripts", "ocr.ps1");
const TEMP_RIGHT = path.join(os.tmpdir(), "wf-companion-riven-right-ocr");
const TEMP_SINGLE = path.join(os.tmpdir(), "wf-companion-riven-single-ocr");
const OCR_TIMEOUT_MS = 8000;

const RIVEN_READY_TIMEOUTS_MS = Object.freeze({
  initial: 1800,
  roll: 3200,
  choice: 1800,
});
const RIVEN_READY_POLL_MS = 140;
const RIVEN_READY_REQUIRED_HITS = 2;
const RIVEN_READY_SCORE_THRESHOLD = 0.2;

// Use the same OCR engine the user selected in overlay settings (e.g. "tesseract").
// Without this, the riven scanner would default to "auto" (PowerShell first) even when
// the user explicitly picked Tesseract.
function getRequestedOcrEngine(): string {
  try {
    const settings = getRewardScannerSettings();
    const engine =
      typeof settings?.ocrEngine === "string" ? settings.ocrEngine.trim().toLowerCase() : "";
    return engine || "auto";
  } catch {
    return "auto";
  }
}

const ocrRunner = createRewardOcrRunner({
  log,
  ocrScriptPath: OCR_SCRIPT,
  getRequestedEngine: getRequestedOcrEngine,
});

// ── Known riven stat names ──────────────────────────────────────────────────
// Order matters: longer compound names MUST appear before shorter substrings
// (e.g. "Damage to Grineer" before "Damage") so the overlap filter keeps
// the more specific match.

const KNOWN_RIVEN_STATS: ReadonlyArray<string> = Object.freeze([
  // ── Compound names first (longer before shorter to win overlap filter) ──
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
  // ── Elements ──
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
  // ── Short / generic names last ──
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
  /** Percentage value as shown on the card, e.g. 190.9 for "+190.9% Critical Chance" */
  value: number | null;
  /** True when the value is an x-multiplier (e.g. "x0.62 Damage to Infested") */
  multiplier?: boolean;
}

// ── OCR text preprocessing ──────────────────────────────────────────────────
// Windows OCR frequently inserts spaces inside numbers on stylised game text
// and misreads element icons as garbage characters.

function preprocessOcrText(raw: string): string {
  let text = raw;

  // Fix OCR misread of "%" as "0/0", "O/O", etc.
  text = text.replace(/0\/0/g, "%");
  text = text.replace(/O\/O/gi, "%");
  text = text.replace(/o\/o/g, "%");

  // Fix "Z" right after a digit → likely "%"
  text = text.replace(/(\d)\s*Z\b/g, "$1%");

  // Normalise locale decimal separator (comma → period) BEFORE space collapse.
  // OCR sometimes reads the comma as a space: "73,9%" → "73 9%".  If we
  // collapsed spaces first, "73 9" would merge into "739" and the decimal
  // would be lost.  Converting commas early ensures "73,9" → "73.9" is safe.
  text = text.replace(/,(\d)/g, ".$1");

  // Recover decimal separator read as space: "73 9%" → "73.9%", "165 4%" → "165.4%".
  // Only targets a SINGLE non-zero digit before % — multi-digit fragments like
  // "1 51" are integer-part spaces that should be collapsed instead.
  // Excludes 0 because game never displays ".0" decimals (shows as integer).
  text = text.replace(/(\d)\s([1-9])\s*%/g, "$1.$2%");

  // Collapse spaces within number sequences following a sign.
  // "+1 51.7%" → "+151.7%"
  for (let pass = 0; pass < 5; pass++) {
    text = text.replace(/([+\-\u2013]\s*\d+)\s+(\d)/g, "$1$2");
  }

  // Collapse spaces between adjacent digits (no sign prefix)
  for (let pass = 0; pass < 5; pass++) {
    text = text.replace(/(\d)\s+(\d)/g, "$1$2");
  }

  // Remove stray non-digit characters embedded inside numbers
  // (icon artifacts read as letters between digits: "+15I,7%" → "+15,7%"
  //  or "+151L7%" → "+1517%")
  text = text.replace(/(\d)[A-Za-z](\d)/g, "$1$2");
  // Re-run space collapse after cleaning
  for (let pass = 0; pass < 3; pass++) {
    text = text.replace(/(\d)\s+(\d)/g, "$1$2");
  }

  // Fix common OCR misreads of stat names
  text = text.replace(/Dannage/gi, "Damage");
  text = text.replace(/Darnage/gi, "Damage");
  text = text.replace(/Darnoge/gi, "Damage");
  text = text.replace(/Crit\s*ical/gi, "Critical");
  text = text.replace(/Cri tical/gi, "Critical");
  text = text.replace(/Critica\b/gi, "Critical");
  text = text.replace(/Multi\s*shot/gi, "Multishot");
  text = text.replace(/Sta tus/gi, "Status");
  text = text.replace(/Statuc/gi, "Status");
  text = text.replace(/Re load/gi, "Reload");
  text = text.replace(/Elec tricity/gi, "Electricity");
  text = text.replace(/Punc ture/gi, "Puncture");
  text = text.replace(/Maga zine/gi, "Magazine");
  text = text.replace(/Capaclty/gi, "Capacity");
  text = text.replace(/Maxinnunn/gi, "Maximum");
  text = text.replace(/Annnno/gi, "Ammo");
  text = text.replace(/Mel[ae]e/gi, "Melee");
  text = text.replace(/Fini sher/gi, "Finisher");
  text = text.replace(/Finlsher/gi, "Finisher");
  // OCR reads "Impact" as "lmpact" (lowercase L), "hmpact", ">lmpact"
  text = text.replace(/[>]?[lh]mpact/gi, "Impact");

  // Strip "(x2 for Heavy Attacks)" qualifier — this is a modifier on Critical Chance,
  // NOT a separate stat.  OCR would otherwise pick up "Heavy Attack" from it.
  // Must run BEFORE the symbol strip below, which removes parentheses.
  // Allow OCR typos on "Attacks" — common misreads: Attacke, Attackc, Attacks, Attack
  text = text.replace(/\(x\d+\s*(?:for\s*)?Heavy\s*Attack[a-z]*\)/gi, "");

  // Strip element icon artifacts before stat names.
  // Warframe prefixes element stats with icons that OCR reads as junk like
  // brackets, arrows, circled chars, symbols. These can appear between the
  // numeric value and the stat name, breaking value association.
  // eslint-disable-next-line no-useless-escape
  text = text.replace(/[*()\[\]{}|\\<>^~°©®™•→←↑↓↗↘►◄▸▾▲▼■□●○]+\s*/g, " ");

  // Second pass: strip "x2 for Heavy Attacks" without parentheses (OCR may not
  // produce them, or the symbol strip above may have removed them).
  text = text.replace(/\bx\d+\s*(?:for\s*)?Heavy\s*Attack[a-z]*\b/gi, "");

  // OCR frequently reads element icons as single letters/digits that get
  // inserted between the value and stat name (e.g. "+151,7% Y Slash").
  // Remove isolated single characters between a % and a known stat name.
  text = text.replace(/%\s+[A-Z0-9]\s+(?=[A-Z])/g, "% ");

  // Common icon-to-letter misreads for specific stats
  text = text.replace(/\bG[Ll]ash\b/gi, "Slash");
  text = text.replace(/\b\(Glash\b/gi, "Slash");
  text = text.replace(/\bY\s*Puncture\b/gi, "Puncture");
  text = text.replace(/\bA\s*Slash\b/gi, "Slash");
  text = text.replace(/\bO\s*Cold\b/gi, "Cold");
  text = text.replace(/\bO\s*Heat\b/gi, "Heat");
  text = text.replace(/\bQ\s*Toxin\b/gi, "Toxin");
  text = text.replace(/\bQ\s*Electricity\b/gi, "Electricity");

  // Strip single digit/char glued to stat names from icon misreads.
  // E.g. "6Heat" (fire icon → "6"), "'Heat" (icon → "'"), "4Slash".
  // Only strip when the char is right before a known element/damage stat name.
  text = text.replace(
    /[0-9'"`]\s*(?=(?:Slash|Cold|Heat|Electricity|Toxin|Impact|Puncture|Radiation|Viral|Corrosive|Blast|Magnetic|Gas)\b)/gi,
    "",
  );

  // Strip any single uppercase letter immediately before a known stat name
  // (catches remaining icon misreads like "A Impact", "V Slash")
  text = text.replace(
    /\b[A-Z]\s+(?=(?:Slash|Cold|Heat|Electricity|Toxin|Impact|Puncture|Radiation|Viral|Corrosive|Blast|Magnetic|Gas)\b)/g,
    "",
  );

  // Strip short non-alphanumeric junk tokens before known elemental/damage stats
  // (e.g. encoding/OCR artifacts like "┬Ñ Electricity").
  text = text.replace(
    /[^\w\s+.%\-x]{1,3}\s+(?=(?:Slash|Cold|Heat|Electricity|Toxin|Impact|Puncture|Radiation|Viral|Corrosive|Blast|Magnetic|Gas)\b)/gi,
    "",
  );

  // Rejoin "Critical Chance" + "for Slide Attack" when OCR splits across lines.
  // The game card wraps long stat names.  OCR often inserts junk between the
  // two fragments — e.g. "Critical Chance -\n- 4 for Slide Attack".
  // Allow up to 20 non-letter characters (digits, signs, newlines, spaces)
  // between "Chance" and "for" to absorb OCR noise.
  text = text.replace(
    /Critical\s+Chance[^a-zA-Z]{0,20}for\s+Slide\s+Attack/gi,
    "Critical Chance for Slide Attack",
  );

  // Strip "s" (seconds) suffix from numeric values — game shows "+8,5s Combo Duration"
  // and OCR sometimes reads the "s" as "5", producing "8.55" instead of "8.5".
  // Only match "s" immediately after digits and before whitespace/end (not inside words).
  text = text.replace(/(\d)s(?=\s|$)/g, "$1");

  // Insert line breaks before +/- or x-multiplier followed by digits so the parser sees separate lines.
  text = text.replace(/\s+([+\-\u2013]\d)/g, "\n$1");
  text = text.replace(/\s+(x\d)/gi, "\n$1");

  return text;
}

// ── Stat parsing ────────────────────────────────────────────────────────────

/**
 * Sanity-check a parsed riven value.  Riven stats rarely exceed ~350%;
 * values above MAX_REASONABLE_VALUE almost always indicate a dropped decimal
 * separator (e.g. OCR reads "155,2%" as "1552%").  In that case, insert a
 * decimal point before the last digit: 1552 → 155.2.
 */
const MAX_REASONABLE_VALUE = 500;
function sanitiseValue(value: number): number {
  if (value > MAX_REASONABLE_VALUE && Number.isInteger(value) && value >= 100) {
    // Insert decimal before the last digit: 1552 → 155.2, 739 → 73.9
    const str = String(value);
    const corrected = parseFloat(str.slice(0, -1) + "." + str.slice(-1));
    if (Number.isFinite(corrected)) return corrected;
  }
  return value;
}

/**
 * Extract a sign (+/-) and numeric value from a text fragment.
 * Also handles Warframe's `x` multiplier prefix (e.g. "x1,59 Damage to Infested").
 * Returns { positive, value } or null if no value found.
 */
function extractSignAndValue(
  fragment: string,
): { positive: boolean; value: number | null; multiplier?: boolean } | null {
  // Look for sign + number + optional %
  const signMatches = [...fragment.matchAll(/[+\-\u2013](?=\s*\d)/g)];
  const lastSign = signMatches.at(-1);
  const positive = !lastSign || (lastSign[0] !== "-" && lastSign[0] !== "\u2013");

  // Try percent-terminated number first
  const percentMatches = [...fragment.matchAll(/(\d+\.?\d*)\s*%/g)];
  if (percentMatches.length > 0) {
    const parsed = parseFloat(percentMatches[percentMatches.length - 1][1]);
    if (Number.isFinite(parsed)) return { positive, value: sanitiseValue(parsed) };
  }

  // Try x-multiplier format: "x1,59" or "x1.59" (Warframe uses this for some stats)
  // Multipliers < 1 are curses (negative), ≥ 1 are buffs (positive).
  const xMultiplier = [...fragment.matchAll(/x\s*(\d+\.?\d*)/gi)];
  if (xMultiplier.length > 0) {
    const parsed = parseFloat(xMultiplier[xMultiplier.length - 1][1]);
    if (Number.isFinite(parsed)) return { positive: parsed >= 1, value: parsed, multiplier: true };
  }

  // Fallback: number directly after a sign
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

  // First pass: parse line-by-line (normal case)
  const lineResults = parseStatsFromLines(cleaned);

  // If we got stats with values, we're done
  if (lineResults.length > 0 && lineResults.some((s) => s.value !== null)) {
    return lineResults;
  }

  // Second pass: join everything into one blob and parse.
  // Windows OCR sometimes fragments text across lines, putting values
  // on different lines than stat names. Joining recovers associations.
  const blob = cleaned.replace(/\r?\n/g, " ");
  const blobResults = parseStatsFromLines(blob);

  // Return whichever pass found more stats with values
  const lineScore = lineResults.reduce((s, r) => s + (r.value !== null ? 10 : 3), 0);
  const blobScore = blobResults.reduce((s, r) => s + (r.value !== null ? 10 : 3), 0);
  return blobScore > lineScore ? blobResults : lineResults;
}

function lineContainsKnownStat(line: string): boolean {
  const lineLower = line.toLowerCase();
  return KNOWN_RIVEN_STATS.some((stat) => lineLower.includes(stat.toLowerCase()));
}

function collapseOrphanValueLines(lines: string[]): string[] {
  const collapsed: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i].trim();
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

    let nextIndex = i + 1;
    while (nextIndex < lines.length && !lines[nextIndex].trim()) nextIndex += 1;
    if (nextIndex >= lines.length) {
      collapsed.push(current);
      continue;
    }

    const next = lines[nextIndex].trim();
    collapsed.push(`${current} ${next}`.trim());
    i = nextIndex;
  }

  return collapsed;
}

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

    // Sort by position, then prefer longer matches at the same position
    // (e.g. "Magazine Capacity" over "Magazine" when both start at the same index).
    hits.sort((a, b) => a.idx - b.idx || b.stat.length - a.stat.length);
    const filtered: typeof hits = [];
    let lastEnd = -1;
    for (const hit of hits) {
      if (hit.idx >= lastEnd) {
        filtered.push(hit);
        lastEnd = hit.idx + hit.stat.length;
      }
    }

    for (let i = 0; i < filtered.length; i++) {
      const { stat, idx } = filtered[i];
      const key = stat.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      // Check PREFIX for value — only the text between the previous stat's end
      // and this stat's start, so we don't steal values from earlier stats.
      const prefixStart = i > 0 ? filtered[i - 1].idx + filtered[i - 1].stat.length : 0;
      const prefix = line.slice(prefixStart, idx);
      let extracted = extractSignAndValue(prefix);

      // If no value in prefix, check SUFFIX (text after stat name until next stat or end).
      // OCR sometimes reorders: "Impact Slash +170,3%" instead of "+170,3% Slash"
      if (!extracted || extracted.value === null) {
        const suffixEnd = i + 1 < filtered.length ? filtered[i + 1].idx : line.length;
        const suffix = line.slice(idx + stat.length, suffixEnd);
        const suffixExtracted = extractSignAndValue(suffix);
        if (suffixExtracted && suffixExtracted.value !== null) {
          extracted = suffixExtracted;
        }
      }

      const positive = extracted?.positive ?? true;
      const value = extracted?.value ?? null;
      const multiplier = extracted?.multiplier ?? false;

      results.push({ name: stat, positive, value, ...(multiplier && { multiplier: true }) });
    }
  }

  return results;
}

interface TextBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface RivenTextMetrics {
  score: number;
  coverage: number;
  activeRows: number;
  activeCols: number;
  rowGroups: number;
  bounds: TextBounds | null;
}

function smoothSeries(values: number[]): number[] {
  if (values.length <= 2) return values.slice();
  return values.map((value, index) => {
    const prev = index > 0 ? values[index - 1] : value;
    const next = index < values.length - 1 ? values[index + 1] : value;
    return (prev + value + next) / 3;
  });
}

function countGroups(values: number[], threshold: number, minRun: number): number {
  let groups = 0;
  let run = 0;
  for (const value of values) {
    if (value >= threshold) {
      run += 1;
      continue;
    }
    if (run >= minRun) groups += 1;
    run = 0;
  }
  if (run >= minRun) groups += 1;
  return groups;
}

function findBounds(values: number[], threshold: number): { start: number; end: number } | null {
  let start = -1;
  let end = -1;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] >= threshold) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  for (let i = values.length - 1; i >= start; i -= 1) {
    if (values[i] >= threshold) {
      end = i;
      break;
    }
  }
  if (end < start) return null;
  return { start, end };
}

function analyzeRivenTextMetrics(nativeImage: any): RivenTextMetrics {
  if (!nativeImage || typeof nativeImage.getSize !== "function") {
    return {
      score: 0,
      coverage: 0,
      activeRows: 0,
      activeCols: 0,
      rowGroups: 0,
      bounds: null,
    };
  }

  const { width, height } = nativeImage.getSize();
  if (width < 24 || height < 24) {
    return {
      score: 0,
      coverage: 0,
      activeRows: 0,
      activeCols: 0,
      rowGroups: 0,
      bounds: null,
    };
  }

  const bitmap: Buffer = nativeImage.toBitmap();
  const rowScores = new Array<number>(height).fill(0);
  const colScores = new Array<number>(width).fill(0);
  let activePixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const blue = bitmap[idx];
      const green = bitmap[idx + 1];
      const red = bitmap[idx + 2];
      const maxC = Math.max(red, green, blue);
      const minC = Math.min(red, green, blue);
      const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
      const isTextLike = maxC >= 146 && sat <= 0.42;
      if (!isTextLike) continue;
      activePixels += 1;
      rowScores[y] += 1;
      colScores[x] += 1;
    }
  }

  const smoothedRows = smoothSeries(rowScores);
  const smoothedCols = smoothSeries(colScores);
  const rowStats = computeMeanAndStd(smoothedRows);
  const colStats = computeMeanAndStd(smoothedCols);
  const rowThreshold = Math.max(2, rowStats.mean + rowStats.std * 0.45);
  const colThreshold = Math.max(2, colStats.mean + colStats.std * 0.45);

  const rowBounds = findBounds(smoothedRows, rowThreshold);
  const colBounds = findBounds(smoothedCols, colThreshold);
  const activeRows = smoothedRows.filter((value) => value >= rowThreshold).length;
  const activeCols = smoothedCols.filter((value) => value >= colThreshold).length;
  const rowGroups = countGroups(
    smoothedRows,
    rowThreshold,
    Math.max(2, Math.floor(height * 0.015)),
  );
  const coverage = activePixels / Math.max(1, width * height);

  let bounds: TextBounds | null = null;
  if (rowBounds && colBounds) {
    const padX = Math.max(4, Math.floor(width * 0.04));
    const padY = Math.max(3, Math.floor(height * 0.03));
    const left = Math.max(0, colBounds.start - padX);
    const top = Math.max(0, rowBounds.start - padY);
    const right = Math.min(width - 1, colBounds.end + padX);
    const bottom = Math.min(height - 1, rowBounds.end + padY);
    const boundWidth = right - left + 1;
    const boundHeight = bottom - top + 1;
    if (
      boundWidth >= Math.max(24, Math.floor(width * 0.2)) &&
      boundHeight >= Math.max(24, Math.floor(height * 0.12))
    ) {
      bounds = {
        left,
        top,
        width: boundWidth,
        height: boundHeight,
      };
    }
  }

  const coverageScore = clamp01(coverage / 0.08);
  const rowScore = clamp01(activeRows / Math.max(8, height * 0.16));
  const colScore = clamp01(activeCols / Math.max(24, width * 0.2));
  const groupScore = clamp01(rowGroups / 3);
  const score = Number(
    (coverageScore * 0.28 + rowScore * 0.24 + colScore * 0.24 + groupScore * 0.24).toFixed(3),
  );

  return {
    score,
    coverage: Number(coverage.toFixed(4)),
    activeRows,
    activeCols,
    rowGroups,
    bounds,
  };
}

function cropAbsolute(nativeImage: any, bounds: TextBounds): any {
  return nativeImage.crop({
    x: Math.max(0, Math.floor(bounds.left)),
    y: Math.max(0, Math.floor(bounds.top)),
    width: Math.max(1, Math.floor(bounds.width)),
    height: Math.max(1, Math.floor(bounds.height)),
  });
}

function refineRivenTextCrop(nativeImage: any): {
  image: any;
  metrics: RivenTextMetrics;
  refined: boolean;
} {
  const metrics = analyzeRivenTextMetrics(nativeImage);
  if (!metrics.bounds || metrics.score < 0.12) {
    return { image: nativeImage, metrics, refined: false };
  }
  try {
    return {
      image: cropAbsolute(nativeImage, metrics.bounds),
      metrics,
      refined: true,
    };
  } catch {
    return { image: nativeImage, metrics, refined: false };
  }
}

function buildTempPngPath(basePath: string, label: string, index: number): string {
  const ext = path.extname(basePath) || ".png";
  const stem = ext ? basePath.slice(0, -ext.length) : basePath;
  const safeLabel = String(label || "scan").replace(/[^a-z0-9_-]+/gi, "-");
  return `${stem}-${safeLabel}-${index}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
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

function scoreStatsCandidate(stats: RivenStat[], rawText: string, expectedWeaponName = ""): number {
  if (!Array.isArray(stats) || stats.length === 0) return -1;

  const uniqueKeys = new Set(
    stats.map((stat) => `${stat.name.toLowerCase()}|${stat.positive ? 1 : 0}`),
  );
  const duplicates = Math.max(0, stats.length - uniqueKeys.size);
  const valueCount = stats.filter((stat) => stat.value !== null).length;
  const negativeCount = stats.filter((stat) => !stat.positive).length;
  const unknownCount = stats.filter((stat) => !rivenData.statNameToTag(stat.name)).length;
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
  score -= unknownCount * 4;
  score -= absurdCount * 14;

  const effectiveWeapon =
    expectedWeaponName && expectedWeaponName !== "Riven"
      ? expectedWeaponName
      : rivenData.findWeaponInText(rawText) || "";

  if (effectiveWeapon) {
    const mappedCount = countMappedStats(stats, effectiveWeapon);
    score += mappedCount * 4;

    const graded = rivenGrading.gradeRiven(effectiveWeapon, stats);
    if (graded) {
      score += 12;
      const clampedRolls = graded.stats.filter(
        (stat) => stat.value != null && (stat.rollFloat <= 0 || stat.rollFloat >= 1),
      ).length;
      if (clampedRolls >= Math.max(2, Math.ceil(graded.stats.length * 0.75))) {
        score -= 6;
      }

      const rivenType = rivenData.resolveRivenType(effectiveWeapon);
      if (rivenType) {
        const buffTags = stats
          .filter((stat) => stat.positive)
          .map((stat) => rivenData.statNameToTag(stat.name))
          .filter((tag): tag is string => !!tag);
        const curseTags = stats
          .filter((stat) => !stat.positive)
          .map((stat) => rivenData.statNameToTag(stat.name))
          .filter((tag): tag is string => !!tag);
        const suffix = rivenData.generateRivenSuffix(rivenType, buffTags, curseTags);
        if (suffix) {
          const normalizedRaw = String(rawText || "")
            .toLowerCase()
            .replace(/[^a-z]/g, "");
          const normalizedSuffix = suffix.toLowerCase().replace(/[^a-z]/g, "");
          if (normalizedRaw.includes(normalizedSuffix)) {
            score += 8;
          }
        }
      }
    } else {
      score -= 10;
    }
  }

  return score;
}

interface RivenUiReadyResult {
  ready: boolean;
  attempts: number;
  elapsedMs: number;
  bestScore: number;
  screenshot: any | null;
}

const MIN_ACCEPTABLE_RIVEN_STATS = 2;

async function retrySparseRivenScan<T>(
  attemptLabel: string,
  currentStats: RivenStat[],
  retryDelayMs: number,
  runRetry: () => Promise<T>,
  getStats: (value: T) => RivenStat[],
): Promise<T | null> {
  if (currentStats.length >= MIN_ACCEPTABLE_RIVEN_STATS) return null;
  log.log(
    `[RivenScan] ${attemptLabel}: sparse result (${currentStats.length} stats), retrying in ${retryDelayMs}ms`,
  );
  await sleep(retryDelayMs);
  const retried = await runRetry();
  const retriedStats = getStats(retried);
  if (retriedStats.length > currentStats.length) {
    log.log(`[RivenScan] ${attemptLabel}: retry improved to ${retriedStats.length} stats`);
    return retried;
  }
  return null;
}

async function waitForRivenUiReady(
  rect: { x: number; y: number; width: number; height: number },
  mode: keyof typeof RIVEN_READY_TIMEOUTS_MS,
): Promise<RivenUiReadyResult> {
  const timeoutMs = RIVEN_READY_TIMEOUTS_MS[mode];
  const startedAt = Date.now();
  let attempts = 0;
  let consecutiveHits = 0;
  let bestScore = 0;
  let bestScreenshot: any | null = null;
  let lastMetrics: RivenTextMetrics | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    const screenshot = await captureScreen();
    if (!screenshot?.image) {
      consecutiveHits = 0;
      await sleep(RIVEN_READY_POLL_MS);
      continue;
    }

    let roughCrop: any;
    try {
      roughCrop = cropRect(screenshot.image, rect);
    } catch {
      consecutiveHits = 0;
      await sleep(RIVEN_READY_POLL_MS);
      continue;
    }

    const metrics = analyzeRivenTextMetrics(roughCrop);
    if (metrics.score > bestScore) {
      bestScore = metrics.score;
      bestScreenshot = screenshot;
    }

    let stable = metrics.score >= RIVEN_READY_SCORE_THRESHOLD;
    if (stable && lastMetrics?.bounds && metrics.bounds) {
      const coverageDelta = Math.abs(metrics.coverage - lastMetrics.coverage);
      const leftDelta =
        Math.abs(metrics.bounds.left - lastMetrics.bounds.left) /
        Math.max(1, roughCrop.getSize().width);
      const topDelta =
        Math.abs(metrics.bounds.top - lastMetrics.bounds.top) /
        Math.max(1, roughCrop.getSize().height);
      const widthDelta =
        Math.abs(metrics.bounds.width - lastMetrics.bounds.width) /
        Math.max(1, roughCrop.getSize().width);
      const heightDelta =
        Math.abs(metrics.bounds.height - lastMetrics.bounds.height) /
        Math.max(1, roughCrop.getSize().height);
      stable =
        coverageDelta <= 0.025 &&
        leftDelta <= 0.05 &&
        topDelta <= 0.05 &&
        widthDelta <= 0.08 &&
        heightDelta <= 0.08;
    }

    consecutiveHits = stable ? consecutiveHits + 1 : 0;
    lastMetrics = metrics;

    if (consecutiveHits >= RIVEN_READY_REQUIRED_HITS) {
      return {
        ready: true,
        attempts,
        elapsedMs: Date.now() - startedAt,
        bestScore,
        screenshot,
      };
    }

    await sleep(RIVEN_READY_POLL_MS);
  }

  return {
    ready: false,
    attempts,
    elapsedMs: Date.now() - startedAt,
    bestScore,
    screenshot: bestScreenshot,
  };
}

export interface RollPanelResult {
  left: RivenStat[];
  right: RivenStat[];
}

// ── Image enhancement (Sharp-based) ──────────────────────────────────────────
// Uses Sharp (bilinear) for fast upscaling + brightness thresholding
// + 1px morphological dilation to connect broken character strokes.  This
// produces significantly cleaner text for Windows OCR than Electron's built-in
// nativeImage.resize.

const MIN_OCR_WIDTH = 1800;

interface EnhanceMode {
  kind: "bright" | "lowsat";
  threshold: number;
  /** Low-saturation upper bound (lowsat mode only). */
  maxSat?: number;
  /** Apply 1px morphological dilation after thresholding to connect broken
   *  character strokes.  Slightly increases noise but recovers fragmented
   *  letters (especially at bright-120 where strokes are thinner). */
  dilate?: boolean;
}

// Enhancement strategies, ordered fastest-and-most-likely-to-win first.
// Deliberately kept to TWO so worst-case cost is 2 OCR calls per panel (4 total):
//
// 1. lowsat-bright (PRIMARY): keep pixels where max(R,G,B) >= threshold AND
//    saturation <= maxSat.  Riven stat text is near-white (low saturation),
//    while the gold/orange decorative card background is highly saturated.
//    This filter correctly rejects the background without needing a high
//    brightness threshold, making it the most reliable single strategy.
//    If it finds ≥4 stats with values, we skip strategy 2 entirely.
//
// 2. bright-120+dilate (FALLBACK): pure brightness threshold with 1px dilation.
//    Used when the screen is dimmer than usual (e.g. HDR monitors, or the left
//    panel in the two-card roll screen which renders slightly darker).
//    Dilation reconnects broken character strokes at the lower threshold.
const ENHANCE_STRATEGIES: EnhanceMode[] = [
  { kind: "lowsat", threshold: 155, maxSat: 0.35 },
  { kind: "bright", threshold: 120, dilate: true },
];

/**
 * Enhance a cropped nativeImage for OCR.  Returns a PNG Buffer ready to write
 * to disk for the OCR engine.
 *
 * Pipeline: nativeImage → PNG → Sharp Lanczos3 upscale → RGBA raw →
 * brightness threshold → optional 1px dilation → grayscale PNG (black text
 * on white background).
 */
async function enhanceForRivenOcr(croppedImage: any, mode: EnhanceMode): Promise<Buffer> {
  const sharp = require("sharp") as typeof import("sharp");
  const { width, height } = croppedImage.getSize();

  // Auto-scale to ensure at least MIN_OCR_WIDTH pixels
  const scale = width >= MIN_OCR_WIDTH ? 1 : Math.ceil(MIN_OCR_WIDTH / width);
  const scaledW = Math.min(6000, width * scale);
  const scaledH = Math.min(6000, height * scale);

  // Convert nativeImage → PNG → Sharp raw RGBA for pixel processing
  const pngBuffer: Buffer = croppedImage.toPNG();
  const rawBuffer = await sharp(pngBuffer)
    .resize(scaledW, scaledH, { kernel: "linear" })
    .ensureAlpha()
    .raw()
    .toBuffer();

  // Build binary mask: 1 = text pixel, 0 = background
  const pixelCount = scaledW * scaledH;
  const mask = Buffer.alloc(pixelCount);
  for (let i = 0, j = 0; i < rawBuffer.length; i += 4, j++) {
    const r = rawBuffer[i];
    const g = rawBuffer[i + 1];
    const b = rawBuffer[i + 2];
    const maxC = Math.max(r, g, b);
    if (mode.kind === "lowsat") {
      // Low-saturation + brightness filter: keep near-white pixels only.
      // Warframe riven stat text is near-white; the golden/orange card
      // background has high saturation and is rejected by the sat filter.
      const minC = Math.min(r, g, b);
      const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
      mask[j] = maxC >= mode.threshold && sat <= (mode.maxSat ?? 0.35) ? 1 : 0;
    } else {
      mask[j] = maxC >= mode.threshold ? 1 : 0;
    }
  }

  // Output buffer: grayscale, inverted (text = black 0, bg = white 255)
  const output = Buffer.alloc(pixelCount);

  if (mode.dilate) {
    // 1px morphological dilation: a pixel is "text" if ANY of its 8 neighbours
    // (or itself) is set in the mask.  Reconnects broken character strokes
    // without significantly increasing noise.
    for (let y = 0; y < scaledH; y++) {
      for (let x = 0; x < scaledW; x++) {
        let found = false;
        for (let dy = -1; dy <= 1 && !found; dy++) {
          for (let dx = -1; dx <= 1 && !found; dx++) {
            const nx = x + dx,
              ny = y + dy;
            if (nx >= 0 && nx < scaledW && ny >= 0 && ny < scaledH && mask[ny * scaledW + nx]) {
              found = true;
            }
          }
        }
        output[y * scaledW + x] = found ? 0 : 255;
      }
    }
  } else {
    // Direct threshold — no dilation
    for (let j = 0; j < pixelCount; j++) {
      output[j] = mask[j] ? 0 : 255;
    }
  }

  // Convert grayscale buffer to PNG via Sharp
  return sharp(output, {
    raw: { width: scaledW, height: scaledH, channels: 1 },
  })
    .png()
    .toBuffer();
}

// ── Crop regions (normalised ratios) ─────────────────────────────────────────
//
// Roll screen: only the right panel (new roll) is OCR'd.  The left panel shows
// the current/old riven whose stats are already known.
//
// Screen layout at 1920×1080 (Warframe default UI scale):
//   Right card stats text: starts around ~44% of screen width
//   Stats area: starts at ~43% screen height
//
// Give generous margins so the crop still works at slightly different UI scales
// and when the card is not exactly centred (e.g. 21:9 monitors).
const RIGHT_PANEL_CROP = { x: 0.44, y: 0.43, width: 0.4, height: 0.45 };
// Single-card crop — used for the initial scan (card centred on screen) and
// the choice rescan (one card shown after selection).
const SINGLE_CARD_CROP = { x: 0.22, y: 0.43, width: 0.56, height: 0.45 };

/**
 * OCR a cropped region, trying multiple enhancement strategies and picking the
 * result with the highest stat score.  Uses whichever single OCR engine the
 * user has configured (Windows OCR or Tesseract) — never runs both.
 */
async function ocrCropMultiStrategy(
  image: any,
  rect: { x: number; y: number; width: number; height: number },
  tempPath: string,
  label = "",
  expectedWeaponName = "",
): Promise<{ text: string; stats: RivenStat[] }> {
  const roughCrop = cropRect(image, rect);
  const refined = refineRivenTextCrop(roughCrop);
  const cropVariants = [
    { id: "rough", image: roughCrop, refined: false, metrics: analyzeRivenTextMetrics(roughCrop) },
  ];
  if (refined.refined) {
    cropVariants.push({
      id: "refined",
      image: refined.image,
      refined: true,
      metrics: refined.metrics,
    });
  }

  if (label) {
    for (const variant of cropVariants) {
      const size = variant.image.getSize?.() ?? { width: 0, height: 0 };
      log.log(
        `[RivenScan] ${label} crop ${variant.id}: score=${variant.metrics.score.toFixed(3)} ` +
          `coverage=${variant.metrics.coverage.toFixed(4)} rows=${variant.metrics.activeRows} cols=${variant.metrics.activeCols} ` +
          `size=${size.width}x${size.height}`,
      );
    }
  }

  interface CandidateResult {
    text: string;
    stats: RivenStat[];
    score: number;
    cropId: string;
    refined: boolean;
    valueCount: number;
    modeLabel: string;
  }

  const orderedCandidates = [
    ...(cropVariants.find((variant) => variant.id === "refined")
      ? [{ cropId: "refined", mode: ENHANCE_STRATEGIES[1] }]
      : []),
    { cropId: "rough", mode: ENHANCE_STRATEGIES[1] },
    ...(cropVariants.find((variant) => variant.id === "refined")
      ? [{ cropId: "refined", mode: ENHANCE_STRATEGIES[0] }]
      : []),
    { cropId: "rough", mode: ENHANCE_STRATEGIES[0] },
  ];

  function isConfidentEnough(result: CandidateResult): boolean {
    if (result.score < 0) return false;
    if (result.stats.length >= 4 && result.valueCount >= 3 && result.score >= 75) return true;
    if (result.stats.length >= 3 && result.valueCount >= 3 && result.score >= 85) return true;
    if (result.stats.length === 2 && result.valueCount === 2 && result.score >= 55) return true;
    return false;
  }

  const results: CandidateResult[] = [];
  for (let i = 0; i < orderedCandidates.length; i += 1) {
    const plan = orderedCandidates[i];
    const cropVariant = cropVariants.find((variant) => variant.id === plan.cropId);
    if (!cropVariant) continue;

    const mode = plan.mode;
    const modeLabel = `${cropVariant.id}:${mode.kind}-${mode.threshold}${mode.dilate ? "+dilate" : ""}${mode.maxSat != null ? `-sat${mode.maxSat}` : ""}`;
    const enhancedPng = await enhanceForRivenOcr(cropVariant.image, mode);
    const p = buildTempPngPath(tempPath, `${label}-${cropVariant.id}`, i);

    let result: CandidateResult;
    fs.writeFileSync(p, enhancedPng);
    try {
      const text = await ocrRunner.runOCR(p, OCR_TIMEOUT_MS);
      const stats = parseRivenStats(text);
      result = {
        text,
        stats,
        score: scoreStatsCandidate(stats, text, expectedWeaponName),
        cropId: cropVariant.id,
        refined: cropVariant.refined,
        valueCount: stats.filter((stat) => stat.value !== null).length,
        modeLabel,
      };
    } catch {
      result = {
        text: "",
        stats: [] as RivenStat[],
        score: -1,
        cropId: cropVariant.id,
        refined: cropVariant.refined,
        valueCount: 0,
        modeLabel,
      };
    } finally {
      try {
        fs.unlinkSync(p);
      } catch {
        // best effort temp cleanup
      }
    }

    if (label) {
      const preview = result.text.replace(/\r?\n/g, " | ").slice(0, 150);
      log.log(
        `[RivenScan] OCR ${label} ${modeLabel}: ${result.stats.length} stats (score=${result.score}) "${preview}"`,
      );
    }

    results.push(result);
    if (isConfidentEnough(result)) {
      if (label) {
        log.log(
          `[RivenScan] early-accept ${label} candidate crop=${result.cropId} refined=${result.refined} ` +
            `score=${result.score} stats=${result.stats.length} values=${result.valueCount}`,
        );
      }
      return { text: result.text, stats: result.stats };
    }
  }

  let best = {
    text: "",
    stats: [] as RivenStat[],
    score: -1,
    cropId: "",
    refined: false,
    valueCount: 0,
  };
  for (const r of results) {
    if (r.score > best.score) {
      best = r;
      continue;
    }
    if (r.score < best.score) continue;
    if (r.stats.length > best.stats.length) {
      best = r;
      continue;
    }
    if (r.stats.length < best.stats.length) continue;
    if (r.valueCount > best.valueCount) {
      best = r;
      continue;
    }
    if (r.valueCount < best.valueCount) continue;
    if (r.refined && !best.refined) {
      best = r;
      continue;
    }
    if (!r.refined && best.refined) continue;
    if (r.text.length > best.text.length) {
      best = r;
    }
  }

  if (label) {
    log.log(
      `[RivenScan] chose ${label} candidate crop=${best.cropId || "unknown"} refined=${best.refined} ` +
        `score=${best.score} stats=${best.stats.length} values=${best.valueCount}`,
    );
  }

  return { text: best.text, stats: best.stats };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Capture and OCR the single-card view when the riven cycling screen first opens.
 * Returns the current riven stats (shown in the centre card before any roll).
 */
export interface InitialScanResult {
  stats: RivenStat[];
  /** Raw OCR text — used by the caller to attempt weapon-name extraction. */
  rawText: string;
}

export async function scanInitialCard(expectedWeaponName = ""): Promise<InitialScanResult> {
  const ready = await waitForRivenUiReady(SINGLE_CARD_CROP, "initial");
  if (!ready.ready) {
    log.log(
      `[RivenScan] initial UI gate timed out after ${ready.elapsedMs}ms (${ready.attempts} samples, best=${ready.bestScore.toFixed(3)})`,
    );
  }

  const capture = ready.screenshot || (await captureScreen());
  if (!capture) {
    log.warn("[RivenScan] scanInitialCard: captureScreen returned null");
    return { stats: [], rawText: "" };
  }

  const imgSize = capture.image.getSize?.() ?? { width: "?", height: "?" };
  log.log(
    `[RivenScan] initial capture: source=${capture.sourceType} name="${capture.sourceName}" size=${imgSize.width}x${imgSize.height}`,
  );

  try {
    let result = await ocrCropMultiStrategy(
      capture.image,
      SINGLE_CARD_CROP,
      TEMP_SINGLE,
      "initial-card",
      expectedWeaponName,
    );
    const retry = await retrySparseRivenScan(
      "initial-card",
      result.stats,
      650,
      async () => {
        const retryCapture = await captureScreen();
        if (!retryCapture) return result;
        return ocrCropMultiStrategy(
          retryCapture.image,
          SINGLE_CARD_CROP,
          TEMP_SINGLE,
          "initial-card-retry",
          expectedWeaponName,
        );
      },
      (value) => value.stats,
    );
    if (retry) result = retry;

    const { stats, text } = result;
    log.log(
      `[RivenScan] initial card scan: ${stats.length} stats found`,
      stats.map((s) => `${s.positive ? "+" : "-"}${s.value ?? "?"}% ${s.name}`).join(", "),
    );
    return { stats, rawText: text };
  } catch (err) {
    log.warn("[RivenScan] initial card OCR failed:", String(err));
    return { stats: [], rawText: "" };
  }
}

/**
 * Capture and OCR the **right panel only** after the roll animation.
 * The left panel (current/old riven) is unchanged between rolls -- the caller
 * already holds those stats from the initial scan or last choice rescan, so
 * scanning it again would only waste time.  Returns `left: []` by design;
 * the caller falls back to `_rivenInitialStats` when left is empty.
 */
export async function scanNewRoll(expectedWeaponName = ""): Promise<RollPanelResult> {
  const startAt = Date.now();

  const ready = await waitForRivenUiReady(RIGHT_PANEL_CROP, "roll");
  if (!ready.ready) {
    log.log(
      `[RivenScan] roll UI gate timed out after ${ready.elapsedMs}ms (${ready.attempts} samples, best=${ready.bestScore.toFixed(3)})`,
    );
  }

  const capture = ready.screenshot || (await captureScreen());
  if (!capture) {
    log.warn("[RivenScan] scanNewRoll: captureScreen returned null");
    return { left: [], right: [] };
  }

  const image = capture.image;
  const imgSize = image.getSize?.() ?? { width: "?", height: "?" };
  log.log(
    `[RivenScan] roll capture: source=${capture.sourceType} name="${capture.sourceName}" size=${imgSize.width}x${imgSize.height}`,
  );

  try {
    // Only scan the right (new roll) panel.  The left panel shows the current
    // riven whose stats we already know from the initial scan or previous choice.
    let rightResult = await ocrCropMultiStrategy(
      image,
      RIGHT_PANEL_CROP,
      TEMP_RIGHT,
      "roll-right",
      expectedWeaponName,
    );

    const elapsed = Date.now() - startAt;
    log.log(`[RivenScan] roll scan: right=${rightResult.stats.length} stats, elapsed=${elapsed}ms`);

    // If right side came back empty the animation may not have finished yet ---
    // retry once after a short delay.
    if (rightResult.stats.length < MIN_ACCEPTABLE_RIVEN_STATS) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      const capture2 = await captureScreen();
      if (capture2) {
        const r2 = await ocrCropMultiStrategy(
          capture2.image,
          RIGHT_PANEL_CROP,
          TEMP_RIGHT,
          "roll-right-retry",
          expectedWeaponName,
        );
        log.log(
          `[RivenScan] roll-retry: right=${r2.stats.length} stats, elapsed=${Date.now() - startAt}ms`,
        );
        if (r2.stats.length >= rightResult.stats.length) {
          rightResult = r2;
        }
      }
    }

    return { left: [], right: rightResult.stats };
  } catch (err) {
    log.warn("[RivenScan] roll scan OCR failed:", String(err));
    return { left: [], right: [] };
  }
}

/**
 * Capture and OCR the single card shown after a choice (kept or rerolled).
 * Uses a narrower center crop to avoid capturing stale two-card transition text.
 */
export async function scanChoiceRescan(expectedWeaponName = ""): Promise<RivenStat[]> {
  const ready = await waitForRivenUiReady(SINGLE_CARD_CROP, "choice");
  if (!ready.ready) {
    log.log(
      `[RivenScan] choice UI gate timed out after ${ready.elapsedMs}ms (${ready.attempts} samples, best=${ready.bestScore.toFixed(3)})`,
    );
  }

  const capture = ready.screenshot || (await captureScreen());
  if (!capture) {
    log.warn("[RivenScan] scanChoiceRescan: captureScreen returned null");
    return [];
  }

  try {
    let result = await ocrCropMultiStrategy(
      capture.image,
      SINGLE_CARD_CROP,
      TEMP_SINGLE,
      "choice-rescan",
      expectedWeaponName,
    );
    const retry = await retrySparseRivenScan(
      "choice-rescan",
      result.stats,
      500,
      async () => {
        const retryCapture = await captureScreen();
        if (!retryCapture) return result;
        return ocrCropMultiStrategy(
          retryCapture.image,
          SINGLE_CARD_CROP,
          TEMP_SINGLE,
          "choice-rescan-retry",
          expectedWeaponName,
        );
      },
      (value) => value.stats,
    );
    if (retry) result = retry;

    const { stats } = result;
    log.log(
      `[RivenScan] choice rescan: ${stats.length} stats found`,
      stats.map((s) => `${s.positive ? "+" : "-"}${s.value ?? "?"}% ${s.name}`).join(", "),
    );
    return stats;
  } catch (err) {
    log.warn("[RivenScan] choice rescan OCR failed:", String(err));
    return [];
  }
}

export const __test__ = Object.freeze({
  preprocessOcrText,
  sanitiseValue,
  extractSignAndValue,
  scoreStatsCandidate,
});
