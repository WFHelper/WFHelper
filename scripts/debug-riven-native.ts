#!/usr/bin/env npx tsx
/**
 * Debug: runs the production riven OCR pipeline on corpus images.
 *
 * Replicates exactly what happens in ocrCropMultiStrategy:
 *   1. Crop the image to the stat region
 *   2. Apply each EnhanceMode (lowsat-155+dilate, bright-120+dilate)
 *   3. Call nativeOcrBuffer (the live production path)
 *   4. Parse stats with parseRivenStats
 *
 * Unlike compare-riven-ocr-engines which uses runOCR(filePath), this script
 * exercises runOCRStructuredBuffer → nativeOcrBuffer (zero disk I/O path).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeOcrBuffer, nativeOcrAvailable } from "../services/ocrServer.js";
import { parseRivenStats } from "../ipc/overlay/rivenScan.js";

const CORPUS_DIR = path.join(process.cwd(), "OCR-debug", "riven_images");
const MIN_OCR_WIDTH = 1800;
const OCR_TIMEOUT_MS = 10_000;

const CROPS = {
  single: { x: 0.30, y: 0.38, width: 0.40, height: 0.38 },
  right:  { x: 0.50, y: 0.38, width: 0.28, height: 0.38 },
};

interface EnhanceMode {
  name: string;
  kind: "lowsat" | "bright";
  threshold: number;
  maxSat?: number;
  dilate: boolean;
}

const ENHANCE_STRATEGIES: EnhanceMode[] = [
  { name: "lowsat-155+dilate-sat0.35", kind: "lowsat", threshold: 155, maxSat: 0.35, dilate: true },
  { name: "bright-120+dilate",          kind: "bright", threshold: 120,              dilate: true },
];

async function enhance(
  rawRgba: Buffer,
  w: number,
  h: number,
  mode: EnhanceMode,
): Promise<Buffer> {
  const sharp = require("sharp") as typeof import("sharp");
  const scale = w >= MIN_OCR_WIDTH ? 1 : Math.ceil(MIN_OCR_WIDTH / w);
  const sw = Math.min(6000, w * scale);
  const sh = Math.min(6000, h * scale);

  const scaled = await sharp(rawRgba, { raw: { width: w, height: h, channels: 4 } })
    .resize(sw, sh, { kernel: "linear" })
    .ensureAlpha()
    .raw()
    .toBuffer();

  const pixels = sw * sh;
  const mask = Buffer.alloc(pixels);
  for (let i = 0, j = 0; i < scaled.length; i += 4, j++) {
    const r = scaled[i], g = scaled[i + 1], b = scaled[i + 2];
    const maxC = Math.max(r, g, b);
    if (mode.kind === "lowsat") {
      const minC = Math.min(r, g, b);
      const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
      mask[j] = maxC >= mode.threshold && sat <= (mode.maxSat ?? 0.35) ? 1 : 0;
    } else {
      mask[j] = maxC >= mode.threshold ? 1 : 0;
    }
  }

  const out = Buffer.alloc(pixels);
  if (mode.dilate) {
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        let found = false;
        for (let dy = -1; dy <= 1 && !found; dy++) {
          for (let dx = -1; dx <= 1 && !found; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < sw && ny >= 0 && ny < sh && mask[ny * sw + nx]) found = true;
          }
        }
        out[y * sw + x] = found ? 0 : 255;
      }
    }
  } else {
    for (let j = 0; j < pixels; j++) out[j] = mask[j] ? 0 : 255;
  }

  return sharp(out, { raw: { width: sw, height: sh, channels: 1 } }).png().toBuffer();
}

async function main() {
  console.log(`\n=== Riven Native OCR Debug ===`);
  console.log(`nativeOcrAvailable: ${nativeOcrAvailable}`);
  if (!nativeOcrAvailable) {
    console.warn("WARNING: native binding not loaded — results will use Tesseract fallback");
  }
  console.log(`Corpus: ${CORPUS_DIR}\n`);

  const sharp = require("sharp") as typeof import("sharp");
  const files = fs.readdirSync(CORPUS_DIR)
    .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
    .sort();

  for (const file of files) {
    const filePath = path.join(CORPUS_DIR, file);
    const meta = await sharp(filePath).metadata();
    const w = meta.width!, h = meta.height!;
    const rawRgba = await sharp(filePath).ensureAlpha().raw().toBuffer();

    const cropKey = /multipanel/i.test(file) ? "right" : "single";
    const rect = CROPS[cropKey];
    const cx = Math.floor(w * rect.x);
    const cy = Math.floor(h * rect.y);
    const cw = Math.max(24, Math.floor(w * rect.width));
    const ch = Math.max(24, Math.floor(h * rect.height));

    // Extract crop as raw RGBA
    const cropBuf = Buffer.alloc(cw * ch * 4);
    for (let row = 0; row < ch; row++) {
      const srcOff = ((cy + row) * w + cx) * 4;
      const dstOff = row * cw * 4;
      rawRgba.copy(cropBuf, dstOff, srcOff, srcOff + cw * 4);
    }

    console.log(`\n── ${file} (${w}×${h}, crop=${cropKey} ${cw}×${ch}) ──`);
    const t0file = Date.now();
    let bestStats = 0;
    let bestLine = "";

    for (const strategy of ENHANCE_STRATEGIES) {
      const t0 = Date.now();
      const pngBuf = await enhance(cropBuf, cw, ch, strategy);
      const enhMs = Date.now() - t0;

      const t1 = Date.now();
      let text = "";
      try {
        text = await nativeOcrBuffer(pngBuf, OCR_TIMEOUT_MS);
      } catch (err: any) {
        text = `[OCR ERROR] ${err.message}`;
      }
      const ocrMs = Date.now() - t1;

      const stats = parseRivenStats(text);
      const statsStr = stats.length > 0
        ? stats.map(s => `${s.positive ? "+" : "-"}${s.value ?? "?"}% ${s.name}`).join(" | ")
        : "(none)";

      const rawPreview = text.replace(/\r?\n/g, " ↵ ").trim().slice(0, 160);
      console.log(`  [${strategy.name}] enhance=${enhMs}ms ocr=${ocrMs}ms → ${stats.length} stats`);
      console.log(`    raw: "${rawPreview}"`);
      console.log(`    parsed: ${statsStr}`);

      if (stats.length > bestStats) {
        bestStats = stats.length;
        bestLine = statsStr;
      }
    }

    console.log(`  BEST (${Date.now() - t0file}ms total): ${bestStats} stats — ${bestLine}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
