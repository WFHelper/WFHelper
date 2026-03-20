#!/usr/bin/env npx tsx
import fs from "node:fs";
import path from "node:path";
import { createRewardOcrRunner } from "../services/rewardScannerOcr";
import { rankRewardCandidatesDetailed } from "../services/rewardScannerMatch";

const corpusDir = path.join(process.cwd(), "OCR-debug", "reward_images");
const files = fs
  .readdirSync(corpusDir)
  .filter((file) => /\.(png|jpg|jpeg)$/i.test(file))
  .sort();

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

const KNOWN_ITEMS = [
  { name: "Braton Prime Stock" },
  { name: "Trumna Prime Blueprint" },
  { name: "Forma Blueprint" },
  { name: "Caliban Prime Neuroptics Blueprint" },
  { name: "Nautilus Prime Systems" },
  { name: "Epitaph Prime Receiver" },
  { name: "Zephyr Prime Neuroptics Blueprint" },
  { name: "Wukong Prime Chassis Blueprint" },
];

type EngineName = "windows" | "tesseract";

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

async function saveTempPng(img: ImageInfo, filePath: string): Promise<void> {
  const sharp = require("sharp") as typeof import("sharp");
  await sharp(Buffer.from(img.data), {
    raw: { width: img.width, height: img.height, channels: img.channels },
  })
    .png()
    .toFile(filePath);
}

function luminance(b: number, g: number, r: number): number {
  return (29 * b + 150 * g + 77 * r) >> 8;
}

function detectSquadCount(img: ImageInfo): number {
  let count = 0;
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
    if (brightRatio >= 0.25 || textureAvg >= 22) count += 1;
    else break;
  }
  return count;
}

async function main() {
  const runnerFor = (engine: EngineName) =>
    createRewardOcrRunner({
      getRequestedEngine: () => engine,
      engineWindows: "windows",
      engineTesseract: "tesseract",
      ocrScriptPath: path.join(process.cwd(), "scripts", "ocr.ps1"),
      tesseractLanguage: "eng",
    });

  for (const engine of ["windows", "tesseract"] as const) {
    const runner = runnerFor(engine);
    console.log(`\n=== ${engine.toUpperCase()} ===`);
    let totalTime = 0;
    let totalConf = 0;
    let totalSlots = 0;
    for (const file of files) {
      const img = await loadImage(path.join(corpusDir, file));
      const squadCount = detectSquadCount(img);
      const layout = FIXED_REWARD_LAYOUTS[squadCount] || [];
      const started = Date.now();
      const slotResults: string[] = [];
      let confSum = 0;
      for (let i = 0; i < layout.length; i += 1) {
        const slot = layout[i];
        const titleRect = {
          x: slot.x,
          y: slot.y + slot.height * 0.7,
          width: slot.width,
          height: slot.height * 0.18,
        };
        const crop = cropImage(img, titleRect);
        const tmp = path.join(process.cwd(), `tmp-${engine}-reward-${i}.png`);
        await saveTempPng(crop, tmp);
        try {
          const text = await runner.runOCR(tmp, 12000);
          const ranked = rankRewardCandidatesDetailed(text, KNOWN_ITEMS, 3);
          const best = ranked[0];
          confSum += best?.confidence || 0;
          slotResults.push(
            `${i + 1}:${best?.item?.name || "none"} (${(best?.confidence || 0).toFixed(3)})`,
          );
        } finally {
          try {
            fs.unlinkSync(tmp);
          } catch {}
        }
      }
      const elapsed = Date.now() - started;
      totalTime += elapsed;
      totalConf += confSum;
      totalSlots += layout.length;
      console.log(`${file}: slots=${layout.length} | ${slotResults.join(" | ")} | ${elapsed}ms`);
    }
    console.log(
      `SUMMARY ${engine}: avgTime=${Math.round(totalTime / Math.max(1, files.length))}ms avgConfidence=${(totalConf / Math.max(1, totalSlots)).toFixed(3)}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
