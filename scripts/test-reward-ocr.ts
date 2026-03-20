#!/usr/bin/env npx tsx
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const OUTPUT_DIR = path.join(process.cwd(), "reward-ocr-debug");
const __scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1"));
const OCR_SCRIPT = path.join(__scriptDir, "ocr.ps1");
const SLOT_LAYOUT_REGION = { x: 0.03, y: 0.37, width: 0.94, height: 0.34 };
const FIXED_REWARD_LAYOUTS: Record<
  number,
  Array<{ x: number; y: number; width: number; height: number }>
> = {
  2: [
    { x: 0.37, y: 0.225, width: 0.17, height: 0.225 },
    { x: 0.54, y: 0.225, width: 0.17, height: 0.225 },
  ],
  3: [
    { x: 0.29, y: 0.225, width: 0.15, height: 0.225 },
    { x: 0.44, y: 0.225, width: 0.15, height: 0.225 },
    { x: 0.59, y: 0.225, width: 0.15, height: 0.225 },
  ],
  4: [
    { x: 0.245, y: 0.225, width: 0.122, height: 0.225 },
    { x: 0.372, y: 0.225, width: 0.122, height: 0.225 },
    { x: 0.499, y: 0.225, width: 0.122, height: 0.225 },
    { x: 0.626, y: 0.225, width: 0.122, height: 0.225 },
  ],
};
const HEADER_SQUAD_ICON_RECTS = [
  { x: 0.049, y: 0.037, width: 0.023, height: 0.043 },
  { x: 0.074, y: 0.037, width: 0.023, height: 0.043 },
  { x: 0.099, y: 0.037, width: 0.023, height: 0.043 },
  { x: 0.124, y: 0.037, width: 0.023, height: 0.043 },
];

interface ImageInfo {
  width: number;
  height: number;
  data: Buffer;
  channels: 4;
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
  })
    .png()
    .toFile(filePath);
}

function cropImage(
  img: ImageInfo,
  rect: { x: number; y: number; width: number; height: number },
): ImageInfo {
  const cx = Math.floor(img.width * rect.x);
  const cy = Math.floor(img.height * rect.y);
  const cw = Math.max(24, Math.floor(img.width * rect.width));
  const ch = Math.max(24, Math.floor(img.height * rect.height));
  const out = Buffer.alloc(cw * ch * 4);
  for (let row = 0; row < ch; row += 1) {
    const srcOffset = ((cy + row) * img.width + cx) * 4;
    const dstOffset = row * cw * 4;
    img.data.copy(out, dstOffset, srcOffset, srcOffset + cw * 4);
  }
  return { width: cw, height: ch, data: out, channels: 4 };
}

function luminance(b: number, g: number, r: number): number {
  return (29 * b + 150 * g + 77 * r) >> 8;
}

function smoothColumns(values: number[]): number[] {
  if (values.length <= 2) return values.slice();
  return values.map((value, index) => {
    const prev = index > 0 ? values[index - 1] : value;
    const next = index < values.length - 1 ? values[index + 1] : value;
    return (prev + value + next) / 3;
  });
}

function computeMeanAndStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(Math.max(0, variance)) };
}

function detectRewardSlots(
  img: ImageInfo,
): Array<{ index: number; titleRect: { x: number; y: number; width: number; height: number } }> {
  function buildFixedSlots(layout: Array<{ x: number; y: number; width: number; height: number }>) {
    return layout.map((slot, index) => ({
      index,
      titleRect: {
        x: slot.x,
        y: slot.y + slot.height * 0.7,
        width: slot.width,
        height: slot.height * 0.18,
      },
    }));
  }

  let squadCount = 0;
  for (const rect of HEADER_SQUAD_ICON_RECTS) {
    const crop = cropImage(img, rect);
    let bright = 0;
    let texture = 0;
    let total = 0;
    for (let y = 1; y < crop.height; y += 2) {
      for (let x = 1; x < crop.width; x += 2) {
        const idx = (y * crop.width + x) * 4;
        const prevIdx = (y * crop.width + (x - 1)) * 4;
        const lum = luminance(crop.data[idx], crop.data[idx + 1], crop.data[idx + 2]);
        const prevLum = luminance(
          crop.data[prevIdx],
          crop.data[prevIdx + 1],
          crop.data[prevIdx + 2],
        );
        if (lum >= 48) bright += 1;
        texture += Math.abs(lum - prevLum);
        total += 1;
      }
    }
    const brightRatio = bright / Math.max(1, total);
    const textureAvg = texture / Math.max(1, total);
    if (brightRatio >= 0.25 || textureAvg >= 22) {
      squadCount += 1;
      continue;
    }
    break;
  }

  if (squadCount >= 2 && squadCount <= 4) {
    const forcedLayout = FIXED_REWARD_LAYOUTS[squadCount];
    if (forcedLayout) {
      return buildFixedSlots(forcedLayout);
    }
  }

  let bestFixed: Array<{
    index: number;
    titleRect: { x: number; y: number; width: number; height: number };
  }> | null = null;
  let bestFixedScore = 0;

  for (const layout of Object.values(FIXED_REWARD_LAYOUTS)) {
    const activities = layout.map((slot) => {
      const crop = cropImage(img, slot);
      let bright = 0;
      let total = 0;
      for (let y = 1; y < crop.height; y += 3) {
        for (let x = 1; x < crop.width; x += 3) {
          const idx = (y * crop.width + x) * 4;
          const lum = luminance(crop.data[idx], crop.data[idx + 1], crop.data[idx + 2]);
          if (lum >= 86) bright += 1;
          total += 1;
        }
      }
      return total > 0 ? bright / total : 0;
    });

    const activeCount = activities.filter((value) => value >= 0.12).length;
    const avg = activities.reduce((sum, value) => sum + value, 0) / Math.max(1, activities.length);
    if (activeCount < layout.length) continue;
    const score = activeCount / Math.max(1, layout.length) + avg + layout.length * 0.15;
    if (score > bestFixedScore) {
      bestFixedScore = score;
      bestFixed = layout.map((slot, index) => ({
        index,
        titleRect: buildFixedSlots([slot])[0].titleRect,
      }));
    }
  }

  if (bestFixed && bestFixedScore >= 0.7) return bestFixed;

  const region = cropImage(img, SLOT_LAYOUT_REGION);
  const colScores = new Array<number>(region.width).fill(0);
  for (let x = 0; x < region.width; x += 1) {
    let score = 0;
    for (let y = 0; y < region.height; y += 2) {
      const idx = (y * region.width + x) * 4;
      const b = region.data[idx];
      const g = region.data[idx + 1];
      const r = region.data[idx + 2];
      const lum = luminance(b, g, r);
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
      if (lum >= 108 || (lum >= 86 && sat <= 0.38)) score += 1;
    }
    colScores[x] = score;
  }
  const smoothed = smoothColumns(colScores);
  const stats = computeMeanAndStd(smoothed);
  const threshold = Math.max(3, stats.mean + stats.std * 0.38);
  const minRun = Math.max(18, Math.floor(region.width * 0.05));
  const runs: Array<{ start: number; end: number }> = [];
  let runStart = -1;
  for (let i = 0; i < smoothed.length; i += 1) {
    if (smoothed[i] >= threshold) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0 && i - runStart >= minRun) runs.push({ start: runStart, end: i - 1 });
    runStart = -1;
  }
  if (runStart >= 0 && smoothed.length - runStart >= minRun)
    runs.push({ start: runStart, end: smoothed.length - 1 });
  return runs.slice(0, 4).map((run, index) => {
    const pad = Math.max(8, Math.floor(region.width * 0.01));
    const start = Math.max(0, run.start - pad);
    const end = Math.min(region.width - 1, run.end + pad);
    const widthRatio = ((end - start + 1) / region.width) * SLOT_LAYOUT_REGION.width;
    const xRatio = SLOT_LAYOUT_REGION.x + (start / region.width) * SLOT_LAYOUT_REGION.width;
    const heightRatio = SLOT_LAYOUT_REGION.height;
    const yRatio = SLOT_LAYOUT_REGION.y;
    return {
      index,
      titleRect: {
        x: xRatio,
        y: yRatio + heightRatio * 0.56,
        width: widthRatio,
        height: heightRatio * 0.16,
      },
    };
  });
}

function runPowerShellOCR(imagePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-ExecutionPolicy", "Bypass", "-NonInteractive", "-File", OCR_SCRIPT, imagePath],
      { timeout: 10000, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`OCR failed: ${err.message}${stderr ? `\n${stderr.trim()}` : ""}`));
          return;
        }
        resolve(stdout || "");
      },
    );
  });
}

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error("Usage: npx tsx scripts/test-reward-ocr.ts <image>");
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const filePath = path.resolve(input);
  const img = await loadImage(filePath);
  const slots = detectRewardSlots(img);
  const lines: string[] = [
    `Reward OCR Debug — ${path.basename(filePath)}`,
    `Slots detected: ${slots.length}`,
    "",
  ];

  for (const slot of slots) {
    const crop = cropImage(img, slot.titleRect);
    const outPath = path.join(OUTPUT_DIR, `slot-${slot.index + 1}.png`);
    await savePng(outPath, crop);
    let text = "";
    try {
      text = (await runPowerShellOCR(outPath)).replace(/\r?\n/g, " | ").trim();
    } catch (err) {
      text = `[OCR ERROR] ${(err as Error).message}`;
    }
    lines.push(`slot ${slot.index + 1}: ${text}`);
  }

  const resultPath = path.join(OUTPUT_DIR, "reward-results.txt");
  fs.writeFileSync(resultPath, lines.join("\n"), "utf8");
  console.log(lines.join("\n"));
  console.log(`\nSaved debug output to ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
