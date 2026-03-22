#!/usr/bin/env npx tsx
/**
 * Riven OCR benchmark — FULL production pipeline.
 *
 * Mirrors ipc/overlay/rivenScan.ts `ocrCropMultiStrategy` exactly:
 *
 *   Phase 0 (CRNN): ONNX variance-row-detect + custom CRNN recognizer (pure Node.js)
 *     → fast path, no Python/WinRT dependency
 *     → if >= MIN_ACCEPTABLE_RIVEN_STATS found, skip Phases 1+2 entirely
 *   Phase 1 (Native/WinRT): 3 enhancement strategies × rough crop
 *     → early-accept if confident enough
 *     → cross-strategy value injection for null slots
 *   Phase 2 (Tesseract fallback): only when nulls remain or <2 stats
 *     → same crop variants × strategies, but via tesseract.js WASM worker
 *     → outright-better check, then cross-engine injection by stat name, then orphan values
 *
 * Reports per-image:
 *   - CRNN-only time, stat count, values, accuracy
 *   - Native-only time (when CRNN fails), stat count, values, accuracy
 *   - Full pipeline time (native + tesseract when triggered), stat count, values, accuracy
 *
 * Usage:
 *   npx tsx scripts/benchmark-riven-production.ts
 *   npx tsx scripts/benchmark-riven-production.ts --crnn-only   # CRNN path only (fastest)
 *   npx tsx scripts/benchmark-riven-production.ts --skip-crnn   # WinRT+Tesseract only
 */

import fs from "node:fs";
import path from "node:path";

import {
  parseRivenStats,
  splitRivenStructuredText,
  preprocessOcrText,
  scoreStatsCandidate,
  type RivenStat,
} from "../ipc/overlay/rivenScanText.js";

import { recognizeRivenCardLines } from "../services/rivenOcrOnnx.js";

// ── CLI flags ────────────────────────────────────────────────────────────────
const CRNN_ONLY = process.argv.includes("--crnn-only");
const SKIP_CRNN = process.argv.includes("--skip-crnn");

// ── Constants matching production ────────────────────────────────────────────
const SINGLE_CARD_CROP = { x: 0.22, y: 0.43, width: 0.56, height: 0.45 };
// Production ROLL_CARD_CROP (matches rivenScan.ts AlecaFrame math):
const ROLL_CARD_CROP = { x: 0.411, y: 0.416, width: 0.177, height: 0.434 };
const MIN_OCR_WIDTH = 1800;
const MIN_ACCEPTABLE_RIVEN_STATS = 2;

type EnhanceMode =
  | { kind: "original" }
  | { kind: "bright"; threshold: number; dilate?: boolean };

const ENHANCE_STRATEGIES: readonly EnhanceMode[] = [
  { kind: "original" },
  { kind: "bright", threshold: 150, dilate: true },
  { kind: "bright", threshold: 120, dilate: true },
];

// Tesseract: original first (best text accuracy for early-accept), then bright-120.
const TESSERACT_STRATEGIES: readonly EnhanceMode[] = [
  { kind: "original" },
  { kind: "bright", threshold: 120, dilate: true },
];

// ── Native OCR ───────────────────────────────────────────────────────────────
let _nativeRecognize: ((input: Buffer) => Promise<{ text: string; confidence: number }>) | null =
  null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("@napi-rs/system-ocr") as {
    recognize: (input: Buffer) => Promise<{ text: string; confidence: number }>;
  };
  _nativeRecognize = mod.recognize;
} catch {
  /* */
}

async function nativeOcr(pngBuffer: Buffer): Promise<string> {
  if (!_nativeRecognize) throw new Error("Native OCR not available");
  const result = await _nativeRecognize(pngBuffer);
  return result.text || "";
}

// ── Tesseract OCR (persistent WASM worker, same as production) ───────────────
let _tessWorker: any = null;

async function initTesseractWorker(): Promise<any> {
  try {
    const Tesseract = require("tesseract.js") as {
      createWorker: (lang: string, oem?: number, opts?: any) => Promise<any>;
    };
    const worker = await Tesseract.createWorker("eng", 1 /* OEM.LSTM_ONLY — mirrors production ocrServer.ts */);
    return worker;
  } catch {
    return null;
  }
}

// setParameters dedup: avoid redundant calls when params haven't changed
let _lastBenchTessParamsKey = "";

async function tesseractOcr(pngBuffer: Buffer): Promise<string> {
  if (!_tessWorker) return "";
  const params = {
    tessedit_char_whitelist:
      " 1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.,()+-%x",
    tessedit_pageseg_mode: "6",
  };
  const paramsKey = JSON.stringify(params);
  if (paramsKey !== _lastBenchTessParamsKey) {
    await _tessWorker.setParameters(params);
    _lastBenchTessParamsKey = paramsKey;
  }
  // Pass buffer directly — tesseract.js accepts Buffer (no temp file needed)
  const result = await _tessWorker.recognize(pngBuffer);
  return result?.data?.text || "";
}

// ── Image helpers (Sharp-based, replicating NativeImage operations) ──────────
interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

async function loadImage(filePath: string): Promise<RawImage> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function cropRgba(
  img: RawImage,
  rect: { x: number; y: number; width: number; height: number },
): RawImage {
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

function cropAbsoluteRgba(
  img: RawImage,
  bounds: { left: number; top: number; width: number; height: number },
): RawImage {
  const x = Math.max(0, Math.floor(bounds.left));
  const y = Math.max(0, Math.floor(bounds.top));
  const w = Math.max(1, Math.min(Math.floor(bounds.width), img.width - x));
  const h = Math.max(1, Math.min(Math.floor(bounds.height), img.height - y));
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcOff = ((y + row) * img.width + x) * 4;
    const dstOff = row * w * 4;
    const copyLen = Math.min(w * 4, img.data.length - srcOff);
    if (copyLen > 0) img.data.copy(out, dstOff, srcOff, srcOff + copyLen);
  }
  return { data: out, width: w, height: h };
}

async function rawToPng(img: RawImage): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .png()
    .toBuffer();
}

// ── Enhancement (matches enhanceForRivenOcr exactly) ────────────────────────
async function enhance(img: RawImage, mode: EnhanceMode): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const { width, height, data } = img;

  if (mode.kind === "original") {
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

  // Bright threshold
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
    mask[pi] = maxC >= mode.threshold ? 1 : 0;
  }

  const output = Buffer.alloc(pixelCount);
  if (mode.dilate) {
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
  } else {
    for (let i = 0; i < pixelCount; i++) {
      output[i] = mask[i] ? 0 : 255;
    }
  }

  return sharp(output, { raw: { width: sw, height: sh, channels: 1 } }).png().toBuffer();
}

// ── Text-to-structured helper (matches production textToStructuredResult) ────
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

// ── Candidate types (mirrors production) ─────────────────────────────────────
interface CandidateResult {
  text: string;
  stats: RivenStat[];
  score: number;
  valueCount: number;
  modeLabel: string;
  cropId: string;
}

function isConfidentEnough(c: CandidateResult, statsOnly = false): boolean {
  if (c.score < 0) return false;
  if (c.stats.length >= 4 && c.valueCount >= 3 && c.score >= 75) return true;
  if (c.stats.length >= 3 && c.valueCount >= 3 && c.score >= 85) return true;
  if (!statsOnly && c.stats.length === 2 && c.valueCount === 2 && c.score >= 55) return true;
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

// Tracks the currently running eager Tesseract promise so the main loop can
// drain it between images (simulates real production behaviour where scans
// are seconds apart and a previous scan's background Tesseract always finishes
// long before the next scan begins).
let _activeTessPromise: Promise<CandidateResult[]> | null = null;

// ── Tesseract strategies runner (parallel eager start, mirrors runTesseractCandidates) ───
async function runTesseractCandidatesBenchmark(
  cropVariants: Array<{ id: string; image: RawImage }>,
  enhanceCache?: Map<string, Buffer>,
): Promise<CandidateResult[]> {
  const promise = (async (): Promise<CandidateResult[]> => {
    const candidates: CandidateResult[] = [];
    const plans: Array<{ cropId: string; mode: EnhanceMode }> = [];
    for (const mode of TESSERACT_STRATEGIES) {
      for (const cv of cropVariants) {
        plans.push({ cropId: cv.id, mode });
      }
    }
    for (const plan of plans) {
      const cv = cropVariants.find((v) => v.id === plan.cropId)!;
      const modeLabel =
        plan.mode.kind === "original"
          ? `tess:${cv.id}:original`
          : `tess:${cv.id}:bright-${plan.mode.threshold}${plan.mode.dilate ? "+dilate" : ""}`;
      try {
        const tOcr0 = Date.now();
        const cacheKey = modeLabel.replace(/^tess:/, "");
        let enhancedPng = enhanceCache?.get(cacheKey);
        if (!enhancedPng) {
          enhancedPng = await enhance(cv.image, plan.mode);
          enhanceCache?.set(cacheKey, enhancedPng);
        }
        const text = await tesseractOcr(enhancedPng);
        const tOcr1 = Date.now();
        const structured = textToStructuredResult(text);
        const split = splitRivenStructuredText(structured);
        const stats = parseRivenStats(split.statsText || text || "");
        const valueCount = stats.filter((s) => s.value !== null).length;
        const score = scoreStatsCandidate(stats, text, "", "");
        console.log(
          `    [${modeLabel}] ${tOcr1 - tOcr0}ms → ${stats.length} stats, ${valueCount} values (score=${score})`,
        );
        candidates.push({ text, stats, score, valueCount, modeLabel, cropId: cv.id });
        // Early exit on confidence (mirrors runTesseractCandidates in production)
        const last = candidates[candidates.length - 1];
        if (isConfidentEnough(last)) break;
      } catch { /* non-fatal */ }
    }
    return candidates;
  })();
  _activeTessPromise = promise;
  return promise;
}

// ── Full production ocrCropMultiStrategy (native + parallel Tesseract) ───────
async function ocrCropMultiStrategy(
  image: RawImage,
  rect: { x: number; y: number; width: number; height: number },
  ocrFn: (png: Buffer) => Promise<string>,
  label: string,
): Promise<{
  stats: RivenStat[];
  nativeMs: number;
  tessMs: number;
  tessParallelTotalMs: number;
  tessWaitedMs: number;
  tessTriggered: boolean;
  nativeOnlyStats: RivenStat[];
}> {
  // Drain the previous image's eager Tesseract if it is still running.
  // In production, scans are separated by multiple seconds so this never
  // matters, but the benchmark runs images back-to-back and the Tesseract
  // WASM worker can only process one call at a time.
  if (_activeTessPromise) {
    await _activeTessPromise.catch(() => {});
    _activeTessPromise = null;
  }

  const roughCrop = cropRgba(image, rect);

  // Build crop variants (rough only — refined crop depends on Sobel card detection
  // which uses NativeImage internals. In production, refined is skipped when coverage >= 0.25)
  const cropVariants: Array<{ id: string; image: RawImage }> = [
    { id: "rough", image: roughCrop },
  ];

  const orderedCandidates: Array<{ cropId: string; mode: EnhanceMode }> = [];
  for (const mode of ENHANCE_STRATEGIES) {
    for (const cv of cropVariants) {
      orderedCandidates.push({ cropId: cv.id, mode });
    }
  }

  // Per-scan enhance cache: avoids re-running enhance on the same crop+mode pair
  // across native and Tesseract loops (mirrors production Change 2).
  const enhanceCache = new Map<string, Buffer>();

  // === 2750 ms hard budget: mirrors AlecaFrame and production SCAN_BUDGET_MS ===
  const SCAN_BUDGET_MS = 2750;
  const scanStart = Date.now();
  let tessEagerPromise: Promise<CandidateResult[]> | null = null;
  let tessGlobalStart = 0;

  // Phase 1: Native OCR
  const nativeStart = Date.now();
  const nativeResults: CandidateResult[] = [];
  let earlyAccept: CandidateResult | null = null;

  for (const plan of orderedCandidates) {
    const cv = cropVariants.find((v) => v.id === plan.cropId)!;
    const modeLabel =
      plan.mode.kind === "original"
        ? `${cv.id}:original`
        : `${cv.id}:bright-${plan.mode.threshold}${plan.mode.dilate ? "+dilate" : ""}`;

    try {
      const nOcr0 = Date.now();
      const cacheKey = modeLabel;
      let enhancedPng = enhanceCache.get(cacheKey);
      if (!enhancedPng) {
        enhancedPng = await enhance(cv.image, plan.mode);
        enhanceCache.set(cacheKey, enhancedPng);
      }
      const text = await ocrFn(enhancedPng);
      const nOcr1 = Date.now();
      const structured = textToStructuredResult(text);
      const split = splitRivenStructuredText(structured);
      const stats = parseRivenStats(split.statsText || text || "");
      const valueCount = stats.filter((s) => s.value !== null).length;
      // Pass empty weaponName + titleText to exercise validateRivenStats path (matches production).
      const score = scoreStatsCandidate(stats, text, "", "");
      console.log(
        `    [${modeLabel}] ${nOcr1 - nOcr0}ms → ${stats.length} stats, ${valueCount} values (score=${score})`,
      );

      const result: CandidateResult = {
        text,
        stats,
        score,
        valueCount,
        modeLabel,
        cropId: cv.id,
      };
      nativeResults.push(result);

      // Always launch Tesseract after rough:original (parallel with remaining native strategies).
      if (
        tessEagerPromise === null &&
        _tessWorker &&
        cv.id === "rough" &&
        plan.mode.kind === "original"
      ) {
        tessGlobalStart = Date.now();
        tessEagerPromise = runTesseractCandidatesBenchmark(cropVariants, enhanceCache).catch(() => []);
      }

      // Hard budget: stop native loop if budget exhausted.
      if (Date.now() - scanStart >= SCAN_BUDGET_MS) break;

      // Diminishing returns: after 2 candidates, if the best so far has sufficient
      // data (2+ stats with 2+ values, score ≥20), stop — mirrors production.
      if (nativeResults.length >= 2) {
        const bestSoFar = nativeResults.reduce((a, b) => (b.score > a.score ? b : a));
        if (bestSoFar.stats.length >= 2 && bestSoFar.valueCount >= 2 && bestSoFar.score >= 20) {
          console.log(`    [diminishing-returns] sufficient after ${nativeResults.length} candidates: score=${bestSoFar.score} stats=${bestSoFar.stats.length}`);
          break;
        }
      }

      if (isConfidentEnough(result)) {
        earlyAccept = result;
        break;
      }
    } catch {
      nativeResults.push({
        text: "",
        stats: [],
        score: -1,
        valueCount: 0,
        modeLabel,
        cropId: cv.id,
      });
    }
  }

  const nativeMs = Date.now() - nativeStart;

  // Best native candidate
  let best: CandidateResult | null = earlyAccept;
  if (!best) {
    for (const r of nativeResults) {
      if (!best) { best = r; continue; }
      if (r.score > best.score) { best = r; continue; }
      if (r.score < best.score) continue;
      if (r.stats.length > best.stats.length) { best = r; continue; }
      if (r.stats.length < best.stats.length) continue;
      if (r.valueCount > best.valueCount) { best = r; continue; }
    }
  }

  let chosen = best ?? {
    text: "",
    stats: [],
    score: -1,
    valueCount: 0,
    modeLabel: "",
    cropId: "",
  };

  // Cross-strategy value injection (native-only)
  let nullSlots = chosen.stats
    .map((s, i) => (s.value === null ? i : -1))
    .filter((i) => i >= 0);
  if (nullSlots.length > 0) {
    const assignedValues = new Set(
      chosen.stats.filter((s) => s.value !== null).map((s) => s.value as number),
    );
    const orphanValues: Array<{ value: number; positive: boolean }> = [];
    for (const c of nativeResults) {
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
      let oi = 0;
      for (const ni of nullSlots) {
        if (oi >= orphanValues.length) break;
        injected[ni] = {
          ...injected[ni],
          value: orphanValues[oi].value,
          positive: orphanValues[oi].positive,
        };
        oi++;
      }
      chosen = { ...chosen, stats: injected };
    }
  }

  // x-multiplier refinement: prefer decimal values over integer for same stat.
  const intMultSlots = chosen.stats
    .map((s, i) => (s.multiplier && s.value !== null && Number.isInteger(s.value) ? i : -1))
    .filter((i) => i >= 0);
  if (intMultSlots.length > 0) {
    const refined = chosen.stats.slice();
    for (const idx of intMultSlots) {
      const statName = refined[idx].name.toLowerCase();
      for (const c of nativeResults) {
        if (c === chosen) continue;
        const match = c.stats.find(
          (cs) =>
            cs.name.toLowerCase() === statName &&
            cs.multiplier &&
            cs.value !== null &&
            !Number.isInteger(cs.value),
        );
        if (match) {
          refined[idx] = { ...refined[idx], value: match.value, positive: match.positive };
          break;
        }
      }
    }
    chosen = { ...chosen, stats: refined };
  }

  // Snapshot after native-only phase
  const nativeOnlyStats = chosen.stats.map((s) => ({ ...s }));

  // Phase 2: Await Tesseract (mirrors production gate logic).
  // tessGlobalStart set when gate triggered; tessWaitedMs = cost after native completed.
  // If gate never triggered but native still needs Tesseract, do a sequential late launch.
  let tessTriggered = false;
  let tessWaitedMs = 0;
  let tessParallelTotalMs = 0;
  const remainingNulls = chosen.stats.filter((s) => s.value === null).length;
  const statsTooFew = chosen.stats.length < MIN_ACCEPTABLE_RIVEN_STATS;

  if ((remainingNulls > 0 || statsTooFew) && tessEagerPromise) {
    tessTriggered = true;
    const waitStart = Date.now();
    const budgetRemainingMs = SCAN_BUDGET_MS - (Date.now() - scanStart);
    const tesseractCandidates = budgetRemainingMs > 0
      ? await Promise.race([
          tessEagerPromise,
          new Promise<CandidateResult[]>((r) => setTimeout(() => r([]), budgetRemainingMs)),
        ])
      : [];
    tessWaitedMs = Date.now() - waitStart;
    tessParallelTotalMs = Date.now() - tessGlobalStart; // total tess wall time (start to resolve)

    try {
      // Pick best Tesseract candidate
      let bestTess: CandidateResult | null = null;
      for (const tc of tesseractCandidates) {
        if (!bestTess || tc.score > bestTess.score) bestTess = tc;
      }

      if (bestTess && bestTess.stats.length >= MIN_ACCEPTABLE_RIVEN_STATS) {
        // Confident early-accept (Tesseract better than native)
        if (isConfidentEnough(bestTess) && bestTess.score > chosen.score) {
          chosen = { ...chosen, stats: bestTess.stats, text: bestTess.text, score: bestTess.score };
        } else {
          // Outright better?
          const tessValues = bestTess.stats.filter((s) => s.value !== null).length;
          const nativeValues = chosen.stats.filter((s) => s.value !== null).length;
          if (bestTess.score > chosen.score && tessValues > nativeValues) {
            chosen = { ...chosen, stats: bestTess.stats, text: bestTess.text, score: bestTess.score };
          } else {
            // Cross-engine injection by stat name
            nullSlots = chosen.stats
              .map((s, i) => (s.value === null ? i : -1))
              .filter((i) => i >= 0);
            if (nullSlots.length > 0) {
              const assignedValues = new Set(
                chosen.stats.filter((s) => s.value !== null).map((s) => s.value as number),
              );
              const injected = chosen.stats.slice();
              let injectedCount = 0;
              for (const ni of nullSlots) {
                const statName = injected[ni].name.toLowerCase();
                const tessMatch = bestTess.stats.find(
                  (ts) => ts.name.toLowerCase() === statName && ts.value !== null,
                );
                if (tessMatch && !assignedValues.has(tessMatch.value!)) {
                  injected[ni] = {
                    ...injected[ni],
                    value: tessMatch.value,
                    positive: tessMatch.positive,
                    ...(tessMatch.multiplier && { multiplier: true }),
                  };
                  assignedValues.add(tessMatch.value!);
                  injectedCount++;
                }
              }
              // Orphan values from Tesseract text for remaining nulls
              if (injectedCount < nullSlots.length) {
                const orphanValues: Array<{
                  value: number;
                  positive: boolean;
                  multiplier?: boolean;
                }> = [];
                for (const tc of tesseractCandidates) {
                  const cleaned = preprocessOcrText(tc.text || "");
                  for (const match of cleaned.matchAll(/x\s*(\d+\.?\d*)/gi)) {
                    const v = parseFloat(match[1]);
                    if (!Number.isFinite(v) || v <= 0) continue;
                    if (assignedValues.has(v)) continue;
                    if (orphanValues.some((o) => Math.abs(o.value - v) < 0.05)) continue;
                    orphanValues.push({ value: v, positive: v >= 1, multiplier: true });
                  }
                  for (const match of cleaned.matchAll(/([+\-])\s*(\d+\.?\d*)\s*%/g)) {
                    const v = parseFloat(match[2]);
                    if (!Number.isFinite(v) || v <= 0) continue;
                    if (assignedValues.has(v)) continue;
                    if (orphanValues.some((o) => Math.abs(o.value - v) < 0.5)) continue;
                    orphanValues.push({ value: v, positive: match[1] !== "-" });
                  }
                }
                let oi = 0;
                const remainingNullIdxs = nullSlots.filter((i) => injected[i].value === null);
                for (const ni of remainingNullIdxs) {
                  if (oi >= orphanValues.length) break;
                  injected[ni] = {
                    ...injected[ni],
                    value: orphanValues[oi].value,
                    positive: orphanValues[oi].positive,
                    ...(orphanValues[oi].multiplier && { multiplier: true }),
                  };
                  assignedValues.add(orphanValues[oi].value);
                  oi++;
                  injectedCount++;
                }
              }
              if (injectedCount > 0) {
                chosen = { ...chosen, stats: injected };
              }
            }
          }
        }
      }
    } catch { /* merge failure is non-fatal */ }
  }

  // tessMs: wall time of Tesseract when used (backwards-compat reporting)
  const tessMs = tessTriggered ? tessParallelTotalMs : 0;
  return { stats: chosen.stats, nativeMs, tessMs, tessParallelTotalMs, tessWaitedMs, tessTriggered, nativeOnlyStats };
}

// ── Ground truth ─────────────────────────────────────────────────────────────
// Expected stats for each corpus image (manually verified from screenshots).
// key = filename, value = expected stat names + approximate values (±2 tolerance).
// Ground truth: verified from consistent OCR reads on both native and old benchmarks.
// failure_2/3 ground truth is uncertain — the crop may show a different riven card face.
const GROUND_TRUTH: Record<
  string,
  Array<{ name: string; value: number | null; positive: boolean; multiplier?: boolean }>
> = {
  "success_1.PNG": [
    { name: "Critical Chance for Slide Attack", value: 128.1, positive: true },
    { name: "Melee Damage", value: 157, positive: true },
    { name: "Heat", value: 98.8, positive: true },
    { name: "Critical Chance", value: 147.6, positive: false },
  ],
  "success_2.PNG": [
    { name: "Melee Damage", value: 189.5, positive: true },
    { name: "Status Chance", value: 120.4, positive: true },
    { name: "Attack Speed", value: 69.7, positive: true },
    { name: "Finisher Damage", value: 106.5, positive: false },
  ],
  "failure_1.PNG": [
    { name: "Status Duration", value: 126.2, positive: true },
    { name: "Electricity", value: 122.2, positive: true },
    { name: "Multishot", value: 112, positive: true },
    { name: "Damage to Grineer", value: 0.58, positive: false, multiplier: true },
  ],
  "failure_2.PNG": [
    // OCR reads: Range, Attack Speed, Impact, Combo Duration (from bright-150 strategy)
    { name: "Range", value: 2.5, positive: true },
    { name: "Attack Speed", value: 70.6, positive: true },
    { name: "Impact", value: 151.4, positive: true },
    { name: "Combo Duration", value: 8.6, positive: false },
  ],
  "failure_3.PNG": [
    // OCR reads: Puncture, Heat, Reload Speed (3 stats only)
    { name: "Puncture", value: 115.1, positive: true },
    { name: "Heat", value: 94.8, positive: true },
    { name: "Reload Speed", value: 52.3, positive: true },
  ],
  "failure_4.PNG": [
    { name: "Damage to Corpus", value: 1.3, positive: true, multiplier: true },
    { name: "Damage to Grineer", value: 1.36, positive: true, multiplier: true },
    { name: "Heat", value: 62.2, positive: true },
    { name: "Impact", value: 68.4, positive: false },
  ],
  "success_multipanel_1.PNG": [
    { name: "Critical Damage", value: 165.5, positive: true },
    { name: "Weapon Recoil", value: 115.9, positive: false },
  ],
  "success_multipanel_2.PNG": [
    { name: "Ammo Maximum", value: 67.9, positive: true },
    { name: "Status Chance", value: 115.9, positive: true },
  ],
  "real_production_initial.png": [
    { name: "Damage to Corpus", value: 1.3, positive: true, multiplier: true },
    { name: "Damage to Grineer", value: 1.36, positive: true, multiplier: true },
    { name: "Heat", value: 62.2, positive: true },
    { name: "Impact", value: 68.4, positive: false },
  ],
  // real_production_rolling_multipanel.png is a mid-animation screenshot (values
  // animating before final settle) — not suitable as a ground-truth accuracy target.
  // The file stays in the corpus for visual/diagnostic use only.
};

function scoreAccuracy(
  stats: RivenStat[],
  expected: (typeof GROUND_TRUTH)[string],
): {
  namesMatched: number;
  valuesMatched: number;
  signsMatched: number;
  totalExpected: number;
  details: string[];
} {
  const details: string[] = [];
  let namesMatched = 0;
  let valuesMatched = 0;
  let signsMatched = 0;
  const totalExpected = expected.length;

  for (const exp of expected) {
    const found = stats.find(
      (s) => s.name.toLowerCase() === exp.name.toLowerCase(),
    );
    if (found) {
      namesMatched++;
      const signOk = found.positive === exp.positive;
      if (!signOk) {
        details.push(
          `  ✗ ${exp.name}: sign WRONG — got ${found.positive ? "+" : "-"} expected ${exp.positive ? "+" : "-"}`,
        );
      }
      if (exp.value === null) {
        // For x-multiplier stats, just check the stat was found with any value
        if (found.value !== null) {
          valuesMatched++;
          if (signOk) signsMatched++;
          details.push(`  ✓ ${exp.name}: found value ${found.multiplier ? "x" : ""}${found.value}${signOk ? "" : " [sign ✗]"}`);
        } else {
          details.push(`  ~ ${exp.name}: name matched but value missing`);
        }
      } else if (found.value !== null && Math.abs(found.value - exp.value) < 3) {
        valuesMatched++;
        if (signOk) signsMatched++;
        details.push(
          `  ✓ ${exp.name}: ${found.positive ? "+" : "-"}${found.multiplier ? "x" : ""}${found.value} (expected ${exp.positive ? "+" : "-"}${exp.value})${signOk ? "" : " [sign ✗]"}`,
        );
      } else {
        details.push(
          `  ✗ ${exp.name}: value ${found.value ?? "null"} (expected ${exp.value}), sign ${found.positive ? "+" : "-"} (expected ${exp.positive ? "+" : "-"})`,
        );
      }
    } else {
      details.push(`  ✗ ${exp.name}: NOT FOUND`);
    }
  }

  // Check for extra stats not in ground truth
  for (const s of stats) {
    const inGt = expected.some(
      (e) => e.name.toLowerCase() === s.name.toLowerCase(),
    );
    if (!inGt) {
      details.push(`  ? ${s.name}: extra stat (${s.positive ? "+" : "-"}${s.value ?? "?"}) not in ground truth`);
    }
  }

  return { namesMatched, valuesMatched, signsMatched, totalExpected, details };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!CRNN_ONLY && !_nativeRecognize) {
    console.error("ERROR: @napi-rs/system-ocr not available (use --crnn-only to skip WinRT)");
    process.exit(1);
  }

  if (!CRNN_ONLY) {
    console.log("Initializing Tesseract.js persistent worker...");
    _tessWorker = await initTesseractWorker();
    if (_tessWorker) {
      console.log("✓ Tesseract worker ready\n");
    } else {
      console.log("✗ Tesseract not available — running native-only\n");
    }
  }

  const corpusDir = path.join(process.cwd(), "OCR-debug", "riven_images");
  const files = fs
    .readdirSync(corpusDir)
    .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
    .sort();

  const modeLabel = CRNN_ONLY
    ? "CRNN only"
    : SKIP_CRNN
    ? "WinRT + Tesseract (no CRNN)"
    : "CRNN → WinRT → Tesseract (full production)";

  console.log(`Riven OCR Benchmark — ${modeLabel} (${files.length} images)`);
  console.log(`Engines: ${SKIP_CRNN ? "" : "CRNN (ONNX) + "}${CRNN_ONLY ? "" : "Native (WinRT) + Tesseract.js"}`);
  console.log(`Strategies: original, bright-150+dilate, bright-120+dilate`);
  console.log("═".repeat(72));

  // Aggregates
  let totalCrnnMs = 0;
  let totalNativeMs = 0;
  let totalTessMs = 0;
  let totalFullMs = 0;
  let totalTessParallelMs = 0;
  let totalTessWaitedMs = 0;
  let totalImages = 0;
  let crnnSucceeded = 0;
  let crnnSkippedNativeCount = 0;
  let totalNamesCrnn = 0;
  let totalValuesCrnn = 0;
  let totalSignsCrnn = 0;
  let totalNamesNative = 0;
  let totalValuesNative = 0;
  let totalSignsNative = 0;
  let totalNamesFull = 0;
  let totalValuesFull = 0;
  let totalSignsFull = 0;
  let totalExpected = 0;
  let tessTriggeredCount = 0;

  for (const file of files) {
    const fullPath = path.join(corpusDir, file);
    const isMultipanel = /multipanel/i.test(file);
    const crop = isMultipanel ? ROLL_CARD_CROP : SINGLE_CARD_CROP;
    const cropLabel = isMultipanel ? "ROLL" : "SINGLE";

    console.log(`\n─── ${file} [${cropLabel}] ───`);
    const img = await loadImage(fullPath);
    console.log(`  Image: ${img.width}×${img.height}`);

    // ── Phase 0: CRNN fast path (mirrors production rivenScan.ts) ──────────
    // For single-card: use narrow ROLL_CARD_CROP (AlecaFrame center strip) — the card
    // is always centered on screen. For multipanel: use ROLL_CARD_CROP as before.
    // Both paths pass isMultipanel=true to recognizeRivenCardLines since the narrow
    // crop has the same layout regardless of game state.
    let crnnStats: RivenStat[] = [];
    let crnnMs = 0;
    let crnnSkippedNative = false;

    if (!SKIP_CRNN) {
      const crnnStart = Date.now();
      try {
        // Always use ROLL_CARD_CROP for CRNN — narrow center strip where variance
        // row detection works reliably (matches production ocrCropMultiStrategy).
        const crnnCrop = isMultipanel ? crop : ROLL_CARD_CROP;
        const cardPng = await rawToPng(cropRgba(img, crnnCrop));
        const crnnLines = await recognizeRivenCardLines(cardPng, /* isMultipanel */ true);
        const crnnText = crnnLines.join("\n");
        crnnStats = parseRivenStats(crnnText);
        crnnMs = Date.now() - crnnStart;
        const crnnValueCount = crnnStats.filter((s) => s.value !== null).length;
        const crnnScore = scoreStatsCandidate(crnnStats, crnnText);
        console.log(`\n  CRNN Phase 0 (${crnnMs}ms):`);
        console.log(`    Lines: ${crnnLines.map((l) => `"${l}"`).join(", ")}`);
        console.log(`    Stats: ${formatStats(crnnStats)}`);
        console.log(`    Score: ${crnnScore}, Values: ${crnnValueCount}/${crnnStats.length}`);
        // Mirror production confidence check: multipanel accepts at normal threshold,
        // single-card requires strict score + value coverage.
        const crnnConfident = isMultipanel
          ? crnnStats.length >= MIN_ACCEPTABLE_RIVEN_STATS
          : crnnStats.length >= MIN_ACCEPTABLE_RIVEN_STATS &&
            crnnValueCount >= crnnStats.length &&
            crnnScore >= 75;
        if (crnnConfident) {
          crnnSkippedNative = true;
          crnnSkippedNativeCount++;
          console.log(`    → CRNN confident (${crnnStats.length} stats, score=${crnnScore}) — would skip WinRT+Tesseract in production`);
        } else if (crnnStats.length >= MIN_ACCEPTABLE_RIVEN_STATS) {
          console.log(`    → CRNN found ${crnnStats.length} stats but not confident (score=${crnnScore}, values=${crnnValueCount}) — would fall through to WinRT`);
        } else {
          console.log(`    → CRNN sparse (${crnnStats.length} stats) — would fall through to WinRT`);
        }
        if (crnnStats.length >= MIN_ACCEPTABLE_RIVEN_STATS) crnnSucceeded++;
      } catch (err) {
        crnnMs = Date.now() - crnnStart;
        console.log(`\n  CRNN Phase 0 FAILED (${crnnMs}ms): ${err}`);
      }
      totalCrnnMs += crnnMs;
    }

    // ── Phases 1+2: WinRT + Tesseract (skipped in production when CRNN succeeds) ──
    let result: Awaited<ReturnType<typeof ocrCropMultiStrategy>> | null = null;
    if (!CRNN_ONLY && (!crnnSkippedNative || !SKIP_CRNN)) {
      result = await ocrCropMultiStrategy(img, crop, nativeOcr, file);

      console.log(`\n  WinRT Phase 1 (${result.nativeMs}ms):`);
      console.log(`    Stats: ${formatStats(result.nativeOnlyStats)}`);

      if (result.tessTriggered) {
        console.log(`  Tesseract parallel total: ${result.tessParallelTotalMs}ms | waited after native: ${result.tessWaitedMs}ms`);
        console.log(`    Final: ${formatStats(result.stats)}`);
      } else {
        console.log(`  Tesseract: not needed (ran eagerly but result discarded)`);
      }

      const winrtFullMs = result.nativeMs + result.tessWaitedMs;
      console.log(`  WinRT+Tess total: ${winrtFullMs}ms`);
    }

    // ── Effective result: CRNN if it succeeded (in production mode), else WinRT+Tess ──
    const productionStats = (crnnSkippedNative && !SKIP_CRNN)
      ? crnnStats
      : (result?.stats ?? crnnStats);
    const productionMs = (crnnSkippedNative && !SKIP_CRNN)
      ? crnnMs
      : crnnMs + (result ? result.nativeMs + result.tessWaitedMs : 0);

    console.log(`\n  ► PRODUCTION RESULT (${productionMs}ms): ${formatStats(productionStats)}`);

    // Accuracy vs ground truth
    const gt = GROUND_TRUTH[file];
    if (gt) {
      if (!SKIP_CRNN) {
        const crnnAcc = scoreAccuracy(crnnStats, gt);
        console.log(
          `\n  Accuracy (CRNN): ${crnnAcc.namesMatched}/${crnnAcc.totalExpected} names, ${crnnAcc.valuesMatched}/${crnnAcc.totalExpected} values, ${crnnAcc.signsMatched}/${crnnAcc.totalExpected} correct signs`,
        );
        for (const d of crnnAcc.details) console.log(`  ${d}`);
        totalNamesCrnn += crnnAcc.namesMatched;
        totalValuesCrnn += crnnAcc.valuesMatched;
        totalSignsCrnn += crnnAcc.signsMatched;
      }

      if (result) {
        const nativeAcc = scoreAccuracy(result.nativeOnlyStats, gt);
        const fullAcc = scoreAccuracy(result.stats, gt);

        console.log(
          `\n  Accuracy (WinRT-only): ${nativeAcc.namesMatched}/${nativeAcc.totalExpected} names, ${nativeAcc.valuesMatched}/${nativeAcc.totalExpected} values`,
        );
        for (const d of nativeAcc.details) console.log(`   ${d}`);

        if (result.tessTriggered) {
          console.log(
            `  Accuracy (WinRT+Tess): ${fullAcc.namesMatched}/${fullAcc.totalExpected} names, ${fullAcc.valuesMatched}/${fullAcc.totalExpected} values`,
          );
          for (const d of fullAcc.details) console.log(`   ${d}`);
        }

        totalNamesNative += nativeAcc.namesMatched;
        totalValuesNative += nativeAcc.valuesMatched;
        totalSignsNative += nativeAcc.signsMatched;
        totalNamesFull += fullAcc.namesMatched;
        totalValuesFull += fullAcc.valuesMatched;
        totalSignsFull += fullAcc.signsMatched;
      }
      totalExpected += gt.length;
    } else {
      console.log("  (no ground truth for this image)");
    }

    if (result) {
      totalNativeMs += result.nativeMs;
      totalTessMs += result.tessMs;
      totalFullMs += result.nativeMs + result.tessWaitedMs;
      totalTessParallelMs += result.tessParallelTotalMs;
      totalTessWaitedMs += result.tessWaitedMs;
      if (result.tessTriggered) tessTriggeredCount++;
    }
    totalImages++;
  }

  // Summary
  console.log("\n" + "═".repeat(72));
  console.log("SUMMARY");
  console.log("═".repeat(72));
  console.log(`Images: ${totalImages}`);

  if (!SKIP_CRNN) {
    console.log(`CRNN (Phase 0):`);
    console.log(`  Succeeded (>=2 stats):   ${crnnSucceeded}/${totalImages} images`);
    console.log(`  Would skip WinRT:         ${crnnSkippedNativeCount}/${totalImages} images`);
    console.log(`  Avg time:                 ${Math.round(totalCrnnMs / totalImages)}ms/image`);
  }

  if (!CRNN_ONLY) {
    console.log(`\nWinRT+Tesseract (Phases 1+2, when CRNN insufficient):`);
    const winrtImages = totalImages - crnnSkippedNativeCount;
    if (winrtImages > 0) {
      console.log(`  Tesseract triggered:     ${tessTriggeredCount}/${winrtImages} WinRT-path images`);
      console.log(`  WinRT avg:               ${Math.round(totalNativeMs / Math.max(1, winrtImages))}ms/image`);
      if (tessTriggeredCount > 0) {
        console.log(
          `  Tesseract parallel avg:  ${Math.round(totalTessParallelMs / tessTriggeredCount)}ms (total wall when triggered)`,
        );
        console.log(
          `  Tesseract waited avg:    ${Math.round(totalTessWaitedMs / tessTriggeredCount)}ms (extra wait after WinRT)`,
        );
      }
      console.log(`  Full WinRT+Tess avg:     ${Math.round(totalFullMs / Math.max(1, winrtImages))}ms/image`);
    }
  }

  console.log("\nAccuracy (vs ground truth):");
  if (!SKIP_CRNN && totalExpected > 0) {
    console.log(
      `  CRNN:       ${totalNamesCrnn}/${totalExpected} names (${((totalNamesCrnn / totalExpected) * 100).toFixed(0)}%), ${totalValuesCrnn}/${totalExpected} values (${((totalValuesCrnn / totalExpected) * 100).toFixed(0)}%)`,
    );
  }
  if (!CRNN_ONLY && totalExpected > 0) {
    console.log(
      `  WinRT-only: ${totalNamesNative}/${totalExpected} names (${((totalNamesNative / totalExpected) * 100).toFixed(0)}%), ${totalValuesNative}/${totalExpected} values (${((totalValuesNative / totalExpected) * 100).toFixed(0)}%)`,
    );
    console.log(
      `  WinRT+Tess: ${totalNamesFull}/${totalExpected} names (${((totalNamesFull / totalExpected) * 100).toFixed(0)}%), ${totalValuesFull}/${totalExpected} values (${((totalValuesFull / totalExpected) * 100).toFixed(0)}%)`,
    );
  }

  // Machine-readable summary line for easy before/after comparison
  const summary = {
    images: totalImages,
    tessTriggered: tessTriggeredCount,
    speed: {
      nativeAvgMs: Math.round(totalNativeMs / totalImages),
      tessParallelAvgMs: tessTriggeredCount > 0 ? Math.round(totalTessParallelMs / tessTriggeredCount) : 0,
      tessWaitedAvgMs: tessTriggeredCount > 0 ? Math.round(totalTessWaitedMs / tessTriggeredCount) : 0,
      fullAvgMs: Math.round(totalFullMs / totalImages),
    },
    accuracy: {
      namesNative: `${totalNamesNative}/${totalExpected}`,
      valuesNative: `${totalValuesNative}/${totalExpected}`,
      signsNative: `${totalSignsNative}/${totalExpected}`,
      namesFull: `${totalNamesFull}/${totalExpected}`,
      valuesFull: `${totalValuesFull}/${totalExpected}`,
      signsFull: `${totalSignsFull}/${totalExpected}`,
    },
  };
  console.log("\nSUMMARY_JSON:", JSON.stringify(summary));

  // Cleanup
  if (_tessWorker) {
    try { await _tessWorker.terminate(); } catch { /* */ }
  }
})();
