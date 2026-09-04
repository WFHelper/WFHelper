import { withScope } from "./logger";
import type { NativeImage } from "electron";
import { clamp01, computeMeanAndStd, luminanceFromBgr } from "./rewardScannerUtils";
import { clampNumber } from "../config/shared/numeric";
import { REFERENCE_WARFRAME_UI_SCALE } from "../config/runtime/overlaySettings";
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

const BAR_LUMA_THRESHOLD = 12; // pixel considered "black bar" if luma <= this
const BAR_SAMPLE_COUNT = 32; // number of samples per row/col test
const BAR_BLACK_RATIO = 0.85; // fraction of samples that must be black

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
    if (!isRowBlack(y)) {
      top = y;
      break;
    }
    top = y + 1;
  }
  let bottom = height;
  for (let y = height - 1; y >= Math.floor(height * 0.75); y--) {
    if (!isRowBlack(y)) {
      bottom = y + 1;
      break;
    }
    bottom = y;
  }
  let left = 0;
  for (let x = 0; x < Math.floor(width * 0.25); x++) {
    if (!isColBlack(x)) {
      left = x;
      break;
    }
    left = x + 1;
  }
  let right = width;
  for (let x = width - 1; x >= Math.floor(width * 0.75); x--) {
    if (!isColBlack(x)) {
      right = x + 1;
      break;
    }
    right = x;
  }

  // Real bars come in equal pairs (the game centres its output). An unequal
  // pair is a dark scene edge - shrink both sides to the smaller bar.
  const pillar = Math.min(left, width - right);
  const letter = Math.min(top, height - bottom);

  const contentW = Math.max(24, width - 2 * pillar);
  const contentH = Math.max(24, height - 2 * letter);
  return { x: pillar, y: letter, width: contentW, height: contentH };
}

// Menus sit on a centred 16:9 canvas, so a barless non-16:9 render needs the
// crop base clamped to it on both axes.
export function canvasContentRect(nativeImage: NativeImage): GameContentRect {
  return centerGameCanvas(detectGameContentRect(nativeImage));
}

function centerGameCanvas(content: GameContentRect): GameContentRect {
  const canvasWidth = Math.min(content.width, Math.round((content.height * 16) / 9));
  const canvasHeight = Math.min(content.height, Math.round((content.width * 9) / 16));
  return {
    x: content.x + Math.floor((content.width - canvasWidth) / 2),
    y: content.y + Math.floor((content.height - canvasHeight) / 2),
    width: canvasWidth,
    height: canvasHeight,
  };
}

/** Clamp a known client-only frame without trying to rediscover black bars. */
export function frameCanvasContentRect(nativeImage: NativeImage): GameContentRect {
  const { width, height } = nativeImage.getSize();
  return centerGameCanvas({ x: 0, y: 0, width, height });
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

// Both readers were calibrated on 1080p title strips upscaled 3x: ~700px wide,
// one text line ~60px tall. A 4K strip is already twice that wide, so a fixed 3x
// quadruples the OCR pixels and pushes the line height past the row splitter's
// limit. Target the calibrated width instead of a fixed factor.
const OCR_STRIP_UPSCALE = 3;
const OCR_STRIP_TARGET_WIDTH = 720;

export function ocrStripTargetWidth(sourceWidth: number): number {
  if (!(sourceWidth > 0)) return 0;
  return Math.max(8, Math.round(Math.min(sourceWidth * OCR_STRIP_UPSCALE, OCR_STRIP_TARGET_WIDTH)));
}

const CONSOLE_BRIGHT_LUM = 140;
const CONSOLE_MAX_SAT = 0.3;
const CONSOLE_BRIGHT_RATIO = 0.55;
// The console bar outshines the frame it covers; a light UI theme does not.
const CONSOLE_MIN_LUM_DELTA = 55;

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

export function cropRewardBand(
  nativeImage: NativeImage,
  band: Band | null | undefined,
): NativeImage {
  const { width, height } = nativeImage.getSize();
  const topRatio = clampNumber(band?.top, 0.0, 0.95, 0.38);
  const maxHeightRatio = Math.max(0.05, 1.0 - topRatio);
  const heightRatio = clampNumber(band?.height, 0.05, maxHeightRatio, 0.36);
  // Band presets were measured on 16:9; map them onto taller frames the same
  // way the slot layouts are (16:9 canvas centred in the frame).
  const { scaleY } = aspectScaleFor(nativeImage);
  const scaledTop = 0.5 + (topRatio - 0.5) * scaleY;
  const top = Math.floor(height * scaledTop);
  const cropHeight = Math.max(24, Math.floor(height * heightRatio * scaleY));
  return nativeImage.crop({ x: 0, y: top, width, height: cropHeight });
}

export function cropBand(nativeImage: NativeImage, band: Band | null | undefined): NativeImage {
  const { width, height } = nativeImage.getSize();
  const topRatio = clampNumber(band?.top, 0.0, 0.95, 0.16);
  const maxHeightRatio = Math.max(0.04, 1.0 - topRatio);
  const heightRatio = clampNumber(band?.height, 0.04, maxHeightRatio, 0.12);
  const { scaleY } = aspectScaleFor(nativeImage);
  const top = Math.floor(height * (0.5 + (topRatio - 0.5) * scaleY));
  const cropHeight = Math.max(18, Math.floor(height * heightRatio * scaleY));
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

// Ratios are relative to the detected 16:9 content area, not the full frame.
// On native 16:9 displays contentRect covers the whole frame, matching cropRect.
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

  // 256-entry LUT (luminance -> output) so the pixel loop is one table lookup.
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

  // Apply LUT: BGRA bitmap -> greyscale via integer luminance approximation.
  for (let i = 0; i < targetBitmap.length; i += 4) {
    // BT.601 luminance: (114*B + 587*G + 299*R) / 1000
    const lum =
      ((targetBitmap[i] * 114 + targetBitmap[i + 1] * 587 + targetBitmap[i + 2] * 299 + 500) /
        1000) |
      0;
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
  /** Count read off the card bars: no other layout applies to this frame. */
  counted?: boolean;
}

const SLOT_LAYOUT_REGION = Object.freeze({ x: 0.03, y: 0.37, width: 0.94, height: 0.34 });

// Measured card ratios assume screenCapture has isolated the game content.
const FIXED_REWARD_LAYOUTS: Readonly<
  Record<number, Array<{ x: number; y: number; width: number; height: number }>>
> = Object.freeze({
  1: [{ x: 0.439, y: 0.225, width: 0.122, height: 0.225 }],
  2: [
    { x: 0.3755, y: 0.225, width: 0.122, height: 0.225 },
    { x: 0.5025, y: 0.225, width: 0.122, height: 0.225 },
  ],
  3: [
    { x: 0.312, y: 0.225, width: 0.122, height: 0.225 },
    { x: 0.439, y: 0.225, width: 0.122, height: 0.225 },
    { x: 0.566, y: 0.225, width: 0.122, height: 0.225 },
  ],
  4: [
    { x: 0.245, y: 0.225, width: 0.122, height: 0.225 },
    { x: 0.372, y: 0.225, width: 0.122, height: 0.225 },
    { x: 0.499, y: 0.225, width: 0.122, height: 0.225 },
    { x: 0.626, y: 0.225, width: 0.122, height: 0.225 },
  ],
});

// Ratios were measured on 16:9, so rescale the off axis about the centre: x on
// wider frames (21:9), y on taller ones (16:10, 4:3).
const REFERENCE_ASPECT = 16 / 9;
const REFERENCE_UI_SCALE = REFERENCE_WARFRAME_UI_SCALE;

interface AspectScale {
  scaleX: number;
  scaleY: number;
}

function aspectScaleFor(nativeImage: NativeImage): AspectScale {
  if (!nativeImage || typeof nativeImage.getSize !== "function") {
    return { scaleX: 1, scaleY: 1 };
  }
  const { width, height } = nativeImage.getSize();
  if (!(width > 0) || !(height > 0)) return { scaleX: 1, scaleY: 1 };
  const referenceWidth = height * REFERENCE_ASPECT;
  const referenceHeight = width / REFERENCE_ASPECT;
  return {
    scaleX: referenceWidth < width ? referenceWidth / width : 1,
    scaleY: referenceHeight < height ? referenceHeight / height : 1,
  };
}

function aspectCorrectRect<T extends { x: number; y: number; width: number; height: number }>(
  rect: T,
  scale: AspectScale,
): { x: number; y: number; width: number; height: number } {
  return {
    x: 0.5 + (rect.x - 0.5) * scale.scaleX,
    y: 0.5 + (rect.y - 0.5) * scale.scaleY,
    width: rect.width * scale.scaleX,
    height: rect.height * scale.scaleY,
  };
}

function aspectCorrectLayout(
  layout: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  scale: AspectScale,
): Array<{ x: number; y: number; width: number; height: number }> {
  if (scale.scaleX >= 1 && scale.scaleY >= 1) return layout.map((slot) => ({ ...slot }));
  return layout.map((slot) => aspectCorrectRect(slot, scale));
}

function uiScaleCorrectLayout(
  layout: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  uiScale: number,
): Array<{ x: number; y: number; width: number; height: number }> {
  const scale = clampNumber(uiScale, 0.5, 1, REFERENCE_UI_SCALE) / REFERENCE_UI_SCALE;
  return layout.map((slot) => ({
    x: 0.5 + (slot.x - 0.5) * scale,
    y: 0.5 + (slot.y - 0.5) * scale,
    width: slot.width * scale,
    height: slot.height * scale,
  }));
}

// The card counter reads the thin bar every reward card draws just under its
// title (y 0.431-0.458 at 1080p): the outermost card of an N-card row only
// exists when N cards are up, so the bar is probed from 4 down to 1 in the
// outer third of that card. Same idea as AlecaFrame's player counter.
const CARD_COUNTER_BAND = Object.freeze({ top: 0.431, height: 0.027 });
const CARD_COUNTER_WINDOW_WIDTH = 0.064;
// Window starts as fractions of the four-card row width (cards + gaps).
const CARD_COUNTER_WINDOWS: ReadonlyArray<[number, ReadonlyArray<number>]> = Object.freeze([
  [4, [0.01, 0.91]],
  [3, [0.15, 0.78]],
  [2, [0.28, 0.665]],
  [1, [0.4, 0.535]],
]);
const CARD_ROW_LEFT = FIXED_REWARD_LAYOUTS[4][0].x;
const CARD_ROW_WIDTH =
  FIXED_REWARD_LAYOUTS[4][3].x + FIXED_REWARD_LAYOUTS[4][3].width - CARD_ROW_LEFT;

function colourDistance(bitmap: Buffer, a: number, b: number): number {
  const db = bitmap[a] - bitmap[b];
  const dg = bitmap[a + 1] - bitmap[b + 1];
  const dr = bitmap[a + 2] - bitmap[b + 2];
  return Math.sqrt(db * db + dg * dg + dr * dr);
}

/** True when the window holds one thin horizontal bar of even colour: the
 *  middle row runs uniform across the window and each column's uniform run
 *  around it is short and of similar height. */
function windowHasCardBar(
  bitmap: Buffer,
  stride: number,
  left: number,
  top: number,
  width: number,
  height: number,
): boolean {
  if (width < 12 || height < 6) return false;
  const mid = top + Math.floor(height / 2);
  const from = left + Math.floor(width / 6);
  const to = left + Math.floor((width * 5) / 6);
  let run = 0;
  for (let x = from + 1; x < to; x++) {
    const here = mid * stride + x * 4;
    if (colourDistance(bitmap, here, here - 4) >= 45) break;
    run++;
  }
  if (run / (width * 0.6) < 0.9) return false;

  const heights: number[] = [];
  for (let x = left; x < left + width; x++) {
    let tall = 0;
    for (let y = mid - 1; y >= top; y--) {
      const here = y * stride + x * 4;
      if (colourDistance(bitmap, here, here + stride) > 32) break;
      tall++;
    }
    for (let y = mid + 1; y < top + height; y++) {
      const here = y * stride + x * 4;
      if (colourDistance(bitmap, here, here - stride) > 32) break;
      tall++;
    }
    heights.push(tall);
  }
  const avg = heights.reduce((sum, h) => sum + h, 0) / heights.length;
  const trimmed = [...heights].sort((a, b) => b - a).slice(3);
  const variance =
    trimmed.reduce((sum, h) => sum + (h - avg) * (h - avg), 0) / Math.max(1, trimmed.length);
  const normAvg = avg / height;
  const normStd = (5 * Math.sqrt(variance)) / height;
  if (heights.filter((h) => h <= 1).length > heights.length / 3) return false;
  return normAvg >= 0.05 && normAvg <= 0.27 && normStd <= 0.36;
}

/** Card count read off the frame's own card bars, 0 when no bar is found.
 *  `bitmap` is BGRA, `stride` bytes per row. */
export function countRewardCardsInBitmap(
  bitmap: Buffer,
  width: number,
  height: number,
  uiScale: number,
  scale: AspectScale,
): number {
  const stride = width * 4;
  if (bitmap.length < stride * height) return 0;
  const [row] = aspectCorrectLayout(
    uiScaleCorrectLayout(
      [
        {
          x: CARD_ROW_LEFT,
          y: CARD_COUNTER_BAND.top,
          width: CARD_ROW_WIDTH,
          height: CARD_COUNTER_BAND.height,
        },
      ],
      uiScale,
    ),
    scale,
  );
  const rowLeft = Math.round(row.x * width);
  const rowWidth = Math.round(row.width * width);
  const top = Math.max(0, Math.round(row.y * height));
  const bandHeight = Math.min(height - top, Math.round(row.height * height));
  const windowWidth = Math.round(rowWidth * CARD_COUNTER_WINDOW_WIDTH);
  for (const [count, starts] of CARD_COUNTER_WINDOWS) {
    for (const start of starts) {
      const left = rowLeft + Math.round(rowWidth * start);
      if (left < 0 || left + windowWidth > width) continue;
      if (windowHasCardBar(bitmap, stride, left, top, windowWidth, bandHeight)) return count;
    }
  }
  return 0;
}

function countRewardCards(nativeImage: NativeImage, uiScale: number): number {
  if (!nativeImage || typeof nativeImage.getSize !== "function") return 0;
  const { width, height } = nativeImage.getSize();
  if (!(width > 0) || !(height > 0)) return 0;
  try {
    return countRewardCardsInBitmap(
      nativeImage.toBitmap(),
      width,
      height,
      uiScale,
      aspectScaleFor(nativeImage),
    );
  } catch {
    return 0;
  }
}

const BAND_SAMPLE_STEP_X = 8;
const BAND_SAMPLE_STEP_Y = 2;

/** One byte per sampled pixel of the whole four-card rect, art included, corrected
 *  like the crops. The void backdrop outside it animates, so a whole-frame sample
 *  never matched between two scans of the same static reward screen. */
export function sampleRewardCardBand(nativeImage: NativeImage, uiScale: number): Buffer | null {
  if (!nativeImage || typeof nativeImage.getSize !== "function") return null;
  const { width, height } = nativeImage.getSize();
  if (!(width > 0) || !(height > 0)) return null;
  const slots = aspectCorrectLayout(
    uiScaleCorrectLayout(FIXED_REWARD_LAYOUTS[4], uiScale),
    aspectScaleFor(nativeImage),
  );
  const left = Math.max(0, Math.floor(Math.min(...slots.map((slot) => slot.x)) * width));
  const right = Math.min(
    width,
    Math.ceil(Math.max(...slots.map((slot) => slot.x + slot.width)) * width),
  );
  const top = Math.max(0, Math.floor(Math.min(...slots.map((slot) => slot.y)) * height));
  const bottom = Math.min(
    height,
    Math.ceil(Math.max(...slots.map((slot) => slot.y + slot.height)) * height),
  );
  const columns = Math.floor((right - left) / BAND_SAMPLE_STEP_X);
  const rows = Math.floor((bottom - top) / BAND_SAMPLE_STEP_Y);
  if (columns < 1 || rows < 1) return null;
  const bitmap: Buffer = nativeImage.toBitmap();
  const rowStride = width * 4;
  if (bitmap.length < rowStride * height) return null;
  const sample = Buffer.alloc(columns * rows);
  let i = 0;
  for (let row = 0; row < rows; row++) {
    const rowOffset = (top + row * BAND_SAMPLE_STEP_Y) * rowStride;
    for (let col = 0; col < columns; col++) {
      // Green channel of BGRA is enough to notice a card appearing or fading in.
      sample[i++] = bitmap[rowOffset + (left + col * BAND_SAMPLE_STEP_X) * 4 + 1];
    }
  }
  return sample;
}

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

function detectFixedRewardSlotLayouts(
  nativeImage: NativeImage,
  uiScale = REFERENCE_UI_SCALE,
): RewardSlotLayout[] {
  const candidates: RewardSlotLayout[] = [];

  const scale = aspectScaleFor(nativeImage);
  for (const [countKey, layout] of Object.entries(FIXED_REWARD_LAYOUTS)) {
    const count = Number(countKey);
    // Sample the same rects the crops use, or a wide frame scores the gaps.
    const scaled = aspectCorrectLayout(uiScaleCorrectLayout(layout, uiScale), scale);
    const activities = scaled.map((slot) => computeSlotActivity(nativeImage, slot));
    const activeCount = activities.filter((score) => score >= 0.22).length;
    const avgScore =
      activities.reduce((sum, score) => sum + score, 0) / Math.max(1, activities.length);
    const confidence = Number(
      (clamp01(activeCount / count) * 0.58 + clamp01(avgScore / 0.7) * 0.42).toFixed(3),
    );
    const slots: RewardSlotRect[] = buildFixedSlots(scaled);

    if (activeCount >= Math.min(2, count) || avgScore >= 0.28) {
      candidates.push({ count, confidence, slots });
    }
  }

  candidates.sort((a, b) => {
    const confidenceDiff = b.confidence - a.confidence;
    if (Math.abs(confidenceDiff) < 0.08) return b.count - a.count;
    return confidenceDiff || b.count - a.count;
  });
  return candidates;
}

export function detectRewardSlotLayoutCandidates(
  nativeImage: NativeImage,
  uiScale = REFERENCE_UI_SCALE,
): RewardSlotLayout[] {
  const counted = countRewardCards(nativeImage, uiScale);
  if (counted > 0) {
    // The bars settle the count, so the activity ranking and every other layout
    // are skipped: one layout, one OCR pass, and a short read is a real miss.
    const slots = buildFixedSlots(
      aspectCorrectLayout(
        uiScaleCorrectLayout(FIXED_REWARD_LAYOUTS[counted], uiScale),
        aspectScaleFor(nativeImage),
      ),
    );
    return [{ count: counted, confidence: 1, slots, counted: true }];
  }
  const fixed = detectFixedRewardSlotLayouts(nativeImage, uiScale);
  // The projection detector returns the fixed winner when there is one, so
  // asking it for that case would sample every card region a second time.
  const primary = fixed.length > 0 ? null : detectRewardSlotLayout(nativeImage);
  const byKey = new Map<string, RewardSlotLayout>();
  for (const layout of [...fixed, primary]) {
    if (!layout || layout.count <= 0) continue;
    const key = `${layout.count}:${layout.slots.map((slot) => slot.x.toFixed(3)).join(",")}`;
    const existing = byKey.get(key);
    if (!existing || layout.confidence > existing.confidence) byKey.set(key, layout);
  }
  return [...byKey.values()].sort((a, b) => {
    const confidenceDiff = b.confidence - a.confidence;
    if (Math.abs(confidenceDiff) < 0.08) return b.count - a.count;
    return confidenceDiff || b.count - a.count;
  });
}

// Only reached when no fixed layout scored, so it goes straight to the
// column-projection fallback.
function detectRewardSlotLayout(nativeImage: NativeImage): RewardSlotLayout {
  if (!nativeImage || typeof nativeImage.getSize !== "function") {
    return { count: 0, confidence: 0, slots: [] };
  }

  const layoutRegion = aspectCorrectRect(SLOT_LAYOUT_REGION, aspectScaleFor(nativeImage));
  let region: NativeImage;
  try {
    region = cropRect(nativeImage, layoutRegion);
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
    const xRatio = layoutRegion.x + (run.start / width) * layoutRegion.width;
    const widthRatio = (runWidth / width) * layoutRegion.width;
    const yRatio = layoutRegion.y;
    const heightRatio = layoutRegion.height;

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

/** Mean luminance of a region, sampled on a stride. */
function meanLuminance(
  bitmap: Buffer,
  width: number,
  height: number,
  stepX: number,
  stepY: number,
): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const idx = (y * width + x) * 4;
      sum += luminanceFromBgr(bitmap[idx], bitmap[idx + 1], bitmap[idx + 2]);
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

// A light Warframe UI theme makes the bottom strip permanently bright, so an open
// console has to stand out from the frame behind it rather than just be bright.
export function detectConsoleOpen(nativeImage: NativeImage): boolean {
  if (!nativeImage || typeof nativeImage.getSize !== "function") return false;

  const { width, height } = nativeImage.getSize();
  if (width < 120 || height < 120) return false;

  const stripTop = Math.floor(height * 0.96);
  const stripHeight = height - stripTop;
  if (stripHeight < 4) return false;

  let strip: NativeImage;
  let backdrop: NativeImage;
  try {
    strip = nativeImage.crop({ x: 0, y: stripTop, width, height: stripHeight });
    backdrop = nativeImage.crop({ x: 0, y: 0, width, height: stripTop });
  } catch {
    return false;
  }

  const bitmap: Buffer = strip.toBitmap();
  const stepX = Math.max(1, Math.floor(width / 200));
  const stepY = Math.max(1, Math.floor(stripHeight / 8));

  let bright = 0;
  let total = 0;
  let stripLumSum = 0;

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
      if (lum >= CONSOLE_BRIGHT_LUM && sat <= CONSOLE_MAX_SAT) bright += 1;
      stripLumSum += lum;
      total += 1;
    }
  }

  if (total === 0 || bright / total < CONSOLE_BRIGHT_RATIO) return false;

  const backdropLum = meanLuminance(
    backdrop.toBitmap(),
    width,
    stripTop,
    stepX,
    Math.max(1, Math.floor(stripTop / 24)),
  );
  return stripLumSum / total - backdropLum >= CONSOLE_MIN_LUM_DELTA;
}

// Otsu threshold: adapts to the crop's brightness instead of a fixed cutoff.
export function otsuThreshold(gray: Buffer | Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]] += 1;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let maxBetween = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxBetween) {
      maxBetween = between;
      threshold = t;
    }
  }
  return threshold;
}

export async function binarizeRewardRegion(
  pngBuffer: Buffer,
  topFrac: number,
  heightFrac: number,
): Promise<Buffer | null> {
  try {
    const sharp: (typeof import("sharp"))["default"] = require("sharp");
    const meta = await sharp(pngBuffer).metadata();
    const srcW = meta.width ?? 0;
    const srcH = meta.height ?? 0;
    if (srcW < 8 || srcH < 8) return null;
    const top = Math.max(0, Math.min(srcH - 1, Math.round(srcH * topFrac)));
    const height = Math.max(1, Math.min(srcH - top, Math.round(srcH * heightFrac)));
    // Threshold materialized normalized gray; libvips otherwise reorders these operations.
    // Remove alpha bytes from the Otsu histogram.
    const { data, info } = await sharp(pngBuffer)
      .extract({ left: 0, top, width: srcW, height })
      .resize({ width: ocrStripTargetWidth(srcW), kernel: "lanczos3" })
      .grayscale()
      .removeAlpha()
      .normalise()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const threshold = otsuThreshold(data);
    // Whichever class covers more of the crop is the background, so a light UI
    // theme (dark text on a pale card) comes out the same way up as the default.
    let brightCount = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] >= threshold) brightCount += 1;
    }
    const brightIsBackground = brightCount * 2 > data.length;
    const mono = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
      const isBright = data[i] >= threshold;
      // Always emit dark text on white, whichever way round the source was.
      mono[i] = isBright === brightIsBackground ? 255 : 0;
    }
    return await sharp(mono, {
      raw: { width: info.width, height: info.height, channels: 1 },
    })
      .png()
      .toBuffer();
  } catch (err) {
    log.warn("[RewardScanner] binarizeRewardRegion failed:", normalizeErrorMessage(err));
    return null;
  }
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
