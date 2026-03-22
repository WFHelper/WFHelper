#!/usr/bin/env npx tsx
/**
 * Analyze card geometry on debug images — outputs row luminance profiles
 * to understand where text lines are within the card crop.
 * 
 * Usage: npx tsx scripts/debug-card-geometry.ts [--save-crops]
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const SINGLE_CARD_CROP = { x: 0.22, y: 0.43, width: 0.56, height: 0.45 };
const ROLL_CARD_CROP   = { x: 0.411, y: 0.416, width: 0.177, height: 0.434 };

(async () => {
const saveCrops = process.argv.includes("--save-crops");
const corpusDir = path.join(process.cwd(), "OCR-debug", "riven_images");

const files = fs.readdirSync(corpusDir)
  .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
  .sort();

for (const file of files) {
  const fullPath = path.join(corpusDir, file);
  const isMultipanel = /multipanel/i.test(file);
  const crop = isMultipanel ? ROLL_CARD_CROP : SINGLE_CARD_CROP;

  const raw = await sharp(fullPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = raw.info.width, H = raw.info.height;

  const cx = Math.floor(crop.x * W);
  const cy = Math.floor(crop.y * H);
  const cw = Math.min(Math.floor(crop.width * W), W - cx);
  const ch = Math.min(Math.floor(crop.height * H), H - cy);

  // Extract card crop
  const cardBuf = Buffer.alloc(cw * ch * 4);
  for (let r = 0; r < ch; r++) {
    const srcOff = ((cy + r) * W + cx) * 4;
    raw.data.copy(cardBuf, r * cw * 4, srcOff, srcOff + cw * 4);
  }

  // Row profile: mean and max luma, and fraction of "bright" pixels (luma >= 100)
  const rowMeanLuma = new Float32Array(ch);
  const rowMaxLuma = new Float32Array(ch);
  const rowBrightFrac = new Float32Array(ch);
  for (let y = 0; y < ch; y++) {
    let sum = 0, maxL = 0, bright = 0;
    for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4;
      const luma = 0.299 * cardBuf[i] + 0.587 * cardBuf[i+1] + 0.114 * cardBuf[i+2];
      sum += luma;
      if (luma > maxL) maxL = luma;
      if (luma >= 100) bright++;
    }
    rowMeanLuma[y] = sum / cw;
    rowMaxLuma[y] = maxL;
    rowBrightFrac[y] = bright / cw;
  }

  console.log(`\n=== ${file} (${W}x${H}) card_crop=${cw}x${ch} ===`);

  // Print every 10 rows
  console.log("  row   mean  max  brightFrac%");
  for (let y = 0; y < ch; y += 5) {
    const pct = `${(y / ch * 100).toFixed(0)}%`.padStart(4);
    console.log(
      `  y=${String(y).padStart(3)} (${pct})  mean=${rowMeanLuma[y].toFixed(1).padStart(5)}  max=${rowMaxLuma[y].toFixed(0).padStart(3)}  bright=${(rowBrightFrac[y]*100).toFixed(1).padStart(5)}%`
    );
  }

  if (saveCrops) {
    const outPath = path.join(corpusDir, `__cardcrop_${file.replace(/\.(png|jpg|jpeg)$/i, '.png')}`);
    await sharp(cardBuf, { raw: { width: cw, height: ch, channels: 4 } })
      .png().toFile(outPath);
    console.log(`  Saved card crop to ${outPath}`);
  }
}
})();
