#!/usr/bin/env npx tsx
/**
 * Tests various crop positions against the multipanel corpus images to find
 * the one that correctly reads the new roll card stats.
 */
import sharp from "sharp";
import path from "node:path";
import fs from "node:fs";

const CORPUS_DIR = path.join(process.cwd(), "OCR-debug", "riven_images");

async function main() {

// We need the production OCR path
const { nativeOcrBuffer, nativeOcrAvailable } = await import("../../services/ocrServer.js");
const { parseRivenStats } = await import("../../ipc/overlay/rivenScan.js");

console.log("nativeOcrAvailable:", nativeOcrAvailable);

const CROP_CANDIDATES = [
  // Current production (wrong)
  { label: "CURRENT-PROD",  x: 0.26, y: 0.28, w: 0.21, h: 0.52 },
  // Based on brightness analysis: new card is at x=819-1104 (42.7-57.5%)
  { label: "candidate-A",   x: 0.40, y: 0.38, w: 0.22, h: 0.42 },
  { label: "candidate-B",   x: 0.42, y: 0.38, w: 0.20, h: 0.42 },
  { label: "candidate-C",   x: 0.40, y: 0.35, w: 0.24, h: 0.45 },
  { label: "candidate-D",   x: 0.38, y: 0.35, w: 0.26, h: 0.45 },
  // Old production crop (before my changes)
  { label: "OLD-PROD",      x: 0.34, y: 0.39, w: 0.28, h: 0.49 },
  // Debug script's right crop
  { label: "DEBUG-SCRIPT",  x: 0.50, y: 0.38, w: 0.28, h: 0.38 },
];

async function ocrCrop(
  rawRgba: Buffer,
  imgW: number,
  imgH: number,
  crop: { x: number; y: number; w: number; h: number },
): Promise<string> {
  const cx = Math.floor(imgW * crop.x);
  const cy = Math.floor(imgH * crop.y);
  const cw = Math.floor(imgW * crop.w);
  const ch = Math.floor(imgH * crop.h);

  const cropBuf = Buffer.alloc(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const srcOff = ((cy + row) * imgW + cx) * 4;
    const dstOff = row * cw * 4;
    rawRgba.copy(cropBuf, dstOff, srcOff, srcOff + cw * 4);
  }

  // Use original (no preprocessing) — this is primary strategy for native OCR
  const pngBuf = await (sharp as any)(cropBuf, { raw: { width: cw, height: ch, channels: 4 } })
    .png()
    .toBuffer();
  return nativeOcrBuffer(pngBuf, 8000);
}

const files = fs
  .readdirSync(CORPUS_DIR)
  .filter((f) => /multipanel/i.test(f) && /\.(png|jpg|jpeg)$/i.test(f))
  .sort();

for (const file of files) {
  const imgPath = path.join(CORPUS_DIR, file);
  const meta = await (sharp as any)(imgPath).metadata();
  const w = meta.width!;
  const h = meta.height!;
  const rawRgba = await (sharp as any)(imgPath).ensureAlpha().raw().toBuffer();

  console.log(`\n=== ${file} (${w}x${h}) ===`);
  for (const c of CROP_CANDIDATES) {
    const text = await ocrCrop(rawRgba, w, h, c);
    const stats = parseRivenStats(text);
    const parsed = stats.map((s) => `${s.positive ? "+" : "-"}${s.value ?? "?"}% ${s.name}`).join(" | ");
    const preview = text.replace(/\r?\n/g, " ↵ ").trim().slice(0, 120);
    const cx = Math.floor(w * c.x), cy = Math.floor(h * c.y);
    const cw2 = Math.floor(w * c.w), ch2 = Math.floor(h * c.h);
    console.log(`\n  [${c.label}] x=${cx}-${cx+cw2} y=${cy}-${cy+ch2}`);
    console.log(`    raw: "${preview}"`);
    console.log(`    stats (${stats.length}): ${parsed || "(none)"}`);
  }
}
}

main().catch((err) => { console.error(err); process.exit(1); });
