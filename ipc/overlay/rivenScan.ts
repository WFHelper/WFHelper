"use strict";

/**
 * OCR scanning for the riven rolling screen.
 *
 * Scanning strategy:
 *  1. Session opens → scanInitialCard() — OCR the centered single card
 *  2. Roll confirmed → scanNewRoll() — OCR only the RIGHT panel (new roll)
 *  3. Choice confirmed → scanChoiceResult() — OCR single card, compare to
 *     previous stats to determine which side was kept
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

const log = withScope("rivenScan");

// __dirname at runtime is .electron-build/ipc/overlay/ — three levels up to reach project root
const OCR_SCRIPT = path.join(__dirname, "..", "..", "..", "scripts", "ocr.ps1");
const TEMP_RIGHT = path.join(os.tmpdir(), "wf-companion-riven-right-ocr.png");
const TEMP_SINGLE = path.join(os.tmpdir(), "wf-companion-riven-single-ocr.png");
const OCR_TIMEOUT_MS = 8000;

// Use the same OCR engine the user selected in overlay settings (e.g. "tesseract").
// Without this, the riven scanner would default to "auto" (PowerShell first) even when
// the user explicitly picked Tesseract.
function getRequestedOcrEngine(): string {
  try {
    const settings = getRewardScannerSettings();
    const engine = typeof settings?.ocrEngine === "string" ? settings.ocrEngine.trim().toLowerCase() : "";
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

  // Rejoin "Critical Chance" + "for Slide Attack" when OCR splits across lines.
  // The game card wraps long stat names.  OCR often inserts junk between the
  // two fragments — e.g. "Critical Chance -\n- 4 for Slide Attack".
  // Allow up to 20 non-letter characters (digits, signs, newlines, spaces)
  // between "Chance" and "for" to absorb OCR noise.
  text = text.replace(/Critical\s+Chance[^a-zA-Z]{0,20}for\s+Slide\s+Attack/gi, "Critical Chance for Slide Attack");

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

function parseStatsFromLines(text: string): RivenStat[] {
  const lines = text
    .split(/\r?\n/);

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

export interface RollPanelResult {
  left: RivenStat[];
  right: RivenStat[];
}

// ── Image enhancement (Sharp-based) ──────────────────────────────────────────
// Uses Sharp (Lanczos3) for high-quality upscaling + brightness thresholding
// + 1px morphological dilation to connect broken character strokes.  This
// produces significantly cleaner text for Windows OCR than Electron's built-in
// nativeImage.resize.

const MIN_OCR_WIDTH = 1800;

interface EnhanceMode {
  kind: "bright";
  threshold: number;
  /** Apply 1px morphological dilation after thresholding to connect broken
   *  character strokes.  Slightly increases noise but recovers fragmented
   *  letters (especially at bright-120 where strokes are thinner). */
  dilate?: boolean;
}

// Enhancement strategies — bright-150 (clean, fast), then bright-120 + dilation
// (catches dimmer text with stroke repair).
const ENHANCE_STRATEGIES: EnhanceMode[] = [
  { kind: "bright", threshold: 150 },
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
    .resize(scaledW, scaledH, { kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer();

  // Brightness threshold: build a binary mask (1 = text, 0 = background)
  const pixelCount = scaledW * scaledH;
  const mask = Buffer.alloc(pixelCount);
  for (let i = 0, j = 0; i < rawBuffer.length; i += 4, j++) {
    const r = rawBuffer[i];
    const g = rawBuffer[i + 1];
    const b = rawBuffer[i + 2];
    mask[j] = Math.max(r, g, b) >= mode.threshold ? 1 : 0;
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
            const nx = x + dx, ny = y + dy;
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
  }).png().toBuffer();
}

// ── Crop region (normalised ratios for 1920×1080) ───────────────────────────
// Full lower band — captures stat text from both/all cards in one pass.
// Testing showed this consistently outperforms narrow per-panel crops because
// Windows OCR benefits from more surrounding context.
const FULL_LOWER = { x: 0.02, y: 0.45, width: 0.96, height: 0.42 };
// Center-only crop for choice rescan — after the choice dialog the game shows
// a single centered card.  Using a narrower crop avoids capturing stale text
// from the two-card transition animation that lingers at the screen edges.
const CENTER_LOWER = { x: 0.20, y: 0.45, width: 0.60, height: 0.42 };

/**
 * Score a set of parsed stats: higher = better OCR result.
 * Stats with values are worth more than stats with just names.
 * Bonus for higher numeric values — OCR dropping digits always produces
 * *smaller* numbers, so higher values indicate more confident reads.
 */
function scoreStats(stats: RivenStat[]): number {
  return stats.reduce((sum, s) => {
    if (s.value === null) return sum + 3;
    // Base 10 for having a value, plus up to 10 bonus based on magnitude.
    // Caps at 200 to avoid outliers dominating.
    return sum + 10 + Math.min(Math.abs(s.value), 200) / 20;
  }, 0);
}

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
): Promise<{ text: string; stats: RivenStat[] }> {
  const cropped = cropRect(image, rect);

  let bestText = "";
  let bestStats: RivenStat[] = [];
  let bestScore = -1;

  for (const mode of ENHANCE_STRATEGIES) {
    const modeLabel = `bright-${mode.threshold}${mode.dilate ? "+dilate" : ""}`;
    const enhancedPng = await enhanceForRivenOcr(cropped, mode);
    fs.writeFileSync(tempPath, enhancedPng);
    let text: string;
    try {
      text = await ocrRunner.runOCR(tempPath, OCR_TIMEOUT_MS);
    } catch {
      continue;
    }

    const stats = parseRivenStats(text);
    const score = scoreStats(stats);

    if (label) {
      const preview = text.replace(/\r?\n/g, " | ").slice(0, 150);
      log.log(`[RivenScan] OCR ${label} ${modeLabel}: ${stats.length} stats (score=${score}) "${preview}"`);
    }

    if (score > bestScore) {
      bestScore = score;
      bestText = text;
      bestStats = stats;
    }

    // Early exit: if this strategy found ≥3 stats and ALL have numeric values,
    // skip remaining strategies — the result is already high-confidence.
    if (stats.length >= 3 && stats.every((s) => s.value !== null)) {
      break;
    }
  }

  return { text: bestText, stats: bestStats };
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

export async function scanInitialCard(): Promise<InitialScanResult> {
  const capture = await captureScreen();
  if (!capture) {
    log.warn("[RivenScan] scanInitialCard: captureScreen returned null");
    return { stats: [], rawText: "" };
  }

  const imgSize = capture.image.getSize?.() ?? { width: "?", height: "?" };
  log.log(`[RivenScan] initial capture: source=${capture.sourceType} name="${capture.sourceName}" size=${imgSize.width}x${imgSize.height}`);

  try {
    const { stats, text } = await ocrCropMultiStrategy(capture.image, FULL_LOWER, TEMP_SINGLE, "initial-card");
    log.log(`[RivenScan] initial card scan: ${stats.length} stats found`, stats.map((s) => `${s.positive ? "+" : "-"}${s.value ?? "?"}% ${s.name}`).join(", "));
    return { stats, rawText: text };
  } catch (err) {
    log.warn("[RivenScan] initial card OCR failed:", String(err));
    return { stats: [], rawText: "" };
  }
}

/**
 * Capture and OCR only the RIGHT panel (new roll) after the roll animation.
 * The left panel is skipped — we already have those stats from the initial scan.
 */
export async function scanNewRoll(): Promise<RivenStat[]> {
  const startAt = Date.now();

  const capture = await captureScreen();
  if (!capture) {
    log.warn("[RivenScan] scanNewRoll: captureScreen returned null");
    return [];
  }

  const image = capture.image;
  const imgSize = image.getSize?.() ?? { width: "?", height: "?" };
  log.log(`[RivenScan] roll capture: source=${capture.sourceType} name="${capture.sourceName}" size=${imgSize.width}x${imgSize.height}`);

  try {
    const { stats } = await ocrCropMultiStrategy(image, FULL_LOWER, TEMP_RIGHT, "roll");
    log.log(`[RivenScan] roll scan: ${stats.length} stats, elapsed=${Date.now() - startAt}ms`);

    // If nothing found, retry after a short delay (animation may not have finished)
    if (stats.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      const capture2 = await captureScreen();
      if (capture2) {
        const { stats: retryStats } = await ocrCropMultiStrategy(capture2.image, FULL_LOWER, TEMP_RIGHT, "roll-retry");
        log.log(`[RivenScan] roll-retry scan: ${retryStats.length} stats, elapsed=${Date.now() - startAt}ms`);
        return retryStats;
      }
    }

    return stats;
  } catch (err) {
    log.warn("[RivenScan] roll scan OCR failed:", String(err));
    return [];
  }
}

/**
 * Capture and OCR the single card shown after a choice (kept or rerolled).
 * Uses a narrower center crop to avoid capturing stale two-card transition text.
 */
export async function scanChoiceRescan(): Promise<RivenStat[]> {
  const capture = await captureScreen();
  if (!capture) {
    log.warn("[RivenScan] scanChoiceRescan: captureScreen returned null");
    return [];
  }

  try {
    const { stats } = await ocrCropMultiStrategy(capture.image, CENTER_LOWER, TEMP_SINGLE, "choice-rescan");
    log.log(`[RivenScan] choice rescan: ${stats.length} stats found`, stats.map((s) => `${s.positive ? "+" : "-"}${s.value ?? "?"}% ${s.name}`).join(", "));
    return stats;
  } catch (err) {
    log.warn("[RivenScan] choice rescan OCR failed:", String(err));
    return [];
  }
}

/**
 * Capture the single-card post-choice screen and determine which side was kept.
 * Called after the choice SendResult fires.
 *
 * Optimised for speed: uses only a single enhancement strategy (bright-150)
 * since we only need stat NAMES for comparison, not values.
 */
export async function scanChoiceResult(
  previousInitial: RivenStat[],
  previousNewRoll: RivenStat[],
): Promise<"left" | "right" | "unknown"> {
  const capture = await captureScreen();
  if (!capture) return "unknown";

  try {
    // Single-strategy OCR for speed — only need stat names, not values
    const cropped = cropRect(capture.image, FULL_LOWER);
    const mode: EnhanceMode = { kind: "bright", threshold: 150 };
    const enhancedPng = await enhanceForRivenOcr(cropped, mode);
    fs.writeFileSync(TEMP_SINGLE, enhancedPng);
    const text = await ocrRunner.runOCR(TEMP_SINGLE, OCR_TIMEOUT_MS);
    const current = parseRivenStats(text);

    if (current.length === 0) {
      log.log("[RivenScan] choice scan: 0 stats found");
      return "unknown";
    }

    const currentNames = new Set(current.map((s) => s.name.toLowerCase()));

    const initialMatches = previousInitial.filter((s) => currentNames.has(s.name.toLowerCase())).length;
    const newRollMatches = previousNewRoll.filter((s) => currentNames.has(s.name.toLowerCase())).length;

    log.log(`[RivenScan] choice detection: initialMatches=${initialMatches} newRollMatches=${newRollMatches} (scanned: ${current.map(s => s.name).join(", ")})`);

    // "left" = kept the old/initial stats, "right" = chose the new roll
    if (initialMatches >= 2 && initialMatches > newRollMatches) return "left";
    if (newRollMatches >= 2 && newRollMatches > initialMatches) return "right";
    return "unknown";
  } catch (err) {
    log.warn("[RivenScan] choice scan OCR failed:", String(err));
    return "unknown";
  }
}
