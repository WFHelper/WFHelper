#!/usr/bin/env npx tsx
/**
 * Riven OCR Debug Tool
 *
 * Tests the full riven OCR pipeline with multiple enhancement strategies
 * and saves all intermediate images + results for inspection.
 *
 * Usage:
 *   npx tsx scripts/test-riven-ocr.ts [mode] [options]
 *
 * Modes:
 *   single          — scan a single riven card (center of screen)       [default]
 *   panels          — scan left + right comparison panels (post-roll)
 *   file <path>     — use an existing screenshot/image file
 *
 * Output (saved to ./riven-ocr-debug/):
 *   capture.png              — raw screen capture / input image
 *   crop-*.png               — cropped region(s)
 *   enhanced-*-stratN.png    — each enhancement strategy's result
 *   ocr-results.txt          — OCR text + parsed stats for each region + strategy
 *   timing.txt               — performance breakdown
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

// ── Config ──────────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(process.cwd(), "riven-ocr-debug");
const __scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1"));
const OCR_SCRIPT = path.join(__scriptDir, "ocr.ps1");
const OCR_TIMEOUT_MS = 10_000;

// Minimum pixel width for OCR input — smaller images get upscaled more
const MIN_OCR_WIDTH = 1800;

// ── Crop regions (for FULL 1920x1080 screenshots) ───────────────────────────
const CROPS = {
  SINGLE_CARD:   { x: 0.30, y: 0.38, width: 0.40, height: 0.38 },
  PRIMARY_LEFT:  { x: 0.15, y: 0.38, width: 0.28, height: 0.38 },
  PRIMARY_RIGHT: { x: 0.50, y: 0.38, width: 0.28, height: 0.38 },
  RETRY_LEFT:    { x: 0.10, y: 0.30, width: 0.35, height: 0.50 },
  RETRY_RIGHT:   { x: 0.45, y: 0.30, width: 0.35, height: 0.50 },
};

// Known riven stat names (ordered: longer compound names before shorter substrings)
const KNOWN_RIVEN_STATS: string[] = [
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
  "Electricity", "Corrosive", "Radiation", "Magnetic",
  "Cold", "Heat", "Toxin", "Viral", "Blast", "Gas",
  "Impact", "Puncture", "Slash",
  // ── Short / generic names last ──
  "Magazine", "Recoil", "Damage", "Range", "Slide", "Zoom",
];

// ── Sharp-based image processing ────────────────────────────────────────────

interface ImageInfo {
  width: number;
  height: number;
  data: Buffer;
  channels: 1 | 3 | 4;
}

async function loadImage(filePath: string): Promise<ImageInfo> {
  const sharp = require("sharp") as typeof import("sharp");
  const meta = await sharp(filePath).metadata();
  const rawBuf = await sharp(filePath).raw().ensureAlpha().toBuffer();
  return { width: meta.width!, height: meta.height!, data: rawBuf, channels: 4 };
}

async function savePng(filePath: string, img: ImageInfo): Promise<void> {
  const sharp = require("sharp") as typeof import("sharp");
  await sharp(Buffer.from(img.data), {
    raw: { width: img.width, height: img.height, channels: img.channels },
  }).png().toFile(filePath);
}

function cropImage(
  img: ImageInfo,
  rect: { x: number; y: number; width: number; height: number },
): ImageInfo {
  const cx = Math.floor(img.width * Math.max(0, Math.min(rect.x, 0.98)));
  const cy = Math.floor(img.height * Math.max(0, Math.min(rect.y, 0.98)));
  const cw = Math.min(Math.max(24, Math.floor(img.width * rect.width)), img.width - cx);
  const ch = Math.min(Math.max(24, Math.floor(img.height * rect.height)), img.height - cy);
  const bpp = img.channels;

  const out = Buffer.alloc(cw * ch * bpp);
  for (let row = 0; row < ch; row++) {
    const srcRow = Math.min(cy + row, img.height - 1);
    const srcOffset = (srcRow * img.width + cx) * bpp;
    const dstOffset = row * cw * bpp;
    const copyLen = Math.min(cw * bpp, img.data.length - srcOffset);
    if (copyLen > 0) img.data.copy(out, dstOffset, srcOffset, srcOffset + copyLen);
  }
  return { width: cw, height: ch, data: out, channels: img.channels };
}

// ── Enhancement strategies ──────────────────────────────────────────────────

interface Strategy {
  name: string;
  description: string;
  enhance: (img: ImageInfo) => Promise<ImageInfo>;
}

/** Compute upscale factor to reach at least MIN_OCR_WIDTH */
function autoScale(imgWidth: number): number {
  if (imgWidth >= MIN_OCR_WIDTH) return 1;
  return Math.ceil(MIN_OCR_WIDTH / imgWidth);
}

async function upscaleSharp(img: ImageInfo, scale: number): Promise<ImageInfo> {
  if (scale <= 1) return img;
  const sharp = require("sharp") as typeof import("sharp");
  const newW = Math.min(6000, Math.round(img.width * scale));
  const newH = Math.min(6000, Math.round(img.height * scale));

  const resized = await sharp(Buffer.from(img.data), {
    raw: { width: img.width, height: img.height, channels: img.channels },
  })
    .resize(newW, newH, { kernel: "lanczos3" })
    .toBuffer();

  return { width: newW, height: newH, data: resized, channels: img.channels };
}

/**
 * Brightness threshold: keep pixels where max(R,G,B) ≥ threshold.
 * Output: dark text on white background (inverted for OCR).
 */
function brightPixelThreshold(img: ImageInfo, threshold: number): ImageInfo {
  const out = Buffer.alloc(img.width * img.height);
  const bpp = img.channels;
  for (let i = 0, j = 0; i < img.data.length; i += bpp, j++) {
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    const maxC = Math.max(r, g, b);
    out[j] = maxC >= threshold ? 0 : 255; // inverted
  }
  return { width: img.width, height: img.height, data: out, channels: 1 };
}

/**
 * White text isolation: keep only near-white pixels (min(R,G,B) ≥ threshold).
 */
function whiteTextIsolation(img: ImageInfo, threshold: number): ImageInfo {
  const out = Buffer.alloc(img.width * img.height);
  const bpp = img.channels;
  for (let i = 0, j = 0; i < img.data.length; i += bpp, j++) {
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    const minC = Math.min(r, g, b);
    out[j] = minC >= threshold ? 0 : 255;
  }
  return { width: img.width, height: img.height, data: out, channels: 1 };
}

/**
 * Luminance threshold + 1px morphological dilation to connect broken strokes.
 */
function luminanceWithDilation(img: ImageInfo, threshold: number): ImageInfo {
  const w = img.width, h = img.height;
  const bpp = img.channels;
  const mask = Buffer.alloc(w * h);
  for (let i = 0, j = 0; i < img.data.length; i += bpp, j++) {
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    const lum = (77 * r + 150 * g + 29 * b) >> 8;
    mask[j] = lum >= threshold ? 1 : 0;
  }

  const dilated = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let found = false;
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (let dx = -1; dx <= 1 && !found; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && mask[ny * w + nx]) {
            found = true;
          }
        }
      }
      dilated[y * w + x] = found ? 0 : 255; // inverted
    }
  }
  return { width: w, height: h, data: dilated, channels: 1 };
}

/**
 * Low saturation + high brightness filter.
 * Stat text is near-white (low saturation), background elements are coloured.
 */
function lowSatHighBright(img: ImageInfo, minBright: number, maxSat: number): ImageInfo {
  const out = Buffer.alloc(img.width * img.height);
  const bpp = img.channels;
  for (let i = 0, j = 0; i < img.data.length; i += bpp, j++) {
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
    out[j] = (maxC >= minBright && sat <= maxSat) ? 0 : 255;
  }
  return { width: img.width, height: img.height, data: out, channels: 1 };
}

const STRATEGIES: Strategy[] = [
  {
    name: "bright-120",
    description: "Brightness threshold (max channel ≥ 120), auto-upscale — for dim left panel",
    enhance: async (img) => {
      const s = autoScale(img.width);
      const upscaled = await upscaleSharp(img, s);
      return brightPixelThreshold(upscaled, 120);
    },
  },
  {
    name: "bright-150",
    description: "Brightness threshold (max channel ≥ 150), auto-upscale",
    enhance: async (img) => {
      const s = autoScale(img.width);
      const upscaled = await upscaleSharp(img, s);
      return brightPixelThreshold(upscaled, 150);
    },
  },
  {
    name: "bright-180",
    description: "Brightness threshold (max channel ≥ 180), auto-upscale",
    enhance: async (img) => {
      const s = autoScale(img.width);
      const upscaled = await upscaleSharp(img, s);
      return brightPixelThreshold(upscaled, 180);
    },
  },
  {
    name: "bright-200",
    description: "Brightness threshold (max channel ≥ 200), auto-upscale",
    enhance: async (img) => {
      const s = autoScale(img.width);
      const upscaled = await upscaleSharp(img, s);
      return brightPixelThreshold(upscaled, 200);
    },
  },
  {
    name: "lum-dilate-160",
    description: "Luminance ≥ 160 + 1px dilation, auto-upscale",
    enhance: async (img) => {
      const s = autoScale(img.width);
      const upscaled = await upscaleSharp(img, s);
      return luminanceWithDilation(upscaled, 160);
    },
  },
  {
    name: "lum-dilate-180",
    description: "Luminance ≥ 180 + 1px dilation, auto-upscale",
    enhance: async (img) => {
      const s = autoScale(img.width);
      const upscaled = await upscaleSharp(img, s);
      return luminanceWithDilation(upscaled, 180);
    },
  },
  {
    name: "lowsat-bright",
    description: "Low saturation (≤ 0.35) + brightness ≥ 160, auto-upscale",
    enhance: async (img) => {
      const s = autoScale(img.width);
      const upscaled = await upscaleSharp(img, s);
      return lowSatHighBright(upscaled, 160, 0.35);
    },
  },
];

// ── OCR ─────────────────────────────────────────────────────────────────────

function runPowerShellOCR(imagePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OCR timeout")), OCR_TIMEOUT_MS);
    execFile(
      "powershell",
      ["-ExecutionPolicy", "Bypass", "-NonInteractive", "-File", OCR_SCRIPT, imagePath],
      { timeout: OCR_TIMEOUT_MS, encoding: "utf8" },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        if (err) {
          reject(new Error(`PowerShell OCR failed: ${err.message}${stderr ? `\n${stderr.trim()}` : ""}`));
          return;
        }
        resolve(stdout || "");
      },
    );
  });
}

// ── OCR text preprocessing ──────────────────────────────────────────────────
// Windows OCR frequently inserts spaces inside numbers on stylised game text.
// "+1 51,7% Damage" → "+151,7% Damage"
// "+1 66,6 Z Critical Chance" → "+166,6% Critical Chance"

function preprocessOcrText(raw: string): string {
  let text = raw;

  // Fix OCR misread of "%" as "0/0", "O/O", "0/o", etc.
  text = text.replace(/0\/0/g, "%");
  text = text.replace(/O\/O/gi, "%");
  text = text.replace(/o\/o/g, "%");

  // Fix OCR misreads: "Z" right after a digit is likely "%"
  text = text.replace(/(\d)\s*Z\b/g, "$1%");

  // ── Decimal-separator recovery ──
  // Warframe uses commas as decimal separator (German locale).  OCR often
  // reads "73,9%" as "73 9%" (space instead of comma) or drops the comma
  // entirely ("739%").  Do this BEFORE the space-collapse passes so the
  // digit after the comma is not glued to the integer part.
  text = text.replace(/,(\d)/g, ".$1");

  // Recover "digit SPACE single-digit %" pattern — the space is a lost comma.
  // E.g. "73 9%" → "73.9%",  "165 4%" → "165.4%"
  text = text.replace(/(\d)\s([1-9])\s*%/g, "$1.$2%");

  // Collapse spaces within number sequences following a sign.
  // "+1 51,7%" → "+151,7%"   "+1 6 6,6" → "+166,6"
  // Do multiple passes for multi-split numbers like "+1 5 1,7"
  for (let pass = 0; pass < 5; pass++) {
    text = text.replace(
      /([+\-\u2013]\s*\d+)\s+(\d)/g,
      "$1$2",
    );
  }

  // Also collapse spaces between adjacent digits (no sign prefix)
  for (let pass = 0; pass < 5; pass++) {
    text = text.replace(
      /(\d)\s+(\d)/g,
      "$1$2",
    );
  }

  // Remove stray non-digit characters embedded inside numbers
  // (icon artifacts read as letters between digits: "+15I,7%" → "+15,7%")
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

  // Strip "(x2 for Heavy Attacks)" qualifier BEFORE symbol strip removes parens.
  // Allow OCR typos: Attacke, Attackc, etc.
  text = text.replace(/\(x\d+\s*(?:for\s*)?Heavy\s*Attack[a-z]*\)/gi, "");

  // Strip element icon artifacts before stat names.
  // Warframe prefixes element stats with icons that OCR reads as junk like
  // brackets, arrows, circled chars, symbols.
  text = text.replace(/[*()\[\]{}|\\<>^~°©®™•→←↑↓↗↘►◄▸▾▲▼■□●○]+\s*/g, " ");

  // Second pass: strip "x2 for Heavy Attacks" without parentheses
  text = text.replace(/\bx\d+\s*(?:for\s*)?Heavy\s*Attack[a-z]*\b/gi, "");

  // Remove isolated single characters between a % and a known stat name
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
  text = text.replace(
    /[0-9'"`]\s*(?=(?:Slash|Cold|Heat|Electricity|Toxin|Impact|Puncture|Radiation|Viral|Corrosive|Blast|Magnetic|Gas)\b)/gi,
    "",
  );

  // Strip any single uppercase letter immediately before a known stat name
  text = text.replace(
    /\b[A-Z]\s+(?=(?:Slash|Cold|Heat|Electricity|Toxin|Impact|Puncture|Radiation|Viral|Corrosive|Blast|Magnetic|Gas)\b)/g,
    "",
  );

  // Rejoin "Critical Chance" + "for Slide Attack" when OCR splits across lines.
  // Allow up to 20 non-letter characters between to absorb OCR noise.
  text = text.replace(/Critical\s+Chance[^a-zA-Z]{0,20}for\s+Slide\s+Attack/gi, "Critical Chance for Slide Attack");

  // Strip "s" (seconds) suffix from numeric values — game shows "+8,5s Combo Duration"
  text = text.replace(/(\d)s(?=\s|$)/g, "$1");

  // Insert line breaks before stat prefixes (+/- or x-multiplier) so the parser sees separate lines.
  text = text.replace(/\s+([+\-\u2013]\d)/g, "\n$1");
  text = text.replace(/\s+(x\d)/gi, "\n$1");

  return text;
}

// ── Stat parsing ────────────────────────────────────────────────────────────

interface RivenStat {
  name: string;
  positive: boolean;
  value: number | null;
  multiplier?: boolean;
}

const MAX_REASONABLE_VALUE = 500;
function sanitiseValue(value: number): number {
  if (value > MAX_REASONABLE_VALUE && Number.isInteger(value) && value >= 100) {
    const str = String(value);
    const corrected = parseFloat(str.slice(0, -1) + "." + str.slice(-1));
    if (Number.isFinite(corrected)) return corrected;
  }
  return value;
}

/**
 * Extract a sign (+/-) and numeric value from a text fragment.
 */
function extractSignAndValue(
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

  // Try x-multiplier format: "x1,59" or "x1.59" (Warframe uses this for some stats)
  const xMultiplier = [...fragment.matchAll(/x\s*(\d+\.?\d*)/gi)];
  if (xMultiplier.length > 0) {
    const parsed = parseFloat(xMultiplier[xMultiplier.length - 1][1]);
    if (Number.isFinite(parsed)) return { positive: true, value: parsed, multiplier: true };
  }

  const numAfterSign = [...fragment.matchAll(/[+\-\u2013]\s*(\d+\.?\d*)/g)];
  if (numAfterSign.length > 0) {
    const parsed = parseFloat(numAfterSign[numAfterSign.length - 1][1]);
    if (Number.isFinite(parsed)) return { positive, value: sanitiseValue(parsed) };
  }

  if (signMatches.length > 0 || xMultiplier.length > 0) return { positive, value: null };
  return null;
}

function parseRivenStats(text: string): RivenStat[] {
  if (!text) return [];

  const cleaned = preprocessOcrText(text);

  // First pass: parse line-by-line
  const lineResults = parseStatsFromLines(cleaned);
  if (lineResults.length > 0 && lineResults.some((s) => s.value !== null)) {
    return lineResults;
  }

  // Second pass: join into one blob (OCR sometimes fragments across lines)
  const blob = cleaned.replace(/\r?\n/g, " ");
  const blobResults = parseStatsFromLines(blob);

  const lineScore = lineResults.reduce((s, r) => s + (r.value !== null ? 10 : 3), 0);
  const blobScore = blobResults.reduce((s, r) => s + (r.value !== null ? 10 : 3), 0);
  return blobScore > lineScore ? blobResults : lineResults;
}

function parseStatsFromLines(text: string): RivenStat[] {
  // Comma→period already handled in preprocessOcrText
  const lines = text.split(/\r?\n/);

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

    // Sort by position, then prefer longer stat names at the same position
    // (e.g. "Critical Chance for Slide Attack" over "Critical Chance")
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

      // Check PREFIX for value — only text between previous stat's end and this stat
      const prefixStart = i > 0 ? filtered[i - 1].idx + filtered[i - 1].stat.length : 0;
      const prefix = line.slice(prefixStart, idx);
      let extracted = extractSignAndValue(prefix);

      // If no value in prefix, check SUFFIX (OCR sometimes reorders text)
      if (!extracted || extracted.value === null) {
        const suffixEnd = i + 1 < filtered.length ? filtered[i + 1].idx : line.length;
        const suffix = line.slice(idx + stat.length, suffixEnd);
        const suffixExtracted = extractSignAndValue(suffix);
        if (suffixExtracted && suffixExtracted.value !== null) {
          extracted = suffixExtracted;
        }
      }

      const multiplier = extracted?.multiplier ?? false;
      results.push({
        name: stat,
        positive: extracted?.positive ?? true,
        value: extracted?.value ?? null,
        ...(multiplier && { multiplier: true }),
      });
    }
  }
  return results;
}

// ── Main ────────────────────────────────────────────────────────────────────

interface TimingEntry {
  label: string;
  ms: number;
}

interface StrategyResult {
  strategy: Strategy;
  ocrRaw: string;
  ocrCleaned: string;
  stats: RivenStat[];
  enhanceMs: number;
  ocrMs: number;
}

interface RegionResult {
  regionName: string;
  cropDef: { x: number; y: number; width: number; height: number };
  strategyResults: StrategyResult[];
}

async function processRegion(
  img: ImageInfo,
  cropDef: { x: number; y: number; width: number; height: number },
  regionName: string,
  strategies: Strategy[],
  timings: TimingEntry[],
): Promise<RegionResult> {
  let t0 = Date.now();
  const cropped = cropImage(img, cropDef);
  timings.push({ label: `crop-${regionName}`, ms: Date.now() - t0 });
  await savePng(path.join(OUTPUT_DIR, `crop-${regionName}.png`), cropped);
  const scale = autoScale(cropped.width);
  console.log(`  crop-${regionName}: ${cropped.width}x${cropped.height} (will upscale ${scale}×)`);

  const result: RegionResult = { regionName, cropDef, strategyResults: [] };

  for (const strategy of strategies) {
    console.log(`    ${strategy.name}: ${strategy.description}`);

    t0 = Date.now();
    let enhanced: ImageInfo;
    try {
      enhanced = await strategy.enhance(cropped);
    } catch (err) {
      console.log(`      [ENHANCE FAILED] ${(err as Error).message}`);
      result.strategyResults.push({
        strategy, ocrRaw: "", ocrCleaned: "", stats: [],
        enhanceMs: Date.now() - t0, ocrMs: 0,
      });
      continue;
    }
    const enhanceMs = Date.now() - t0;

    const enhancedPath = path.join(OUTPUT_DIR, `enhanced-${regionName}-${strategy.name}.png`);
    await savePng(enhancedPath, enhanced);

    t0 = Date.now();
    let ocrRaw = "";
    try {
      ocrRaw = await runPowerShellOCR(enhancedPath);
    } catch (err) {
      ocrRaw = `[OCR ERROR] ${(err as Error).message}`;
    }
    const ocrMs = Date.now() - t0;

    const ocrCleaned = preprocessOcrText(ocrRaw);
    const stats = parseRivenStats(ocrRaw);

    const statsStr = stats.length > 0
      ? stats.map(s => `${s.positive ? "+" : "-"}${s.value ?? "?"}% ${s.name}`).join(", ")
      : "(none)";
    console.log(`      ${enhanced.width}x${enhanced.height} | enhance ${enhanceMs}ms | ocr ${ocrMs}ms | ${stats.length} stats`);
    console.log(`      raw:     "${ocrRaw.replace(/\r?\n/g, " | ").trim().slice(0, 140)}"`);
    if (ocrCleaned !== ocrRaw) {
      console.log(`      cleaned: "${ocrCleaned.replace(/\r?\n/g, " | ").trim().slice(0, 140)}"`);
    }
    console.log(`      parsed:  ${statsStr}`);

    timings.push({ label: `${regionName}/${strategy.name}/enhance`, ms: enhanceMs });
    timings.push({ label: `${regionName}/${strategy.name}/ocr`, ms: ocrMs });

    result.strategyResults.push({ strategy, ocrRaw, ocrCleaned, stats, enhanceMs, ocrMs });
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  let mode = "single";
  let filePath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "file" && args[i + 1]) {
      mode = "file";
      filePath = path.resolve(args[i + 1]);
      i++;
    } else if (args[i] === "panels" || args[i] === "single") {
      mode = args[i];
    }
  }

  console.log("=== Riven OCR Debug Tool ===\n");
  console.log(`Mode: ${mode}`);
  console.log(`Strategies: ${STRATEGIES.map(s => s.name).join(", ")}`);
  console.log(`Min OCR width: ${MIN_OCR_WIDTH}px`);

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const timings: TimingEntry[] = [];
  let img: ImageInfo;

  if (mode === "file" && filePath) {
    console.log(`Loading: ${filePath}`);
    const t0 = Date.now();
    img = await loadImage(filePath);
    timings.push({ label: "load-file", ms: Date.now() - t0 });
    fs.copyFileSync(filePath, path.join(OUTPUT_DIR, "capture.png"));
  } else {
    console.log("Capturing screen...");
    const capturePath = path.join(OUTPUT_DIR, "capture.png");
    const t0 = Date.now();
    await captureScreenPowerShell(capturePath);
    timings.push({ label: "capture", ms: Date.now() - t0 });
    img = await loadImage(capturePath);
  }

  console.log(`Image: ${img.width}x${img.height}\n`);

  const allResults: RegionResult[] = [];

  // Determine crop regions based on mode and image dimensions
  let cropEntries: Array<[string, { x: number; y: number; width: number; height: number }]>;

  if (mode === "panels") {
    cropEntries = [
      ["left-primary", CROPS.PRIMARY_LEFT],
      ["right-primary", CROPS.PRIMARY_RIGHT],
    ];
  } else if (mode === "file") {
    const aspect = img.width / img.height;
    if (aspect < 1.0) {
      // Portrait / single card crop — stat text is in the lower ~35%
      cropEntries = [
        ["stats-area", { x: 0.02, y: 0.58, width: 0.96, height: 0.28 }],
        ["lower-half", { x: 0.02, y: 0.45, width: 0.96, height: 0.42 }],
      ];
    } else if (img.width >= 1600) {
      // Full-res screenshot — use game-calibrated crops
      // Stat text sits in the lower portion of each card
      cropEntries = [
        ["left-stats", { x: 0.20, y: 0.52, width: 0.28, height: 0.22 }],
        ["right-stats", { x: 0.50, y: 0.52, width: 0.28, height: 0.22 }],
        ["full-lower", { x: 0.02, y: 0.45, width: 0.96, height: 0.42 }],
      ];
    } else if (aspect < 1.8) {
      // Cropped two-panel image. Try both halves + full.
      cropEntries = [
        ["left-half", { x: 0.02, y: 0.45, width: 0.46, height: 0.42 }],
        ["right-half", { x: 0.50, y: 0.45, width: 0.48, height: 0.42 }],
        ["full-lower", { x: 0.02, y: 0.45, width: 0.96, height: 0.42 }],
      ];
    } else {
      // Very wide — use standard crops
      cropEntries = [
        ["single", CROPS.SINGLE_CARD],
        ["left-primary", CROPS.PRIMARY_LEFT],
        ["right-primary", CROPS.PRIMARY_RIGHT],
      ];
    }
  } else {
    cropEntries = [["single", CROPS.SINGLE_CARD]];
  }

  for (const [name, crop] of cropEntries) {
    console.log(`\n══ Region: ${name} ══`);
    const result = await processRegion(img, crop, name, STRATEGIES, timings);
    allResults.push(result);
  }

  // ── Output ──────────────────────────────────────────────────────────────

  const lines: string[] = [];
  lines.push(`Riven OCR Debug Results — ${new Date().toISOString()}`);
  lines.push(`Image: ${img.width}x${img.height}`);
  lines.push(`Mode: ${mode}`);
  lines.push("");

  for (const region of allResults) {
    lines.push(`══════════════════════════════════════════════════════════`);
    lines.push(`Region: ${region.regionName}`);
    lines.push(`Crop: x=${region.cropDef.x} y=${region.cropDef.y} w=${region.cropDef.width} h=${region.cropDef.height}`);
    lines.push("");

    let bestIdx = 0, bestScore = -1;
    for (let i = 0; i < region.strategyResults.length; i++) {
      const sr = region.strategyResults[i];
      const score = sr.stats.length * 10 + sr.stats.filter(s => s.value !== null).length;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    for (let i = 0; i < region.strategyResults.length; i++) {
      const sr = region.strategyResults[i];
      const isBest = i === bestIdx && sr.stats.length > 0;
      lines.push(`  ── ${sr.strategy.name} ${isBest ? "★ BEST" : ""} ──`);
      lines.push(`  ${sr.strategy.description}`);
      lines.push(`  enhance: ${sr.enhanceMs}ms | ocr: ${sr.ocrMs}ms`);
      lines.push(`  OCR raw:`);
      for (const tl of (sr.ocrRaw || "(empty)").split(/\r?\n/)) lines.push(`    ${tl}`);
      if (sr.ocrCleaned !== sr.ocrRaw) {
        lines.push(`  OCR cleaned:`);
        for (const tl of sr.ocrCleaned.split(/\r?\n/)) lines.push(`    ${tl}`);
      }
      lines.push(`  Parsed stats (${sr.stats.length}):`);
      for (const s of sr.stats) {
        lines.push(`    ${s.positive ? "+" : "-"}${s.value ?? "?"}% ${s.name}`);
      }
      lines.push("");
    }
  }

  const resultsPath = path.join(OUTPUT_DIR, "ocr-results.txt");
  fs.writeFileSync(resultsPath, lines.join("\n"), "utf8");

  const totalMs = timings.reduce((sum, t) => sum + t.ms, 0);
  const timingLines = [
    "Riven OCR Performance Breakdown",
    "================================",
    "",
    ...timings.map((t) => `${t.label.padEnd(45)} ${t.ms.toString().padStart(6)}ms`),
    "",
    `${"TOTAL".padEnd(45)} ${totalMs.toString().padStart(6)}ms`,
  ];
  fs.writeFileSync(path.join(OUTPUT_DIR, "timing.txt"), timingLines.join("\n"), "utf8");

  // Summary
  console.log("\n\n=== SUMMARY ===");
  for (const region of allResults) {
    console.log(`\n${region.regionName}:`);
    for (const sr of region.strategyResults) {
      const statsStr = sr.stats.length > 0
        ? sr.stats.map(s => `${s.positive ? "+" : "-"}${s.value ?? "?"}% ${s.name}`).join(", ")
        : "(none)";
      const totalT = sr.enhanceMs + sr.ocrMs;
      console.log(`  ${sr.strategy.name.padEnd(20)} ${String(sr.stats.length).padStart(1)} stats  ${String(totalT + "ms").padStart(8)}  ${statsStr}`);
    }
  }

  console.log(`\n\nAll output saved to: ${OUTPUT_DIR}`);
}

// ── Screen capture ──────────────────────────────────────────────────────────

function captureScreenPowerShell(outPath: string): Promise<void> {
  const ps1 = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bounds = $screen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$graphics.Dispose()
$bmp.Save("${outPath.replace(/\\/g, "\\\\")}")
$bmp.Dispose()
Write-Output "OK"
`;
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-ExecutionPolicy", "Bypass", "-NonInteractive", "-Command", ps1],
      { timeout: 10_000, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Screen capture failed: ${err.message}${stderr ? `\n${stderr}` : ""}`));
          return;
        }
        if (!fs.existsSync(outPath)) {
          reject(new Error("Screen capture produced no output file"));
          return;
        }
        resolve();
      },
    );
  });
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
