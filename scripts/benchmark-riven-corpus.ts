#!/usr/bin/env npx tsx
/**
 * Riven OCR corpus benchmark — production pipeline.
 *
 * Runs all images in OCR-debug/riven_images/ through the SAME two-strategy
 * flow used in production (ipc/overlay/rivenScan.ts):
 *
 *   1. `original`          — natural-colour PNG, lanczos3 upscale to ≥1800 px
 *   2. `bright-150+dilate` — linear upscale, max-channel ≥ 150 threshold, 1-px dilate
 *
 * OCR engine: @napi-rs/system-ocr (Windows.Media.Ocr, same as production).
 * Text parsing: imports from ipc/overlay/rivenScanText.ts (the LIVE code).
 *
 * Crop constants match production:
 *   single-card  → SINGLE_CARD_CROP { x: 0.22, y: 0.43, w: 0.56, h: 0.45 }
 *   multipanel   → ROLL_CARD_CROP   { x: 0.38, y: 0.35, w: 0.26, h: 0.45 }
 */

import fs from "node:fs";
import path from "node:path";

// Production text-parsing pipeline (uses the live FIFO-queue fix)
import {
  parseRivenStats,
  splitRivenStructuredText,
  preprocessOcrText,
  scoreStatsCandidate,
  type RivenStat,
} from "../ipc/overlay/rivenScanText.js";

// Production crop definitions (kept in sync with rivenScan.ts)
const SINGLE_CARD_CROP = { x: 0.22, y: 0.43, width: 0.56, height: 0.45 };
const ROLL_CARD_CROP   = { x: 0.42, y: 0.35, width: 0.20, height: 0.45 };
const MIN_OCR_WIDTH    = 1800;

// ── Native OCR ───────────────────────────────────────────────────────────────
let _nativeRecognize: ((input: Buffer) => Promise<{ text: string; confidence: number }>) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("@napi-rs/system-ocr") as {
    recognize: (input: Buffer) => Promise<{ text: string; confidence: number }>;
  };
  _nativeRecognize = mod.recognize;
} catch {
  /* falls through to error at runtime */
}

async function nativeOcr(pngBuffer: Buffer): Promise<{ text: string; ms: number }> {
  if (!_nativeRecognize) return { text: "", ms: 0 };
  const t0 = Date.now();
  const result = await _nativeRecognize(pngBuffer);
  return { text: result.text || "", ms: Date.now() - t0 };
}

// ── Image helpers ─────────────────────────────────────────────────────────────
async function loadRgba(
  filePath: string,
): Promise<{ data: Buffer; width: number; height: number }> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function cropRgba(
  img: { data: Buffer; width: number; height: number },
  rect: { x: number; y: number; width: number; height: number },
): { data: Buffer; width: number; height: number } {
  const cx = Math.floor(img.width * rect.x);
  const cy = Math.floor(img.height * rect.y);
  const cw = Math.max(1, Math.floor(img.width * rect.width));
  const ch = Math.max(1, Math.floor(img.height * rect.height));
  const out = Buffer.alloc(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const srcRow = Math.min(cy + row, img.height - 1);
    const srcOff = (srcRow * img.width + cx) * 4;
    const dstOff = row * cw * 4;
    const copyLen = Math.min(cw * 4, img.data.length - srcOff);
    if (copyLen > 0) img.data.copy(out, dstOff, srcOff, srcOff + copyLen);
  }
  return { data: out, width: cw, height: ch };
}

// Replicates enhanceForRivenOcr({ kind: "original" })
async function enhanceOriginal(
  cropped: { data: Buffer; width: number; height: number },
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const { width, height, data } = cropped;
  const scale = width >= MIN_OCR_WIDTH ? 1 : Math.min(3, Math.ceil(MIN_OCR_WIDTH / width));
  if (scale <= 1) {
    return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  }
  const sw = Math.min(6000, width * scale);
  const sh = Math.min(6000, height * scale);
  return sharp(data, { raw: { width, height, channels: 4 } })
    .resize(sw, sh, { kernel: "lanczos3" })
    .png()
    .toBuffer();
}

// Replicates enhanceForRivenOcr({ kind: "bright", threshold: 150, dilate: true })
async function enhanceBright150Dilate(
  cropped: { data: Buffer; width: number; height: number },
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const { width, height, data } = cropped;
  const scale = width >= MIN_OCR_WIDTH ? 1 : Math.ceil(MIN_OCR_WIDTH / width);
  const sw = Math.min(6000, width * scale);
  const sh = Math.min(6000, height * scale);

  const rawBuf = await sharp(data, { raw: { width, height, channels: 4 } })
    .resize(sw, sh, { kernel: "linear" })
    .ensureAlpha()
    .raw()
    .toBuffer();

  const pixelCount = sw * sh;
  const mask = Buffer.alloc(pixelCount);
  for (let bi = 0, pi = 0; bi < rawBuf.length; bi += 4, pi++) {
    const maxC = Math.max(rawBuf[bi], rawBuf[bi + 1], rawBuf[bi + 2]);
    mask[pi] = maxC >= 150 ? 1 : 0;
  }

  const output = Buffer.alloc(pixelCount);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let found = false;
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (let dx = -1; dx <= 1 && !found; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < sw && ny >= 0 && ny < sh && mask[ny * sw + nx]) found = true;
        }
      }
      output[y * sw + x] = found ? 0 : 255;
    }
  }

  return sharp(output, { raw: { width: sw, height: sh, channels: 1 } }).png().toBuffer();
}

// Matches textToStructuredResult in rewardScannerOcr.ts — same as production
function textToStructuredResult(text: string) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => ({
      text: line,
      box: { left: 0, top: 0, width: 0, height: 0 },
      words: line
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => ({ text: word, box: { left: 0, top: 0, width: 0, height: 0 } })),
    }));
  return { text: text || "", lines };
}

// ── Production candidate types (mirrors ipc/overlay/rivenScan.ts) ───────────
interface BenchmarkCandidate {
  modeLabel: string;
  text: string;
  stats: RivenStat[];
  score: number;
  valueCount: number;
}

// Exact copy of isConfidentEnough from ipc/overlay/rivenScan.ts
function isConfidentEnough(c: BenchmarkCandidate): boolean {
  if (c.score < 0) return false;
  if (c.stats.length >= 4 && c.valueCount >= 3 && c.score >= 75) return true;
  if (c.stats.length >= 3 && c.valueCount >= 3 && c.score >= 85) return true;
  if (c.stats.length === 2 && c.valueCount === 2 && c.score >= 55) return true;
  return false;
}

function formatStats(stats: RivenStat[]): string {
  if (stats.length === 0) return "(none)";
  return stats
    .map((s) => {
      const sign = s.positive ? "+" : "-";
      const val = s.value === null ? "?" : s.multiplier ? `x${s.value}` : `${s.value}%`;
      return `${sign}${val} ${s.name}`;
    })
    .join(", ");
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!_nativeRecognize) {
    console.error("ERROR: @napi-rs/system-ocr not available — cannot run benchmark");
    process.exit(1);
  }

  const corpusDir = path.join(process.cwd(), "OCR-debug", "riven_images");
  const files = fs
    .readdirSync(corpusDir)
    .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
    .sort();

  console.log(`Riven OCR benchmark — production pipeline (${files.length} images)\n`);

  const strategies: Array<{
    label: string;
    enhance: (c: { data: Buffer; width: number; height: number }) => Promise<Buffer>;
  }> = [
    { label: "original",          enhance: enhanceOriginal },
    { label: "bright-150+dilate", enhance: enhanceBright150Dilate },
  ];

  let totalMs = 0;
  let totalImages = 0;
  let totalStatsFound = 0;
  let totalStatsWithValues = 0;

  for (const file of files) {
    const fullPath = path.join(corpusDir, file);
    const isMultipanel = /multipanel/i.test(file);
    const crop = isMultipanel ? ROLL_CARD_CROP : SINGLE_CARD_CROP;
    const cropLabel = isMultipanel ? "ROLL_CARD_CROP" : "SINGLE_CARD_CROP";

    console.log(`\n=== ${file} [${cropLabel}] ===`);

    const img = await loadRgba(fullPath);
    const cropped = cropRgba(img, crop);
    console.log(`  full ${img.width}x${img.height} → crop ${cropped.width}x${cropped.height}`);

    let imageMs = 0;
    const candidates: BenchmarkCandidate[] = [];
    let earlyExit = false;

    // Strategy loop — same order as ENHANCE_STRATEGIES in production
    for (const strategy of strategies) {
      const t0 = Date.now();
      const png = await strategy.enhance(cropped);
      const ocr = await nativeOcr(png);
      const ocrMs = Date.now() - t0;
      imageMs += ocrMs;

      const structured = textToStructuredResult(ocr.text);
      const split = splitRivenStructuredText(structured);
      const stats = parseRivenStats(split.statsText || ocr.text || "");
      const valueCount = stats.filter((s) => s.value !== null).length;
      const score = scoreStatsCandidate(stats, ocr.text);

      const rawPreview = preprocessOcrText(ocr.text).replace(/\r?\n/g, " | ").slice(0, 120);
      console.log(`  [${strategy.label}] ${ocrMs}ms  ${stats.length} stats (${valueCount} values, score=${score})`);
      console.log(`    raw: "${rawPreview}"`);
      console.log(`    → ${formatStats(stats)}`);

      const candidate: BenchmarkCandidate = { modeLabel: strategy.label, text: ocr.text, stats, score, valueCount };
      candidates.push(candidate);

      if (isConfidentEnough(candidate)) {
        earlyExit = true;
        break; // matches production isConfidentEnough early-accept
      }
    }

    // Score-based selection — exact tie-break order from production
    let chosen = candidates[0];
    for (const c of candidates.slice(1)) {
      if (c.score > chosen.score) { chosen = c; continue; }
      if (c.score < chosen.score) continue;
      if (c.stats.length > chosen.stats.length) { chosen = c; continue; }
      if (c.stats.length < chosen.stats.length) continue;
      if (c.valueCount > chosen.valueCount) { chosen = c; }
    }

    // Cross-strategy injection — exact copy of production ocrCropMultiStrategy
    let finalStats = chosen.stats;
    const nullSlots = chosen.stats.map((s, i) => (s.value === null ? i : -1)).filter((i) => i >= 0);
    if (nullSlots.length > 0) {
      const assignedValues = new Set(
        chosen.stats.filter((s) => s.value !== null).map((s) => s.value as number),
      );
      const orphanValues: Array<{ value: number; positive: boolean }> = [];
      for (const c of candidates) {
        if (c === chosen) continue;
        const cleaned = preprocessOcrText(c.text || "");
        for (const match of cleaned.matchAll(/([+\-])\s*(\d+\.?\d*)\s*%/g)) {
          const v = parseFloat(match[2]);
          if (!Number.isFinite(v) || v <= 0) continue;
          if (assignedValues.has(v)) continue;
          if (orphanValues.some((o) => Math.abs(o.value - v) < 0.5)) continue;
          orphanValues.push({ value: v, positive: match[1] !== "-" });
        }
      }
      if (orphanValues.length > 0) {
        const injected = chosen.stats.slice();
        let orphanIdx = 0;
        for (const nullIdx of nullSlots) {
          if (orphanIdx >= orphanValues.length) break;
          injected[nullIdx] = {
            ...injected[nullIdx],
            value: orphanValues[orphanIdx].value,
            positive: orphanValues[orphanIdx].positive,
          };
          orphanIdx++;
        }
        if (orphanIdx > 0) {
          console.log(`  [injection] filled ${orphanIdx} null slot(s) from alternate strategy`);
          finalStats = injected;
        }
      }
    }

    const bestValueCount = finalStats.filter((s) => s.value !== null).length;
    totalMs += imageMs;
    totalImages++;
    totalStatsFound += finalStats.length;
    totalStatsWithValues += bestValueCount;

    console.log(`  BEST: ${chosen.modeLabel}${earlyExit ? " [early-accept]" : ""} → ${finalStats.length} stats, ${bestValueCount} values (${imageMs}ms total)`);
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`SUMMARY  ${totalImages} images  |  avg ${Math.round(totalMs / totalImages)}ms/image`);
  console.log(`Stats found: ${totalStatsFound} total, ${totalStatsWithValues} with values`);
  console.log(`Avg stats/image: ${(totalStatsFound / totalImages).toFixed(1)}`);
})();
