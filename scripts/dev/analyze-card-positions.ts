#!/usr/bin/env npx tsx
/**
 * Analyzes the multipanel corpus images to find where the actual riven cards sit.
 * Outputs brightness profiles and saves annotated card-region crops so we can
 * determine the correct ROLL_CARD_CROP coordinates.
 */
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const CORPUS_DIR = path.join(process.cwd(), "OCR-debug", "riven_images");
const OUT_DIR = path.join(process.cwd(), "riven-ocr-debug");

async function analyze(file: string) {
  const imgPath = path.join(CORPUS_DIR, file);
  const meta = await sharp(imgPath).metadata();
  const w = meta.width!;
  const h = meta.height!;
  const ch = meta.channels ?? 3;
  console.log(`\n== ${file} ${w}x${h} ==`);

  const raw = await sharp(imgPath).raw().toBuffer();

  // Scan horizontal strips at y=35-75% to find card column edges
  // Cards have DARK background (~30-60 brightness) vs bright Kuva portal bg
  const y0 = Math.floor(h * 0.38);
  const y1 = Math.floor(h * 0.76);

  const xBrightness: number[] = [];
  for (let x = 0; x < w; x++) {
    let sum = 0;
    let cnt = 0;
    for (let y = y0; y < y1; y++) {
      const idx = (y * w + x) * ch;
      sum += (raw[idx] + raw[idx + 1] + raw[idx + 2]) / 3;
      cnt++;
    }
    xBrightness.push(sum / cnt);
  }

  // Print 40-column profile
  const bins = 40;
  const binW = w / bins;
  console.log("  Horizontal brightness profile (x: avg brightness):");
  for (let b = 0; b < bins; b++) {
    const bx0 = Math.floor(b * binW);
    const bx1 = Math.floor((b + 1) * binW);
    const vals = xBrightness.slice(bx0, bx1);
    const avg = vals.reduce((a, v) => a + v, 0) / vals.length;
    const pct = ((bx0 + bx1) / 2 / w * 100).toFixed(0).padStart(3);
    const bar = "█".repeat(Math.round(avg / 10));
    console.log(`    ${pct}% (${(bx0 + bx1) >> 1}px): ${avg.toFixed(0).padStart(4)} ${bar}`);
  }

  // Find the darkest region > 150px wide — that's the card area
  // Look specifically for the RIGHT card (new roll)
  // Darkness threshold: below 100 avg = likely card background
  const DARK_THRESH = 120;
  let regions: Array<{ x0: number; x1: number; avgBr: number }> = [];
  let inDark = false;
  let darkStart = 0;
  for (let x = 0; x < w; x++) {
    if (xBrightness[x] < DARK_THRESH && !inDark) {
      inDark = true;
      darkStart = x;
    } else if ((xBrightness[x] >= DARK_THRESH || x === w - 1) && inDark) {
      inDark = false;
      const x1 = x;
      if (x1 - darkStart > 80) {
        const regionAvg = xBrightness.slice(darkStart, x1).reduce((a, v) => a + v, 0) / (x1 - darkStart);
        regions.push({ x0: darkStart, x1, avgBr: regionAvg });
      }
    }
  }

  console.log(`\n  Dark regions (potential card areas) at y=${(y0/h*100).toFixed(0)}%-${(y1/h*100).toFixed(0)}%:`);
  for (const r of regions) {
    console.log(`    x=${r.x0}-${r.x1} (${(r.x0/w*100).toFixed(1)}%-${(r.x1/w*100).toFixed(1)}%) width=${r.x1-r.x0}px avgBr=${r.avgBr.toFixed(1)}`);
  }

  // Save individual card crops for visual inspection
  const cropTests = [
    { label: "debug-left",   x: 0.22, y: 0.35, w: 0.25, h: 0.45 },
    { label: "debug-center", x: 0.34, y: 0.35, w: 0.28, h: 0.45 },
    { label: "debug-right1", x: 0.44, y: 0.35, w: 0.28, h: 0.45 },
    { label: "debug-right2", x: 0.50, y: 0.35, w: 0.30, h: 0.45 },
    { label: "debug-right3", x: 0.55, y: 0.35, w: 0.25, h: 0.45 },
    { label: "debug-full",   x: 0.20, y: 0.30, w: 0.65, h: 0.50 },
    // Current production crop
    { label: "prod-roll",    x: 0.26, y: 0.28, w: 0.21, h: 0.52 },
  ];

  const base = file.replace(/\.\w+$/, "");
  for (const c of cropTests) {
    const cx = Math.floor(w * c.x);
    const cy = Math.floor(h * c.y);
    const cw = Math.floor(w * c.w);
    const cHgt = Math.floor(h * c.h);
    const outPath = path.join(OUT_DIR, `${base}-${c.label}.png`);
    await sharp(imgPath)
      .extract({ left: cx, top: cy, width: cw, height: cHgt })
      .toFile(outPath);
    console.log(`  Saved ${c.label}: x=${cx}(${(c.x*100).toFixed(0)}%) y=${cy} w=${cw} h=${cHgt} -> ${path.basename(outPath)}`);
  }
}

async function main() {
  const files = fs
    .readdirSync(CORPUS_DIR)
    .filter((f) => /multipanel/i.test(f) && /\.(png|jpg|jpeg)$/i.test(f))
    .sort();

  if (files.length === 0) {
    console.log("No multipanel images found in", CORPUS_DIR);
    return;
  }

  for (const f of files) {
    await analyze(f);
  }
  console.log(`\nDone. Check riven-ocr-debug/ for crop images.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
