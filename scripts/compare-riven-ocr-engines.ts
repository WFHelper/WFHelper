#!/usr/bin/env npx tsx
import fs from "node:fs";
import path from "node:path";
import { createRewardOcrRunner } from "../services/rewardScannerOcr";
import { __test__ as rivenTest, parseRivenStats } from "../ipc/overlay/rivenScan";

const corpusDir = path.join(process.cwd(), "OCR-debug", "riven_images");
const files = fs
  .readdirSync(corpusDir)
  .filter((file) => /\.(png|jpg|jpeg)$/i.test(file))
  .sort();

const CROPS = {
  single: { x: 0.3, y: 0.38, width: 0.4, height: 0.38 },
  left: { x: 0.15, y: 0.38, width: 0.28, height: 0.38 },
  right: { x: 0.5, y: 0.38, width: 0.28, height: 0.38 },
};

type EngineName = "windows" | "tesseract" | "native";

interface ImageInfo {
  width: number;
  height: number;
  data: Buffer;
  channels: 1 | 4;
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

function autoScale(imgWidth: number): number {
  const minWidth = 1800;
  if (imgWidth >= minWidth) return 1;
  return Math.ceil(minWidth / imgWidth);
}

function brightThreshold(img: ImageInfo, threshold: number): ImageInfo {
  const out = Buffer.alloc(img.width * img.height);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j += 1) {
    const r = img.data[i];
    const g = img.data[i + 1];
    const b = img.data[i + 2];
    out[j] = Math.max(r, g, b) >= threshold ? 0 : 255;
  }
  return { width: img.width, height: img.height, data: out, channels: 1 as const };
}

function lowSatHighBright(img: ImageInfo, minBright: number, maxSat: number): ImageInfo {
  const out = Buffer.alloc(img.width * img.height);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j += 1) {
    const r = img.data[i];
    const g = img.data[i + 1];
    const b = img.data[i + 2];
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
    out[j] = maxC >= minBright && sat <= maxSat ? 0 : 255;
  }
  return { width: img.width, height: img.height, data: out, channels: 1 as const };
}

const strategies = [
  {
    name: "bright-120",
    enhance: async (img: ImageInfo) =>
      brightThreshold(await upscaleSharp(img, autoScale(img.width)), 120),
  },
  {
    name: "bright-150",
    enhance: async (img: ImageInfo) =>
      brightThreshold(await upscaleSharp(img, autoScale(img.width)), 150),
  },
  {
    name: "lowsat-bright",
    enhance: async (img: ImageInfo) =>
      lowSatHighBright(await upscaleSharp(img, autoScale(img.width)), 155, 0.35),
  },
];

async function saveTempPng(img: ImageInfo, filePath: string): Promise<void> {
  const sharp = require("sharp") as typeof import("sharp");
  await sharp(Buffer.from(img.data), {
    raw: { width: img.width, height: img.height, channels: img.channels },
  })
    .png()
    .toFile(filePath);
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

  for (const engine of ["windows", "tesseract", "native"] as const) {
    const runner = runnerFor(engine);
    console.log(`\n=== ${engine.toUpperCase()} ===`);
    let totalStats = 0;
    let totalTime = 0;
    let samples = 0;

    for (const file of files) {
      const img = await loadImage(path.join(corpusDir, file));
      const rect = /multipanel/i.test(file) ? CROPS.right : CROPS.single;
      const crop = cropImage(img, rect);
      let bestScore = -Infinity;
      let bestLine = "";
      let bestStats = 0;
      const started = Date.now();

      for (const strat of strategies) {
        const enhanced = await strat.enhance(crop);
        const tmp = path.join(process.cwd(), `tmp-${engine}-${strat.name}.png`);
        await saveTempPng(enhanced, tmp);
        try {
          const text = await runner.runOCR(tmp, 12000);
          const stats = parseRivenStats(text);
          const score = rivenTest.scoreStatsCandidate(stats, text, "");
          if (score > bestScore) {
            bestScore = score;
            bestStats = stats.length;
            bestLine = `${file}: ${strat.name} -> ${stats.length} stats | ${stats.map((s: any) => `${s.name}:${s.value ?? "?"}`).join(", ")}`;
          }
        } finally {
          try {
            fs.unlinkSync(tmp);
          } catch {}
        }
      }

      const elapsed = Date.now() - started;
      totalTime += elapsed;
      totalStats += bestStats;
      samples += 1;
      console.log(`${bestLine} | ${elapsed}ms`);
    }

    console.log(
      `SUMMARY ${engine}: avgTime=${Math.round(totalTime / Math.max(1, samples))}ms avgStats=${(totalStats / Math.max(1, samples)).toFixed(2)}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
