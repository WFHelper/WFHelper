#!/usr/bin/env npx tsx
/**
 * Quick comparison: Native WinRT vs Tesseract.js on ALL riven corpus images.
 * Tests 3 enhancement strategies × 2 engines to find the best combination.
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

const SINGLE_CARD_CROP = { x: 0.22, y: 0.43, width: 0.56, height: 0.45 };
const ROLL_CARD_CROP = { x: 0.42, y: 0.35, width: 0.20, height: 0.45 };
const MIN_OCR_WIDTH = 1800;

// ── Engines ──────────────────────────────────────────────────────────────────
let _nativeRecognize: ((input: Buffer) => Promise<{ text: string; confidence: number }>) | null =
  null;
try {
  const mod = require("@napi-rs/system-ocr") as {
    recognize: (input: Buffer) => Promise<{ text: string; confidence: number }>;
  };
  _nativeRecognize = mod.recognize;
} catch {
  /* unavailable */
}

let _tesseractRecognize: ((img: Buffer) => Promise<string>) | null = null;
try {
  const Tesseract = require("tesseract.js") as {
    createWorker: (lang: string) => Promise<any>;
  };
  const workerPromise = Tesseract.createWorker("eng");
  _tesseractRecognize = async (img: Buffer): Promise<string> => {
    const worker = await workerPromise;
    const result = await worker.recognize(img);
    return result?.data?.text || "";
  };
} catch {
  /* unavailable */
}

// ── Image helpers ────────────────────────────────────────────────────────────
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

async function enhanceBrightDilate(
  cropped: { data: Buffer; width: number; height: number },
  threshold: number,
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
    mask[pi] = maxC >= threshold ? 1 : 0;
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
  const engines: Array<{
    name: string;
    run: (buf: Buffer) => Promise<{ text: string; ms: number }>;
  }> = [];

  if (_nativeRecognize) {
    const rec = _nativeRecognize;
    engines.push({
      name: "Native",
      run: async (buf) => {
        const t0 = Date.now();
        const r = await rec(buf);
        return { text: r.text, ms: Date.now() - t0 };
      },
    });
  }
  if (_tesseractRecognize) {
    const rec = _tesseractRecognize;
    engines.push({
      name: "Tesseract",
      run: async (buf) => {
        const t0 = Date.now();
        const text = await rec(buf);
        return { text, ms: Date.now() - t0 };
      },
    });
  }

  if (engines.length === 0) {
    console.error("No OCR engines available");
    process.exit(1);
  }

  console.log(`Engines: ${engines.map((e) => e.name).join(", ")}\n`);

  const corpusDir = path.join(process.cwd(), "OCR-debug", "riven_images");
  const files = fs
    .readdirSync(corpusDir)
    .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
    .sort();

  const enhanceStrategies = [
    { label: "original", fn: (c: any) => enhanceOriginal(c) },
    { label: "bright-150+dilate", fn: (c: any) => enhanceBrightDilate(c, 150) },
    { label: "bright-120+dilate", fn: (c: any) => enhanceBrightDilate(c, 120) },
  ];

  for (const file of files) {
    const fullPath = path.join(corpusDir, file);
    const isMultipanel = /multipanel/i.test(file);
    const crop = isMultipanel ? ROLL_CARD_CROP : SINGLE_CARD_CROP;

    console.log(`\n${"═".repeat(70)}`);
    console.log(`  ${file}`);
    console.log(`${"═".repeat(70)}`);

    const img = await loadRgba(fullPath);
    const cropped = cropRgba(img, crop);

    for (const strategy of enhanceStrategies) {
      const enhanced = await strategy.fn(cropped);
      console.log(`\n  ── ${strategy.label} ──`);

      for (const engine of engines) {
        const { text, ms } = await engine.run(enhanced);
        const structured = textToStructuredResult(text);
        const split = splitRivenStructuredText(structured);
        const stats = parseRivenStats(split.statsText || text || "");
        const valueCount = stats.filter((s) => s.value !== null).length;
        const score = scoreStatsCandidate(stats, text);
        const rawPreview = preprocessOcrText(text).replace(/\r?\n/g, " | ").slice(0, 140);

        console.log(
          `  [${engine.name}] ${ms}ms  ${stats.length}s/${valueCount}v score=${score}`,
        );
        console.log(`    raw: "${rawPreview}"`);
        if (stats.length > 0) console.log(`    → ${formatStats(stats)}`);
      }
    }
  }

  console.log("\nDone.");
  process.exit(0);
})();
