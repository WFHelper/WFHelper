/**
 * Image processing helpers for reward scanning.
 * Crop, enhance, and build OCR variants from Electron NativeImage objects.
 */

import { withScope } from "./logger";
import type { NativeImage } from "electron";
import { clamp01, computeMeanAndStd, luminanceFromBgr } from "./rewardScannerUtils";
import { clampNumber } from "../config/shared/numeric";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("rewardScanner");

// Warframe renders at 16:9.  On non-16:9 displays, black bars appear.
// Detect them so crop ratios align to game content, not the full frame.

interface GameContentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const BAR_LUMA_THRESHOLD = 12; // pixel considered "black bar" if luma ≤ this
const BAR_SAMPLE_COUNT = 32;   // number of samples per row/col test
const BAR_BLACK_RATIO = 0.85;  // fraction of samples that must be black

export function detectGameContentRect(nativeImage: NativeImage): GameContentRect {
  const { width, height } = nativeImage.getSize();
  if (width < 120 || height < 80) return { x: 0, y: 0, width, height };

  const bitmap: Buffer = nativeImage.toBitmap();

  function isRowBlack(y: number): boolean {
    let blackCount = 0;
    const step = Math.max(1, Math.floor(width / BAR_SAMPLE_COUNT));
    for (let sx = 0; sx < BAR_SAMPLE_COUNT; sx++) {
      const x = Math.min(width - 1, sx * step);
      const idx = (y * width + x) * 4;
      const lum = (bitmap[idx] + bitmap[idx + 1] + bitmap[idx + 2]) / 3;
      if (lum <= BAR_LUMA_THRESHOLD) blackCount++;
    }
    return blackCount / BAR_SAMPLE_COUNT >= BAR_BLACK_RATIO;
  }

  function isColBlack(x: number): boolean {
    let blackCount = 0;
    const step = Math.max(1, Math.floor(height / BAR_SAMPLE_COUNT));
    for (let sy = 0; sy < BAR_SAMPLE_COUNT; sy++) {
      const y = Math.min(height - 1, sy * step);
      const idx = (y * width + x) * 4;
      const lum = (bitmap[idx] + bitmap[idx + 1] + bitmap[idx + 2]) / 3;
      if (lum <= BAR_LUMA_THRESHOLD) blackCount++;
    }
    return blackCount / BAR_SAMPLE_COUNT >= BAR_BLACK_RATIO;
  }

  // Scan inward from each edge to find the content boundary.
  let top = 0;
  for (let y = 0; y < Math.floor(height * 0.25); y++) {
    if (!isRowBlack(y)) { top = y; break; }
    top = y + 1;
  }
  let bottom = height;
  for (let y = height - 1; y >= Math.floor(height * 0.75); y--) {
    if (!isRowBlack(y)) { bottom = y + 1; break; }
    bottom = y;
  }
  let left = 0;
  for (let x = 0; x < Math.floor(width * 0.25); x++) {
    if (!isColBlack(x)) { left = x; break; }
    left = x + 1;
  }
  let right = width;
  for (let x = width - 1; x >= Math.floor(width * 0.75); x--) {
    if (!isColBlack(x)) { right = x + 1; break; }
    right = x;
  }

  const contentW = Math.max(24, right - left);
  const contentH = Math.max(24, bottom - top);
  return { x: left, y: top, width: contentW, height: contentH };
}

const OCR_ENHANCE: Readonly<{
  upscaleFactor: number;
  maxWidth: number;
  maxHeight: number;
  blackPoint: number;
  whitePoint: number;
}> = Object.freeze({
  upscaleFactor: 2,
  maxWidth: 4096,
  maxHeight: 4096,
  blackPoint: 72,
  whitePoint: 214,
});

interface Band {
  top?: number;
  height?: number;
}

interface Rect {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export function cropRewardBand(nativeImage: NativeImage, band: Band | null | undefined): NativeImage {
  const { width, height } = nativeImage.getSize();
  const topRatio = clampNumber(band?.top, 0.0, 0.95, 0.38);
  const maxHeightRatio = Math.max(0.05, 1.0 - topRatio);
  const heightRatio = clampNumber(band?.height, 0.05, maxHeightRatio, 0.36);
  const top = Math.floor(height * topRatio);
  const cropHeight = Math.max(24, Math.floor(height * heightRatio));
  return nativeImage.crop({ x: 0, y: top, width, height: cropHeight });
}

export function cropBand(nativeImage: NativeImage, band: Band | null | undefined): NativeImage {
  const { width, height } = nativeImage.getSize();
  const topRatio = clampNumber(band?.top, 0.0, 0.95, 0.16);
  const maxHeightRatio = Math.max(0.04, 1.0 - topRatio);
  const heightRatio = clampNumber(band?.height, 0.04, maxHeightRatio, 0.12);
  const top = Math.floor(height * topRatio);
  const cropHeight = Math.max(18, Math.floor(height * heightRatio));
  return nativeImage.crop({ x: 0, y: top, width, height: cropHeight });
}

export function cropRect(nativeImage: NativeImage, rect: Rect | null | undefined): NativeImage {
  const { width, height } = nativeImage.getSize();
  const xRatio = clampNumber(rect?.x, 0.0, 0.98, 0);
  const yRatio = clampNumber(rect?.y, 0.0, 0.98, 0);
  const maxWidthRatio = Math.max(0.02, 1 - xRatio);
  const maxHeightRatio = Math.max(0.02, 1 - yRatio);
  const widthRatio = clampNumber(rect?.width, 0.02, maxWidthRatio, 0.2);
  const heightRatio = clampNumber(rect?.height, 0.02, maxHeightRatio, 0.2);

  const x = Math.floor(width * xRatio);
  const y = Math.floor(height * yRatio);
  const cropWidth = Math.max(24, Math.floor(width * widthRatio));
  const cropHeight = Math.max(24, Math.floor(height * heightRatio));

  return nativeImage.crop({ x, y, width: cropWidth, height: cropHeight });
}

/**
 * Letterbox-aware crop: applies ratio-based rect relative to the detected
 * 16:9 game content area instead of the full frame.  On standard 16:9
 * displays, contentRect matches the full frame = zero overhead.
 */
export function cropRectContent(
  nativeImage: NativeImage,
  rect: Rect | null | undefined,
  contentRect: GameContentRect,
): NativeImage {
  const xRatio = clampNumber(rect?.x, 0.0, 0.98, 0);
  const yRatio = clampNumber(rect?.y, 0.0, 0.98, 0);
  const maxWidthRatio = Math.max(0.02, 1 - xRatio);
  const maxHeightRatio = Math.max(0.02, 1 - yRatio);
  const widthRatio = clampNumber(rect?.width, 0.02, maxWidthRatio, 0.2);
  const heightRatio = clampNumber(rect?.height, 0.02, maxHeightRatio, 0.2);

  const x = Math.max(0, contentRect.x + Math.floor(contentRect.width * xRatio));
  const y = Math.max(0, contentRect.y + Math.floor(contentRect.height * yRatio));
  const cropWidth = Math.max(24, Math.floor(contentRect.width * widthRatio));
  const cropHeight = Math.max(24, Math.floor(contentRect.height * heightRatio));

  return nativeImage.crop({ x, y, width: cropWidth, height: cropHeight });
}

function enhanceForOcr(nativeImage: NativeImage): NativeImage {
  const { width, height } = nativeImage.getSize();
  const scaledWidth = Math.min(
    OCR_ENHANCE.maxWidth,
    Math.max(width, Math.floor(width * OCR_ENHANCE.upscaleFactor)),
  );
  const scaledHeight = Math.min(
    OCR_ENHANCE.maxHeight,
    Math.max(height, Math.floor(height * OCR_ENHANCE.upscaleFactor)),
  );

  const range = Math.max(1, OCR_ENHANCE.whitePoint - OCR_ENHANCE.blackPoint);

  // Precomputed 256-entry LUT: input luminance → output value.
  // Replaces per-pixel Math.pow / normalize / clamp with a single table lookup.
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let normalized = (i - OCR_ENHANCE.blackPoint) / range;
    if (normalized < 0) normalized = 0;
    else if (normalized > 1) normalized = 1;
    lut[i] = (Math.pow(normalized, 0.9) * 255 + 0.5) | 0;
  }

  let targetBitmap: Buffer;
  let targetW: number;
  let targetH: number;

  if (scaledWidth === width && scaledHeight === height) {
    targetBitmap = nativeImage.toBitmap();
    targetW = width;
    targetH = height;
  } else {
    const resized = nativeImage.resize({
      width: scaledWidth,
      height: scaledHeight,
      quality: "best",
    });
    targetBitmap = resized.toBitmap();
    targetW = scaledWidth;
    targetH = scaledHeight;
  }

  // Apply LUT: BGRA bitmap → greyscale via integer luminance approximation.
  for (let i = 0; i < targetBitmap.length; i += 4) {
    // BT.601 luminance: (114*B + 587*G + 299*R) / 1000
    const lum = ((targetBitmap[i] * 114 + targetBitmap[i + 1] * 587 + targetBitmap[i + 2] * 299 + 500) / 1000) | 0;
    const out = lut[lum > 255 ? 255 : lum < 0 ? 0 : lum];
    targetBitmap[i] = out;
    targetBitmap[i + 1] = out;
    targetBitmap[i + 2] = out;
    targetBitmap[i + 3] = 255;
  }

  const { nativeImage: electronNativeImage } = require("electron") as typeof import("electron");
  return electronNativeImage.createFromBitmap(targetBitmap, {
    width: targetW,
    height: targetH,
  });
}

interface OcrVariant {
  id: string;
  image: NativeImage;
}

interface RewardSlotRect {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  titleRect: { x: number; y: number; width: number; height: number };
}

interface RewardSlotLayout {
  count: number;
  confidence: number;
  slots: RewardSlotRect[];
}

const SLOT_LAYOUT_REGION = Object.freeze({ x: 0.03, y: 0.37, width: 0.94, height: 0.34 });

const FIXED_REWARD_LAYOUTS: Readonly<
  Record<number, Array<{ x: number; y: number; width: number; height: number }>>
> = Object.freeze({
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
});

const HEADER_SQUAD_ICON_RECTS: ReadonlyArray<{
  x: number;
  y: number;
  width: number;
  height: number;
}> = Object.freeze([
  { x: 0.049, y: 0.037, width: 0.023, height: 0.043 },
  { x: 0.074, y: 0.037, width: 0.023, height: 0.043 },
  { x: 0.099, y: 0.037, width: 0.023, height: 0.043 },
  { x: 0.124, y: 0.037, width: 0.023, height: 0.043 },
]);

function smoothColumns(values: number[]): number[] {
  if (values.length <= 2) return values.slice();
  return values.map((value, index) => {
    const prev = index > 0 ? values[index - 1] : value;
    const next = index < values.length - 1 ? values[index + 1] : value;
    return (prev + value + next) / 3;
  });
}

function collectRuns(
  values: number[],
  threshold: number,
  minRun: number,
): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  let runStart = -1;

  for (let i = 0; i < values.length; i += 1) {
    if (values[i] >= threshold) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0 && i - runStart >= minRun) {
      runs.push({ start: runStart, end: i - 1 });
    }
    runStart = -1;
  }

  if (runStart >= 0 && values.length - runStart >= minRun) {
    runs.push({ start: runStart, end: values.length - 1 });
  }

  return runs;
}

function computeSlotActivity(
  nativeImage: NativeImage,
  rect: { x: number; y: number; width: number; height: number },
): number {
  let region: NativeImage;
  try {
    region = cropRect(nativeImage, rect);
  } catch {
    return 0;
  }

  const { width, height } = region.getSize();
  if (width < 30 || height < 30) return 0;
  const bitmap: Buffer = region.toBitmap();
  const stepX = Math.max(1, Math.floor(width / 80));
  const stepY = Math.max(1, Math.floor(height / 80));
  let brightCount = 0;
  let texture = 0;
  let total = 0;

  for (let y = stepY; y < height; y += stepY) {
    for (let x = stepX; x < width; x += stepX) {
      const idx = (y * width + x) * 4;
      const prevIdx = (y * width + (x - stepX)) * 4;
      const blue = bitmap[idx];
      const green = bitmap[idx + 1];
      const red = bitmap[idx + 2];
      const prevBlue = bitmap[prevIdx];
      const prevGreen = bitmap[prevIdx + 1];
      const prevRed = bitmap[prevIdx + 2];
      const lum = luminanceFromBgr(blue, green, red);
      const prevLum = luminanceFromBgr(prevBlue, prevGreen, prevRed);
      if (lum >= 86) brightCount += 1;
      texture += Math.abs(lum - prevLum);
      total += 1;
    }
  }

  if (total === 0) return 0;
  const brightScore = clamp01(brightCount / total / 0.24);
  const textureScore = clamp01(texture / total / 42);
  return Number((brightScore * 0.45 + textureScore * 0.55).toFixed(3));
}

function detectRewardSquadCount(nativeImage: NativeImage): number {
  let count = 0;
  for (const rect of HEADER_SQUAD_ICON_RECTS) {
    let region: NativeImage;
    try {
      region = cropRect(nativeImage, rect);
    } catch {
      break;
    }

    const { width, height } = region.getSize();
    const bitmap: Buffer = region.toBitmap();
    let bright = 0;
    let texture = 0;
    let total = 0;
    for (let y = 1; y < height; y += 2) {
      for (let x = 1; x < width; x += 2) {
        const idx = (y * width + x) * 4;
        const prevIdx = (y * width + (x - 1)) * 4;
        const lum = luminanceFromBgr(bitmap[idx], bitmap[idx + 1], bitmap[idx + 2]);
        const prevLum = luminanceFromBgr(bitmap[prevIdx], bitmap[prevIdx + 1], bitmap[prevIdx + 2]);
        if (lum >= 48) bright += 1;
        texture += Math.abs(lum - prevLum);
        total += 1;
      }
    }
    const brightRatio = bright / Math.max(1, total);
    const textureAvg = texture / Math.max(1, total);
    if (brightRatio >= 0.25 || textureAvg >= 22) {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

function detectFixedRewardSlotLayout(nativeImage: NativeImage): RewardSlotLayout | null {
  let best: RewardSlotLayout | null = null;
  const squadCount = detectRewardSquadCount(nativeImage);

  function buildFixedSlots(
    layout: Array<{ x: number; y: number; width: number; height: number }>,
  ): RewardSlotRect[] {
    return layout.map((slot, index) => ({
      index,
      x: slot.x,
      y: slot.y,
      width: slot.width,
      height: slot.height,
      titleRect: {
        x: slot.x,
        y: slot.y + slot.height * 0.7,
        width: slot.width,
        height: slot.height * 0.18,
      },
    }));
  }

  if (squadCount >= 2 && squadCount <= 4) {
    const forcedLayout = FIXED_REWARD_LAYOUTS[squadCount];
    if (forcedLayout) {
      return {
        count: squadCount,
        confidence: 0.92,
        slots: buildFixedSlots(forcedLayout),
      };
    }
  }

  for (const [countKey, layout] of Object.entries(FIXED_REWARD_LAYOUTS)) {
    const count = Number(countKey);
    const activities = layout.map((slot) => computeSlotActivity(nativeImage, slot));
    const activeCount = activities.filter((score) => score >= 0.22).length;
    const avgScore =
      activities.reduce((sum, score) => sum + score, 0) / Math.max(1, activities.length);
    const confidence = Number(
      (
        clamp01(activeCount / count) * 0.45 +
        clamp01(avgScore / 0.7) * 0.35 +
        clamp01(count / 4) * 0.2
      ).toFixed(3),
    );
    if (activeCount < count) continue;

    const slots: RewardSlotRect[] = buildFixedSlots(layout);

    if (!best || confidence > best.confidence) {
      best = { count, confidence, slots };
    }
  }

  return best && best.confidence >= 0.5 ? best : null;
}

export function detectRewardSlotLayout(nativeImage: NativeImage): RewardSlotLayout {
  if (!nativeImage || typeof nativeImage.getSize !== "function") {
    return { count: 0, confidence: 0, slots: [] };
  }

  const fixedLayout = detectFixedRewardSlotLayout(nativeImage);
  if (fixedLayout) return fixedLayout;

  let region: NativeImage;
  try {
    region = cropRect(nativeImage, SLOT_LAYOUT_REGION);
  } catch {
    return { count: 0, confidence: 0, slots: [] };
  }

  const { width, height } = region.getSize();
  if (width < 120 || height < 60) {
    return { count: 0, confidence: 0, slots: [] };
  }

  const bitmap: Buffer = region.toBitmap();
  const colScores = new Array<number>(width).fill(0);

  for (let x = 0; x < width; x += 1) {
    let score = 0;
    for (let y = 0; y < height; y += 2) {
      const idx = (y * width + x) * 4;
      const blue = bitmap[idx];
      const green = bitmap[idx + 1];
      const red = bitmap[idx + 2];
      const lum = luminanceFromBgr(blue, green, red);
      const maxC = Math.max(red, green, blue);
      const minC = Math.min(red, green, blue);
      const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
      if (lum >= 108 || (lum >= 86 && sat <= 0.38)) {
        score += 1;
      }
    }
    colScores[x] = score;
  }

  const smoothed = smoothColumns(colScores);
  const stats = computeMeanAndStd(smoothed);
  const threshold = Math.max(3, stats.mean + stats.std * 0.38);
  const minRun = Math.max(18, Math.floor(width * 0.05));
  const runs = collectRuns(smoothed, threshold, minRun)
    .map((run) => {
      const pad = Math.max(8, Math.floor(width * 0.01));
      return {
        start: Math.max(0, run.start - pad),
        end: Math.min(width - 1, run.end + pad),
      };
    })
    .slice(0, 4);

  if (runs.length === 0) {
    return { count: 0, confidence: 0, slots: [] };
  }

  const slots: RewardSlotRect[] = runs.map((run, index) => {
    const runWidth = Math.max(32, run.end - run.start + 1);
    const xRatio = SLOT_LAYOUT_REGION.x + (run.start / width) * SLOT_LAYOUT_REGION.width;
    const widthRatio = (runWidth / width) * SLOT_LAYOUT_REGION.width;
    const yRatio = SLOT_LAYOUT_REGION.y;
    const heightRatio = SLOT_LAYOUT_REGION.height;

    return {
      index,
      x: xRatio,
      y: yRatio,
      width: widthRatio,
      height: heightRatio,
      titleRect: {
        x: xRatio,
        y: yRatio + heightRatio * 0.56,
        width: widthRatio,
        height: heightRatio * 0.16,
      },
    };
  });

  const coverage =
    runs.reduce((sum, run) => sum + (run.end - run.start + 1), 0) / Math.max(1, width);
  const confidence = Number(
    (
      clamp01(runs.length / 4) * 0.45 +
      clamp01(coverage / 0.72) * 0.3 +
      clamp01(stats.std / 36) * 0.25
    ).toFixed(3),
  );

  return {
    count: runs.length,
    confidence,
    slots,
  };
}

/**
 * Detect whether the Warframe in-game chat console is open.
 *
 * When the player presses `/` (or `T`), a bright text-input bar appears across
 * the bottom ~4% of the screen.  This corrupts reward-band OCR because the chat
 * text overlaps the reward names.
 *
 * Heuristic: sample the bottom 4% strip of the frame.  If >55% of sampled
 * pixels are bright (luminance ≥ 140) AND exhibit low saturation (≤ 0.3),
 * the console is very likely open.  Warframe's chat bar is a near-white
 * semi-transparent overlay, so this is a reliable signal.
 */
export function detectConsoleOpen(nativeImage: NativeImage): boolean {
  if (!nativeImage || typeof nativeImage.getSize !== "function") return false;

  const { width, height } = nativeImage.getSize();
  if (width < 120 || height < 120) return false;

  const stripTop = Math.floor(height * 0.96);
  const stripHeight = height - stripTop;
  if (stripHeight < 4) return false;

  let strip: NativeImage;
  try {
    strip = nativeImage.crop({ x: 0, y: stripTop, width, height: stripHeight });
  } catch {
    return false;
  }

  const bitmap: Buffer = strip.toBitmap();
  const stepX = Math.max(1, Math.floor(width / 200));
  const stepY = Math.max(1, Math.floor(stripHeight / 8));

  let bright = 0;
  let total = 0;

  for (let y = 0; y < stripHeight; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const idx = (y * width + x) * 4;
      const blue = bitmap[idx];
      const green = bitmap[idx + 1];
      const red = bitmap[idx + 2];
      const lum = luminanceFromBgr(blue, green, red);
      const maxC = Math.max(red, green, blue);
      const minC = Math.min(red, green, blue);
      const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
      if (lum >= 140 && sat <= 0.3) bright += 1;
      total += 1;
    }
  }

  return total > 0 && bright / total >= 0.55;
}

export function buildOcrVariants(nativeImage: NativeImage): OcrVariant[] {
  const variants: OcrVariant[] = [{ id: "raw", image: nativeImage }];

  try {
    const enhanced = enhanceForOcr(nativeImage);
    if (enhanced && !enhanced.isEmpty()) {
      variants.push({ id: "enhanced", image: enhanced });
    }
  } catch (err) {
    log.warn("[RewardScanner] OCR enhancement failed:", normalizeErrorMessage(err));
  }

  return variants;
}
