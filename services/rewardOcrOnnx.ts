/**
 * ONNX reward-strip reader: reuses the shipped PaddleOCR CH v3 recognizer
 * from the riven pipeline; works when Windows OCR has no language pack.
 * Rows come from ink projection on an Otsu mono, but recognition runs on the
 * raw RGB rows - binarizing eats glare-thinned strokes.
 */

import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import { otsuThreshold } from "./rewardScannerImage";
import {
  paddleRecognizerAvailable,
  recognizePaddleCrops,
  type RgbCrop,
} from "./rivenOcrOnnx";

const log = withScope("rewardOcrOnnx");

const UPSCALE = 3;
// One game text line is ~17-22px at 1080p => ~51-66px after 3x upscale.
// Taller segments are merged wrapped lines and get split at the ink valley.
const MAX_LINE_HEIGHT = 72;
const MIN_LINE_HEIGHT = 10;
const ROW_GAP_TOLERANCE = 2;
const MIN_ROW_CONFIDENCE = 0.55;

export function rewardOcrOnnxAvailable(): boolean {
  return paddleRecognizerAvailable();
}

/** Load the shared paddle session off the scan path - the first crack of a
 * session otherwise pays the ~1.4s model load inside the scan. */
export async function warmupRewardStripOnnx(): Promise<void> {
  if (!paddleRecognizerAvailable()) return;
  try {
    await recognizePaddleCrops([{ data: Buffer.alloc(160 * 48 * 3, 255), width: 160, height: 48 }]);
  } catch (err) {
    log.warn("[RewardOcrOnnx] warmup failed:", normalizeErrorMessage(err));
  }
}

interface RowSegment {
  y1: number;
  y2: number;
}

/** Text rows via horizontal ink projection; over-tall segments split at the weakest row. */
export function splitStripRows(mono: Uint8Array, width: number, height: number): RowSegment[] {
  const inkPerRow = new Array<number>(height).fill(0);
  for (let y = 0; y < height; y++) {
    let ink = 0;
    for (let x = 0; x < width; x++) if (mono[y * width + x] === 0) ink++;
    inkPerRow[y] = ink;
  }

  const minInk = Math.max(3, Math.floor(width * 0.015));
  const segments: RowSegment[] = [];
  let start = -1;
  let gap = 0;
  for (let y = 0; y < height; y++) {
    if (inkPerRow[y] >= minInk) {
      if (start < 0) start = y;
      gap = 0;
    } else if (start >= 0) {
      gap++;
      if (gap > ROW_GAP_TOLERANCE) {
        segments.push({ y1: start, y2: y - gap });
        start = -1;
        gap = 0;
      }
    }
  }
  if (start >= 0) segments.push({ y1: start, y2: height - 1 });

  const out: RowSegment[] = [];
  const queue = [...segments];
  while (queue.length) {
    const seg = queue.shift() as RowSegment;
    const segHeight = seg.y2 - seg.y1 + 1;
    if (segHeight <= MAX_LINE_HEIGHT) {
      out.push(seg);
      continue;
    }
    let valleyY = -1;
    let valleyInk = Infinity;
    const from = seg.y1 + Math.floor(segHeight * 0.25);
    const to = seg.y1 + Math.floor(segHeight * 0.75);
    for (let y = from; y <= to; y++) {
      if (inkPerRow[y] < valleyInk) {
        valleyInk = inkPerRow[y];
        valleyY = y;
      }
    }
    let peakInk = 0;
    for (let y = seg.y1; y <= seg.y2; y++) peakInk = Math.max(peakInk, inkPerRow[y]);
    if (valleyY < 0 || valleyInk >= peakInk * 0.8) {
      out.push(seg);
      continue;
    }
    queue.unshift({ y1: seg.y1, y2: valleyY - 1 }, { y1: valleyY + 1, y2: seg.y2 });
  }

  return out
    .filter((seg) => seg.y2 - seg.y1 + 1 >= MIN_LINE_HEIGHT)
    .sort((a, b) => a.y1 - b.y1);
}

/**
 * The CH model drops word spaces on raw crops ("BratonPrimeStock") - item
 * names are Title Case, so re-split at case boundaries and strip non-ASCII
 * decode artifacts.
 */
export function cleanOnnxRowText(text: string): string {
  return String(text || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9 &'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface RewardStripRow {
  text: string;
  confidence: number;
}

interface RewardStripRead {
  text: string;
  rows: RewardStripRow[];
}

/** Read a reward title-strip PNG. Returns null when unavailable or nothing legible. */
export async function recognizeRewardStripOnnx(stripPng: Buffer): Promise<RewardStripRead | null> {
  try {
    if (!paddleRecognizerAvailable()) return null;

    const sharp: (typeof import("sharp"))["default"] = require("sharp");
    const meta = await sharp(stripPng).metadata();
    const srcW = meta.width ?? 0;
    const srcH = meta.height ?? 0;
    if (srcW < 8 || srcH < 8) return null;

    const targetW = srcW * UPSCALE;
    const { data: gray, info } = await sharp(stripPng)
      .resize({ width: targetW, kernel: "lanczos3" })
      .grayscale()
      .removeAlpha()
      .normalise()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const threshold = otsuThreshold(gray);
    const mono = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) mono[i] = gray[i] >= threshold ? 0 : 255;

    const segments = splitStripRows(mono, info.width, info.height);
    if (segments.length === 0) return null;

    const rgb: Buffer = await sharp(stripPng)
      .resize({ width: targetW, kernel: "lanczos3" })
      .removeAlpha()
      .raw()
      .toBuffer();

    const crops: RgbCrop[] = [];
    for (const seg of segments) {
      const crop = segmentToRgbCrop(mono, rgb, info.width, info.height, seg);
      if (crop) crops.push(crop);
    }
    if (crops.length === 0) return null;

    const results = await recognizePaddleCrops(crops);
    const rows: RewardStripRow[] = [];
    for (const result of results) {
      if (result.confidence < MIN_ROW_CONFIDENCE) continue;
      const text = cleanOnnxRowText(result.text);
      if (!text) continue;
      rows.push({ text, confidence: result.confidence });
    }
    if (rows.length === 0) return null;

    return {
      text: rows.map((row) => row.text).join(" ").replace(/\s+/g, " ").trim(),
      rows,
    };
  } catch (err) {
    log.warn("[RewardOcrOnnx] strip read failed:", normalizeErrorMessage(err));
    return null;
  }
}

/** Trim a row segment to its ink columns and cut the raw RGB crop for recognition. */
function segmentToRgbCrop(
  mono: Uint8Array,
  rgb: Buffer,
  width: number,
  height: number,
  seg: RowSegment,
): RgbCrop | null {
  const y1 = Math.max(0, seg.y1 - 4);
  const y2 = Math.min(height - 1, seg.y2 + 4);
  let minX = width;
  let maxX = -1;
  for (let y = y1; y <= y2; y++) {
    for (let x = 0; x < width; x++) {
      if (mono[y * width + x] === 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  if (maxX < 0) return null;

  const x1 = Math.max(0, minX - 8);
  const x2 = Math.min(width - 1, maxX + 8);
  const cropW = x2 - x1 + 1;
  const cropH = y2 - y1 + 1;
  const data = Buffer.alloc(cropW * cropH * 3);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const src = ((y1 + y) * width + (x1 + x)) * 3;
      const dst = (y * cropW + x) * 3;
      data[dst] = rgb[src];
      data[dst + 1] = rgb[src + 1];
      data[dst + 2] = rgb[src + 2];
    }
  }
  return { data, width: cropW, height: cropH };
}
