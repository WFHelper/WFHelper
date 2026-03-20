"use strict";

/**
 * Image processing helpers for reward scanning.
 * Crop, enhance, and build OCR variants from Electron NativeImage objects.
 */

import { withScope } from "./logger";
import { clampNumber, clamp01, computeMeanAndStd, luminanceFromBgr } from "./rewardScannerUtils";
const { normalizeErrorMessage } = require("../config/shared/errors.cjs") as {
  normalizeErrorMessage: (err: any) => string;
};

const log = withScope("rewardScanner");

export const OCR_ENHANCE: Readonly<{
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

export function cropRewardBand(nativeImage: any, band: Band | null | undefined): any {
  const { width, height } = nativeImage.getSize();
  const topRatio = clampNumber(band?.top, 0.0, 0.95, 0.38);
  const maxHeightRatio = Math.max(0.05, 1.0 - topRatio);
  const heightRatio = clampNumber(band?.height, 0.05, maxHeightRatio, 0.36);
  const top = Math.floor(height * topRatio);
  const cropHeight = Math.max(24, Math.floor(height * heightRatio));
  return nativeImage.crop({ x: 0, y: top, width, height: cropHeight });
}

export function cropBand(nativeImage: any, band: Band | null | undefined): any {
  const { width, height } = nativeImage.getSize();
  const topRatio = clampNumber(band?.top, 0.0, 0.95, 0.16);
  const maxHeightRatio = Math.max(0.04, 1.0 - topRatio);
  const heightRatio = clampNumber(band?.height, 0.04, maxHeightRatio, 0.12);
  const top = Math.floor(height * topRatio);
  const cropHeight = Math.max(18, Math.floor(height * heightRatio));
  return nativeImage.crop({ x: 0, y: top, width, height: cropHeight });
}

export function cropRect(nativeImage: any, rect: Rect | null | undefined): any {
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

export function enhanceForOcr(nativeImage: any): any {
  const { width, height } = nativeImage.getSize();
  const scaledWidth = Math.min(
    OCR_ENHANCE.maxWidth,
    Math.max(width, Math.floor(width * OCR_ENHANCE.upscaleFactor)),
  );
  const scaledHeight = Math.min(
    OCR_ENHANCE.maxHeight,
    Math.max(height, Math.floor(height * OCR_ENHANCE.upscaleFactor)),
  );

  let resized = nativeImage;
  if (scaledWidth !== width || scaledHeight !== height) {
    resized = nativeImage.resize({
      width: scaledWidth,
      height: scaledHeight,
      quality: "best",
    });
  }

  const bitmap: Buffer = resized.toBitmap();
  for (let i = 0; i < bitmap.length; i += 4) {
    const blue = bitmap[i];
    const green = bitmap[i + 1];
    const red = bitmap[i + 2];
    const luminance = luminanceFromBgr(blue, green, red);

    let normalized =
      (luminance - OCR_ENHANCE.blackPoint) /
      Math.max(1, OCR_ENHANCE.whitePoint - OCR_ENHANCE.blackPoint);
    normalized = Math.max(0, Math.min(1, normalized));

    const boosted = Math.round(Math.pow(normalized, 0.9) * 255);
    bitmap[i] = boosted;
    bitmap[i + 1] = boosted;
    bitmap[i + 2] = boosted;
    bitmap[i + 3] = 255;
  }

  const { nativeImage: electronNativeImage } = require("electron") as typeof import("electron");
  return electronNativeImage.createFromBitmap(bitmap, {
    width: scaledWidth,
    height: scaledHeight,
  });
}

interface OcrVariant {
  id: string;
  image: any;
}

export interface RewardSlotRect {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  titleRect: { x: number; y: number; width: number; height: number };
}

export interface RewardSlotLayout {
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
  nativeImage: any,
  rect: { x: number; y: number; width: number; height: number },
): number {
  let region: any;
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

function detectRewardSquadCount(nativeImage: any): number {
  let count = 0;
  for (const rect of HEADER_SQUAD_ICON_RECTS) {
    let region: any;
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

function detectFixedRewardSlotLayout(nativeImage: any): RewardSlotLayout | null {
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

export function detectRewardSlotLayout(nativeImage: any): RewardSlotLayout {
  if (!nativeImage || typeof nativeImage.getSize !== "function") {
    return { count: 0, confidence: 0, slots: [] };
  }

  const fixedLayout = detectFixedRewardSlotLayout(nativeImage);
  if (fixedLayout) return fixedLayout;

  let region: any;
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

export function buildOcrVariants(nativeImage: any): OcrVariant[] {
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
