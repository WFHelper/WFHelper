"use strict";

import { captureScreenFast } from "../../services/rewardScannerCapture";
import { cropRectContent, detectGameContentRect } from "../../services/rewardScannerImage";
import { clamp01, computeMeanAndStd, sleep } from "../../services/rewardScannerUtils";

interface TextBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface RivenDerivedRegions {
  title: TextBounds;
  stats: TextBounds;
  footer: TextBounds;
}

interface RivenTextMetrics {
  score: number;
  coverage: number;
  activeRows: number;
  activeCols: number;
  rowGroups: number;
  bounds: TextBounds | null;
}

export interface OriginalMode {
  kind: "original";
}

export interface FilteredMode {
  kind: "bright";
  threshold: number;
  dilate?: boolean;
}

export interface VioletMode {
  kind: "violet";
  dilate?: boolean;
}

/**
 * Hybrid mode: uses violet filter to locate text rows, then applies brightness
 * threshold within those rows to capture ALL text — including element icons
 * (Heat🔥, Electricity⚡, Cold❄) that the pure violet filter strips.  This
 * preserves value-name association across icon gaps.
 */
export interface VioletGuidedBrightMode {
  kind: "violet-guided-bright";
  brightThreshold?: number; // default 140
}

export type EnhanceMode = OriginalMode | FilteredMode | VioletMode | VioletGuidedBrightMode;

/** Row region detected during VGB preprocessing — (y0, y1, x0, x1) bounds. */
export interface VgbRowRegion {
  y0: number;
  y1: number;
  x0: number;
  x1: number;
}

/** VGB processing result with both the image and row regions (matches Python vgb_process). */
export interface VgbResult {
  png: Buffer;
  rowRegions: VgbRowRegion[];
  width: number;
  height: number;
}

export interface RivenUiReadyResult {
  ready: boolean;
  attempts: number;
  elapsedMs: number;
  bestScore: number;
  screenshot: any | null;
  frameHash: string;
}

const RIVEN_READY_TIMEOUTS_MS = Object.freeze({
  initial: 1800,
  // Roll and choice gates removed — AlecaFrame uses fixed delays (2750 ms / 1200 ms)
  // with immediate capture, no visual readiness polling.  These remain for type
  // compatibility but are no longer called from production code paths.
  roll: 500,
  choice: 1800,
});
// With DXGI capture at ~10 ms/frame (non-blocking AcquireNextFrame), each poll
// cycle is ~10 ms capture + ~5 ms analysis + 40 ms sleep ≈ 55 ms.  Reducing
// from 140 ms allows 3× more samples in the same window, so we increase
// REQUIRED_HITS from 2 → 3 for better stability confidence at no latency cost:
//   old: 2 hits × 140 ms = 280 ms minimum detection
//   new: 3 hits × 40 ms  = 120 ms minimum detection  (~2.3× faster + more accurate)
const RIVEN_READY_POLL_MS = 40;
const RIVEN_READY_REQUIRED_HITS = 3;
const RIVEN_READY_SCORE_THRESHOLD = 0.2;
const MIN_OCR_WIDTH = 1800;

let _rivenScanAborted = false;

export function abortRivenScanWaits(): void {
  _rivenScanAborted = true;
}

export function resetRivenScanWaits(): void {
  _rivenScanAborted = false;
}

function smoothSeries(values: number[]): number[] {
  if (values.length <= 2) return values.slice();
  return values.map((value, index) => {
    const prev = index > 0 ? values[index - 1] : value;
    const next = index < values.length - 1 ? values[index + 1] : value;
    return (prev + value + next) / 3;
  });
}

function countGroups(values: number[], threshold: number, minRun: number): number {
  let groups = 0;
  let run = 0;
  for (const value of values) {
    if (value >= threshold) {
      run += 1;
      continue;
    }
    if (run >= minRun) groups += 1;
    run = 0;
  }
  if (run >= minRun) groups += 1;
  return groups;
}

function findBounds(values: number[], threshold: number): { start: number; end: number } | null {
  let start = -1;
  let end = -1;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] >= threshold) {
      start = index;
      break;
    }
  }
  if (start < 0) return null;

  for (let index = values.length - 1; index >= start; index -= 1) {
    if (values[index] >= threshold) {
      end = index;
      break;
    }
  }
  if (end < start) return null;
  return { start, end };
}

/** Extract BGRA bitmap once; reuse across analyzeRivenTextMetrics / detectRivenCardFrame / computeRivenFrameHash. */
export function getRivenBitmap(nativeImage: any): { bitmap: Buffer; width: number; height: number } | null {
  if (!nativeImage || typeof nativeImage.getSize !== "function") return null;
  const { width, height } = nativeImage.getSize();
  if (width < 24 || height < 24) return null;
  return { bitmap: nativeImage.toBitmap(), width, height };
}

function analyzeRivenTextMetrics(nativeImage: any, shared?: { bitmap: Buffer; width: number; height: number } | null): RivenTextMetrics {
  const data = shared || getRivenBitmap(nativeImage);
  if (!data) {
    return {
      score: 0,
      coverage: 0,
      activeRows: 0,
      activeCols: 0,
      rowGroups: 0,
      bounds: null,
    };
  }

  const { width, height, bitmap } = data;
  const sampleCols = Math.max(48, Math.min(width, 320));
  const sampleRows = Math.max(32, Math.min(height, 160));
  const stepX = Math.max(1, Math.floor(width / sampleCols));
  const stepY = Math.max(1, Math.floor(height / sampleRows));
  const rowScores = new Array<number>(sampleRows).fill(0);
  const colScores = new Array<number>(sampleCols).fill(0);
  let activePixels = 0;

  for (let sampleY = 0; sampleY < sampleRows; sampleY += 1) {
    const y = Math.min(height - 1, sampleY * stepY);
    for (let sampleX = 0; sampleX < sampleCols; sampleX += 1) {
      const x = Math.min(width - 1, sampleX * stepX);
      const idx = (y * width + x) * 4;
      const blue = bitmap[idx];
      const green = bitmap[idx + 1];
      const red = bitmap[idx + 2];
      const maxC = Math.max(red, green, blue);
      const minC = Math.min(red, green, blue);
      const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
      const isTextLike = maxC >= 146 && sat <= 0.42;
      if (!isTextLike) continue;
      activePixels += 1;
      rowScores[sampleY] += 1;
      colScores[sampleX] += 1;
    }
  }

  const smoothedRows = smoothSeries(rowScores);
  const smoothedCols = smoothSeries(colScores);
  const rowStats = computeMeanAndStd(smoothedRows);
  const colStats = computeMeanAndStd(smoothedCols);
  const rowThreshold = Math.max(2, rowStats.mean + rowStats.std * 0.45);
  const colThreshold = Math.max(2, colStats.mean + colStats.std * 0.45);

  const rowBounds = findBounds(smoothedRows, rowThreshold);
  const colBounds = findBounds(smoothedCols, colThreshold);
  const activeRows = smoothedRows.filter((value) => value >= rowThreshold).length;
  const activeCols = smoothedCols.filter((value) => value >= colThreshold).length;
  const rowGroups = countGroups(
    smoothedRows,
    rowThreshold,
    Math.max(2, Math.floor(sampleRows * 0.03)),
  );
  const coverage = activePixels / Math.max(1, sampleCols * sampleRows);

  let bounds: TextBounds | null = null;
  if (rowBounds && colBounds) {
    const padX = Math.max(2, Math.floor(sampleCols * 0.04));
    const padY = Math.max(2, Math.floor(sampleRows * 0.03));
    const left = Math.max(0, (colBounds.start - padX) * stepX);
    const top = Math.max(0, (rowBounds.start - padY) * stepY);
    const right = Math.min(width - 1, (colBounds.end + padX + 1) * stepX);
    const bottom = Math.min(height - 1, (rowBounds.end + padY + 1) * stepY);
    const boundWidth = right - left + 1;
    const boundHeight = bottom - top + 1;
    if (
      boundWidth >= Math.max(24, Math.floor(width * 0.2)) &&
      boundHeight >= Math.max(24, Math.floor(height * 0.12))
    ) {
      bounds = {
        left,
        top,
        width: boundWidth,
        height: boundHeight,
      };
    }
  }

  const coverageScore = clamp01(coverage / 0.08);
  const rowScore = clamp01(activeRows / Math.max(8, sampleRows * 0.16));
  const colScore = clamp01(activeCols / Math.max(24, sampleCols * 0.2));
  const groupScore = clamp01(rowGroups / 3);
  const score = Number(
    (coverageScore * 0.28 + rowScore * 0.24 + colScore * 0.24 + groupScore * 0.24).toFixed(3),
  );

  return {
    score,
    coverage: Number(coverage.toFixed(4)),
    activeRows,
    activeCols,
    rowGroups,
    bounds,
  };
}

export function computeRivenFrameHash(nativeImage: any, shared?: { bitmap: Buffer; width: number; height: number } | null): string {
  const data = shared || getRivenBitmap(nativeImage);
  if (!data) return "";
  const { width, height, bitmap } = data;
  const sampleCols = Math.max(12, Math.min(width, 24));
  const sampleRows = Math.max(8, Math.min(height, 16));
  const stepX = Math.max(1, Math.floor(width / sampleCols));
  const stepY = Math.max(1, Math.floor(height / sampleRows));
  let hash = "";

  for (let sampleY = 0; sampleY < sampleRows; sampleY += 1) {
    for (let sampleX = 0; sampleX < sampleCols; sampleX += 1) {
      const x = Math.min(width - 1, sampleX * stepX);
      const y = Math.min(height - 1, sampleY * stepY);
      const idx = (y * width + x) * 4;
      const bucket = Math.round((bitmap[idx] + bitmap[idx + 1] + bitmap[idx + 2]) / 32);
      hash += bucket.toString(16);
    }
  }

  return hash;
}

function findPeakIndex(values: number[], start: number, end: number): number {
  let bestIndex = -1;
  let bestValue = -Infinity;
  for (let index = start; index <= end && index < values.length; index += 1) {
    if (index < 0) continue;
    if (values[index] > bestValue) {
      bestValue = values[index];
      bestIndex = index;
    }
  }
  return bestIndex;
}

function detectRivenCardFrame(nativeImage: any, shared?: { bitmap: Buffer; width: number; height: number } | null): TextBounds | null {
  const data = shared || getRivenBitmap(nativeImage);
  if (!data) return null;
  const { width, height, bitmap } = data;
  if (width < 160 || height < 120) return null;
  const sampleCols = Math.max(80, Math.min(width, 220));
  const sampleRows = Math.max(70, Math.min(height, 180));
  const stepX = Math.max(1, Math.floor(width / sampleCols));
  const stepY = Math.max(1, Math.floor(height / sampleRows));
  const lumaGrid: number[][] = Array.from({ length: sampleRows }, () =>
    new Array<number>(sampleCols).fill(0),
  );
  const borderColScore = new Array<number>(sampleCols).fill(0);
  const borderRowScore = new Array<number>(sampleRows).fill(0);

  for (let sampleY = 0; sampleY < sampleRows; sampleY += 1) {
    const y = Math.min(height - 1, sampleY * stepY);
    for (let sampleX = 0; sampleX < sampleCols; sampleX += 1) {
      const x = Math.min(width - 1, sampleX * stepX);
      const idx = (y * width + x) * 4;
      const blue = bitmap[idx];
      const green = bitmap[idx + 1];
      const red = bitmap[idx + 2];
      lumaGrid[sampleY][sampleX] = (blue + green + red) / 3;

      const isGolden = red > 180 && green > 140 && blue < 120 && red - blue > 80;
      const isBlueCyan = blue > 160 && green > 120 && red < 100 && blue - red > 80;
      if (isGolden || isBlueCyan) {
        borderColScore[sampleX] += 1;
        borderRowScore[sampleY] += 1;
      }
    }
  }

  const colEdges = new Array<number>(sampleCols).fill(0);
  const rowEdges = new Array<number>(sampleRows).fill(0);
  for (let sampleY = 1; sampleY < sampleRows - 1; sampleY += 1) {
    for (let sampleX = 1; sampleX < sampleCols - 1; sampleX += 1) {
      const gx =
        -lumaGrid[sampleY - 1][sampleX - 1] + lumaGrid[sampleY - 1][sampleX + 1] +
        -2 * lumaGrid[sampleY][sampleX - 1] + 2 * lumaGrid[sampleY][sampleX + 1] +
        -lumaGrid[sampleY + 1][sampleX - 1] + lumaGrid[sampleY + 1][sampleX + 1];
      const gy =
        -lumaGrid[sampleY - 1][sampleX - 1] -
        2 * lumaGrid[sampleY - 1][sampleX] -
        lumaGrid[sampleY - 1][sampleX + 1] +
        lumaGrid[sampleY + 1][sampleX - 1] +
        2 * lumaGrid[sampleY + 1][sampleX] +
        lumaGrid[sampleY + 1][sampleX + 1];
      colEdges[sampleX] += Math.abs(gx);
      rowEdges[sampleY] += Math.abs(gy);
    }
  }

  const combinedCols = colEdges.map((edge, index) => edge + borderColScore[index] * 12);
  const combinedRows = rowEdges.map((edge, index) => edge + borderRowScore[index] * 12);
  const smoothCols = smoothSeries(combinedCols);
  const smoothRows = smoothSeries(combinedRows);
  const leftPeak = findPeakIndex(
    smoothCols,
    Math.floor(sampleCols * 0.08),
    Math.floor(sampleCols * 0.42),
  );
  const rightPeak = findPeakIndex(
    smoothCols,
    Math.floor(sampleCols * 0.58),
    Math.floor(sampleCols * 0.94),
  );
  const topPeak = findPeakIndex(
    smoothRows,
    Math.floor(sampleRows * 0.02),
    Math.floor(sampleRows * 0.3),
  );
  const bottomPeak = findPeakIndex(
    smoothRows,
    Math.floor(sampleRows * 0.68),
    Math.floor(sampleRows * 0.98),
  );
  if (leftPeak < 0 || rightPeak < 0 || topPeak < 0 || bottomPeak < 0 || rightPeak <= leftPeak) {
    return null;
  }

  const frame = {
    left: Math.max(0, leftPeak * stepX),
    top: Math.max(0, topPeak * stepY),
    width: Math.max(1, (rightPeak - leftPeak) * stepX),
    height: Math.max(1, (bottomPeak - topPeak) * stepY),
  };
  if (frame.width < width * 0.28 || frame.height < height * 0.35) return null;
  return frame;
}

export function cropAbsolute(nativeImage: any, bounds: TextBounds): any {
  return nativeImage.crop({
    x: Math.max(0, Math.floor(bounds.left)),
    y: Math.max(0, Math.floor(bounds.top)),
    width: Math.max(1, Math.floor(bounds.width)),
    height: Math.max(1, Math.floor(bounds.height)),
  });
}

function makeBoundsWithinImage(nativeImage: any, bounds: TextBounds): TextBounds {
  const size = nativeImage.getSize?.() ?? { width: 0, height: 0 };
  const left = Math.max(0, Math.floor(bounds.left));
  const top = Math.max(0, Math.floor(bounds.top));
  const right = Math.min(size.width - 1, Math.floor(bounds.left + bounds.width));
  const bottom = Math.min(size.height - 1, Math.floor(bounds.top + bounds.height));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

export function deriveRivenRegions(nativeImage: any, textBounds: TextBounds): RivenDerivedRegions {
  const title = makeBoundsWithinImage(nativeImage, {
    left: textBounds.left - textBounds.width * 0.06,
    top: textBounds.top - textBounds.height * 0.62,
    width: textBounds.width * 1.12,
    height: textBounds.height * 0.34,
  });
  const stats = makeBoundsWithinImage(nativeImage, {
    left: textBounds.left - textBounds.width * 0.04,
    top: textBounds.top - textBounds.height * 0.02,
    width: textBounds.width * 1.08,
    height: textBounds.height * 0.84,
  });
  const footer = makeBoundsWithinImage(nativeImage, {
    left: textBounds.left - textBounds.width * 0.04,
    top: textBounds.top + textBounds.height * 0.8,
    width: textBounds.width * 1.08,
    height: textBounds.height * 0.24,
  });
  return { title, stats, footer };
}

export function refineRivenTextCrop(nativeImage: any): {
  image: any;
  metrics: RivenTextMetrics;
  refined: boolean;
} {
  const shared = getRivenBitmap(nativeImage);
  const metrics = analyzeRivenTextMetrics(nativeImage, shared);
  const cardFrame = detectRivenCardFrame(nativeImage, shared);
  let targetBounds = metrics.bounds;

  if (cardFrame) {
    targetBounds = makeBoundsWithinImage(nativeImage, {
      left: cardFrame.left + cardFrame.width * 0.08,
      top: cardFrame.top + cardFrame.height * 0.34,
      width: cardFrame.width * 0.84,
      height: cardFrame.height * 0.5,
    });
  }

  if (!targetBounds || metrics.score < 0.12) {
    return { image: nativeImage, metrics, refined: false };
  }

  try {
    return {
      image: cropAbsolute(nativeImage, targetBounds),
      metrics,
      refined: true,
    };
  } catch {
    return { image: nativeImage, metrics, refined: false };
  }
}

export async function waitForRivenUiReady(
  rect: { x: number; y: number; width: number; height: number },
  mode: keyof typeof RIVEN_READY_TIMEOUTS_MS,
  preferredDisplayId: string | null = null,
): Promise<RivenUiReadyResult> {
  const timeoutMs = RIVEN_READY_TIMEOUTS_MS[mode];
  const startedAt = Date.now();
  let attempts = 0;
  let consecutiveHits = 0;
  let bestScore = 0;
  let bestScreenshot: any | null = null;
  let bestFrameHash = "";
  let lastMetrics: RivenTextMetrics | null = null;
  let lastFrameHash = "";
  let lastScreenshot: any | null = null;
  let cachedContentRect: ReturnType<typeof detectGameContentRect> | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (_rivenScanAborted) break;
    attempts += 1;

    const screenshot = await captureScreenFast(preferredDisplayId);
    if (!screenshot?.image) {
      consecutiveHits = 0;
      await sleep(RIVEN_READY_POLL_MS);
      continue;
    }
    lastScreenshot = screenshot;

    let roughCrop: any;
    try {
      if (!cachedContentRect) {
        cachedContentRect = detectGameContentRect(screenshot.image);
      }
      roughCrop = cropRectContent(screenshot.image, rect, cachedContentRect);
    } catch {
      consecutiveHits = 0;
      await sleep(RIVEN_READY_POLL_MS);
      continue;
    }

    const shared = getRivenBitmap(roughCrop);
    const metrics = analyzeRivenTextMetrics(roughCrop, shared);
    const frameHash = computeRivenFrameHash(roughCrop, shared);
    if (metrics.score > bestScore) {
      bestScore = metrics.score;
      bestScreenshot = screenshot;
      bestFrameHash = frameHash;
    }

    let stable = metrics.score >= RIVEN_READY_SCORE_THRESHOLD;
    if (stable && lastMetrics?.bounds && metrics.bounds) {
      const coverageDelta = Math.abs(metrics.coverage - lastMetrics.coverage);
      const leftDelta =
        Math.abs(metrics.bounds.left - lastMetrics.bounds.left) /
        Math.max(1, roughCrop.getSize().width);
      const topDelta =
        Math.abs(metrics.bounds.top - lastMetrics.bounds.top) /
        Math.max(1, roughCrop.getSize().height);
      const widthDelta =
        Math.abs(metrics.bounds.width - lastMetrics.bounds.width) /
        Math.max(1, roughCrop.getSize().width);
      const heightDelta =
        Math.abs(metrics.bounds.height - lastMetrics.bounds.height) /
        Math.max(1, roughCrop.getSize().height);
      stable =
        (coverageDelta <= 0.025 || metrics.coverage > 0.25) &&
        leftDelta <= 0.05 &&
        topDelta <= 0.05 &&
        widthDelta <= 0.08 &&
        heightDelta <= 0.08;
    }

    consecutiveHits = stable ? consecutiveHits + 1 : 0;
    lastMetrics = metrics;
    lastFrameHash = frameHash;

    if (consecutiveHits >= RIVEN_READY_REQUIRED_HITS) {
      return {
        ready: true,
        attempts,
        elapsedMs: Date.now() - startedAt,
        bestScore,
        screenshot,
        frameHash,
      };
    }

    await sleep(RIVEN_READY_POLL_MS);
  }

  return {
    ready: false,
    attempts,
    elapsedMs: Date.now() - startedAt,
    bestScore,
    screenshot: lastScreenshot ?? bestScreenshot,
    frameHash: lastFrameHash || bestFrameHash,
  };
}

/**
 * Check if an RGB pixel falls within the violet/purple hue range typical of
 * Warframe riven mod text.  Uses inline RGB→HSV conversion to avoid external
 * dependencies.
 *
 * Sampled from real riven cards:
 *   stat text   RGB ~(176, 135, 213)  → H≈272°  S≈0.37  V≈0.84
 *   weapon name RGB ~(183, 144, 204)  → H≈279°  S≈0.29  V≈0.80
 *   MR / footer RGB ~(139, 118, 173)  → H≈263°  S≈0.32  V≈0.68
 *
 * Filter range (in 0-360° hue):  H ∈ [230, 330],  S ≥ 0.06,  V ≥ 0.27
 * This deliberately wide range catches all text brightness levels while
 * excluding the warm-toned Kuva animation noise (reds, oranges, golds).
 */
function isVioletPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  // Value check (V ≥ ~70/255 ≈ 0.27)
  if (max < 70) return false;

  // Saturation check (S ≥ ~15/255 ≈ 0.06)
  if (max === 0 || delta / max < 0.06) return false;

  // Hue calculation (0-360°)
  let hue: number;
  if (max === r) {
    hue = 60 * (((g - b) / delta) % 6);
  } else if (max === g) {
    hue = 60 * ((b - r) / delta + 2);
  } else {
    hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;

  // Purple/violet range: 230° – 330°
  return hue >= 230 && hue <= 330;
}

/**
 * Detect element-colored riven text pixels (Cyan/Cold, Green/Toxin).
 *
 * Riven stats with elemental damage use colored text that falls outside the
 * violet hue range.  Without detecting these, the VGB row-detection pass
 * misses entire stat lines (e.g. Electricity, Cold, Toxin).
 *
 * Ranges (0-360° hue, matching OpenCV HSV × 2):
 *   Cyan/Cold:  H ∈ [150, 200],  S ≥ 0.10,  V ≥ 0.55
 *   Toxin/Green: H ∈ [60, 110],  S ≥ 0.18,  V ≥ 0.35
 */
function isElementColorPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);

  if (max < 70) return false; // too dark
  if (max === 0 || delta === 0) return false;

  const sat = delta / max;

  let hue: number;
  if (max === r) {
    hue = 60 * (((g - b) / delta) % 6);
  } else if (max === g) {
    hue = 60 * ((b - r) / delta + 2);
  } else {
    hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;

  // Cyan/Cold: H ∈ [150, 200], S ≥ 0.10, V ≥ 140/255 ≈ 0.55
  if (hue >= 150 && hue <= 200 && sat >= 0.10 && max >= 140) return true;

  // Toxin/Green: H ∈ [60, 110], S ≥ 0.18, V ≥ 90/255 ≈ 0.35
  if (hue >= 60 && hue <= 110 && sat >= 0.18 && max >= 90) return true;

  return false;
}

/**
 * In-place morphological close with a 3×3 cross structuring element.
 * Matches Python cv2.morphologyEx(mask, MORPH_CLOSE, cross_kernel).
 * Close = dilate then erode.  Fills 1-2px gaps in binary masks.
 */
function _morphCloseCross(mask: Buffer, w: number, h: number): void {
  const n = w * h;
  // Dilate (4-connected cross)
  const dilated = Buffer.alloc(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) {
        dilated[i] = 1;
        if (x > 0) dilated[i - 1] = 1;
        if (x < w - 1) dilated[i + 1] = 1;
        if (y > 0) dilated[i - w] = 1;
        if (y < h - 1) dilated[i + w] = 1;
      }
    }
  }
  // Erode: pixel survives only if all 4-connected neighbors are set in dilated
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dilated[i]) {
        const hasAll =
          (x === 0 || dilated[i - 1]) &&
          (x === w - 1 || dilated[i + 1]) &&
          (y === 0 || dilated[i - w]) &&
          (y === h - 1 || dilated[i + w]);
        mask[i] = hasAll ? 1 : 0;
      } else {
        mask[i] = 0;
      }
    }
  }
}

/**
 * VGB processing that returns both the PNG and row regions — matches Python
 * vgb_process() returning (inverted_image, row_regions).
 *
 * Row regions carry the precise (y0, y1, x0, x1) bounds from the color mask,
 * so downstream line extraction doesn't have to re-detect rows from the VGB
 * output (which loses information and can miss faint lines).
 */
export async function enhanceForRivenOcrVgb(
  croppedImage: any,
  brightThreshold = 140,
): Promise<VgbResult> {
  const sharp = require("sharp") as typeof import("sharp");
  const { width, height } = croppedImage.getSize();

  const vgbScale = width >= MIN_OCR_WIDTH ? 1 : Math.ceil(MIN_OCR_WIDTH / width);
  const vgbWidth = Math.min(6000, width * vgbScale);
  const vgbHeight = Math.min(6000, height * vgbScale);
  const vgbPng: Buffer = croppedImage.toPNG();
  const vgbRaw = await sharp(vgbPng)
    .resize(vgbWidth, vgbHeight, { kernel: "linear" })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const vgbPixels = vgbWidth * vgbHeight;
  const minRowH = Math.max(6, Math.floor(vgbHeight / 40));

  // Pass 1: combined color mask (violet + element colors) for row detection
  const violetMask = Buffer.alloc(vgbPixels);
  const colorMask = Buffer.alloc(vgbPixels);
  for (let bi = 0, pi = 0; bi < vgbRaw.length; bi += 4, pi++) {
    const r = vgbRaw[bi], g = vgbRaw[bi + 1], b = vgbRaw[bi + 2];
    const isViolet = isVioletPixel(r, g, b);
    violetMask[pi] = isViolet ? 1 : 0;
    colorMask[pi] = (isViolet || isElementColorPixel(r, g, b)) ? 1 : 0;
  }

  // Morphological close (3×3 cross) on both masks — matches Python
  _morphCloseCross(colorMask, vgbWidth, vgbHeight);
  _morphCloseCross(violetMask, vgbWidth, vgbHeight);

  // Row density projection from COMBINED color mask
  const rowDensity = new Array<number>(vgbHeight).fill(0);
  for (let y = 0; y < vgbHeight; y++) {
    for (let x = 0; x < vgbWidth; x++) {
      if (colorMask[y * vgbWidth + x]) rowDensity[y] += 1;
    }
  }
  const rowThreshold = Math.max(5, rowDensity.reduce((a, b) => a + b, 0) / vgbHeight * 0.3);

  // Primary row detection from combined color density
  const textRowsCombined: Array<{ yStart: number; yEnd: number }> = [];
  let inRow = false;
  let rowStart = 0;
  for (let y = 0; y < vgbHeight; y++) {
    if (rowDensity[y] >= rowThreshold) {
      if (!inRow) { rowStart = y; inRow = true; }
    } else if (inRow) {
      if (y - rowStart >= minRowH) textRowsCombined.push({ yStart: rowStart, yEnd: y });
      inRow = false;
    }
  }
  if (inRow && vgbHeight - rowStart >= minRowH) {
    textRowsCombined.push({ yStart: rowStart, yEnd: vgbHeight });
  }

  // Secondary violet-only row detection for de-merging
  const violetRowDensity = new Array<number>(vgbHeight).fill(0);
  for (let y = 0; y < vgbHeight; y++) {
    for (let x = 0; x < vgbWidth; x++) {
      if (violetMask[y * vgbWidth + x]) violetRowDensity[y] += 1;
    }
  }
  const violetRowThreshold = Math.max(5, violetRowDensity.reduce((a, b) => a + b, 0) / vgbHeight * 0.3);
  const textRowsViolet: Array<{ yStart: number; yEnd: number }> = [];
  inRow = false;
  rowStart = 0;
  for (let y = 0; y < vgbHeight; y++) {
    if (violetRowDensity[y] >= violetRowThreshold) {
      if (!inRow) { rowStart = y; inRow = true; }
    } else if (inRow) {
      if (y - rowStart >= minRowH) textRowsViolet.push({ yStart: rowStart, yEnd: y });
      inRow = false;
    }
  }
  if (inRow && vgbHeight - rowStart >= minRowH) {
    textRowsViolet.push({ yStart: rowStart, yEnd: vgbHeight });
  }

  // Hybrid merge: use combined rows, but split any that violet subdivides
  const textRows: Array<{ yStart: number; yEnd: number }> = [];
  for (const cRow of textRowsCombined) {
    const subRows = textRowsViolet.filter(
      (v) => v.yStart >= cRow.yStart - 5 && v.yEnd <= cRow.yEnd + 5,
    );
    if (subRows.length > 1) {
      textRows.push(...subRows);
    } else {
      textRows.push(cRow);
    }
  }

  // Supplementary low-threshold pass for short stat lines (e.g. "+2,1 Range")
  if (textRows.length >= 2) {
    const SUPP_THRESH = 35;
    const sortedRows = [...textRows].sort((a, b) => a.yStart - b.yStart);
    const lastRowEnd = sortedRows[sortedRows.length - 1].yEnd;
    const gapEnd = Math.min(vgbHeight, lastRowEnd + Math.floor(vgbHeight * 0.15));
    if (gapEnd - lastRowEnd >= minRowH) {
      let suppInRow = false;
      let suppStart = 0;
      for (let y = lastRowEnd; y < gapEnd; y++) {
        if (rowDensity[y] >= SUPP_THRESH) {
          if (!suppInRow) { suppStart = y; suppInRow = true; }
        } else if (suppInRow) {
          if (y - suppStart >= minRowH) {
            let active = 0;
            for (let x = 0; x < vgbWidth; x++) {
              let hasColor = false;
              for (let ry = suppStart; ry < y; ry++) {
                if (colorMask[ry * vgbWidth + x]) { hasColor = true; break; }
              }
              if (hasColor) active++;
            }
            if (active > vgbWidth * 0.10) {
              textRows.push({ yStart: suppStart, yEnd: y });
            }
          }
          suppInRow = false;
        }
      }
      if (suppInRow) {
        const y = gapEnd;
        if (y - suppStart >= minRowH) {
          let active = 0;
          for (let x = 0; x < vgbWidth; x++) {
            let hasColor = false;
            for (let ry = suppStart; ry < y; ry++) {
              if (colorMask[ry * vgbWidth + x]) { hasColor = true; break; }
            }
            if (hasColor) active++;
          }
          if (active > vgbWidth * 0.10) {
            textRows.push({ yStart: suppStart, yEnd: y });
          }
        }
      }
      textRows.sort((a, b) => a.yStart - b.yStart);
    }
  }

  // Pass 2: bright mask within text rows, collecting row regions
  const vgbOutput = Buffer.alloc(vgbPixels);
  const padY = 4;
  const rowRegions: VgbRowRegion[] = [];
  for (const row of textRows) {
    // Find horizontal extent from combined color mask (with 2% padding)
    let xMin = vgbWidth;
    let xMax = 0;
    for (let y = row.yStart; y < row.yEnd; y++) {
      for (let x = 0; x < vgbWidth; x++) {
        if (colorMask[y * vgbWidth + x]) {
          if (x < xMin) xMin = x;
          if (x > xMax) xMax = x;
        }
      }
    }
    if (xMax <= xMin) continue;

    const xPad = Math.floor(vgbWidth * 0.02);
    xMin = Math.max(0, xMin - xPad);
    xMax = Math.min(vgbWidth - 1, xMax + xPad);

    const y0 = Math.max(0, row.yStart - padY);
    const y1 = Math.min(vgbHeight, row.yEnd + padY);

    // Copy bright pixels within this row region
    for (let y = y0; y < y1; y++) {
      for (let x = xMin; x <= xMax; x++) {
        const bi = (y * vgbWidth + x) * 4;
        const maxCh = Math.max(vgbRaw[bi], vgbRaw[bi + 1], vgbRaw[bi + 2]);
        if (maxCh >= brightThreshold) {
          vgbOutput[y * vgbWidth + x] = 1;
        }
      }
    }

    rowRegions.push({ y0, y1, x0: xMin, x1: xMax + 1 });
  }

  // Morphological close on VGB output (4-connected cross)
  _morphCloseCross(vgbOutput, vgbWidth, vgbHeight);

  // Invert: black text on white background
  const vgbFinal = Buffer.alloc(vgbPixels);
  for (let i = 0; i < vgbPixels; i++) {
    vgbFinal[i] = vgbOutput[i] ? 0 : 255;
  }

  const png: Buffer = await sharp(vgbFinal, {
    raw: { width: vgbWidth, height: vgbHeight, channels: 1 },
  })
    .png()
    .toBuffer();

  return { png, rowRegions, width: vgbWidth, height: vgbHeight };
}

export async function enhanceForRivenOcr(croppedImage: any, mode: EnhanceMode): Promise<Buffer> {
  const sharp = require("sharp") as typeof import("sharp");
  const { width, height } = croppedImage.getSize();

  if (mode.kind === "original") {
    const scale = width >= MIN_OCR_WIDTH ? 1 : Math.min(3, Math.ceil(MIN_OCR_WIDTH / width));
    const pngBuffer: Buffer = croppedImage.toPNG();
    if (scale <= 1) return pngBuffer;
    const scaledWidth = Math.min(6000, width * scale);
    const scaledHeight = Math.min(6000, height * scale);
    return sharp(pngBuffer)
      .resize(scaledWidth, scaledHeight, { kernel: "lanczos3" })
      .png()
      .toBuffer();
  }

  // ── Violet-guided-bright: hybrid two-pass approach ─────────────────────────
  // Delegate to enhanceForRivenOcrVgb which returns both PNG and row regions.
  if (mode.kind === "violet-guided-bright") {
    const result = await enhanceForRivenOcrVgb(croppedImage, mode.brightThreshold);
    return result.png;
  }

  const scale = width >= MIN_OCR_WIDTH ? 1 : Math.ceil(MIN_OCR_WIDTH / width);
  const scaledWidth = Math.min(6000, width * scale);
  const scaledHeight = Math.min(6000, height * scale);
  const pngBuffer: Buffer = croppedImage.toPNG();
  const rawBuffer = await sharp(pngBuffer)
    .resize(scaledWidth, scaledHeight, { kernel: "linear" })
    .ensureAlpha()
    .raw()
    .toBuffer();

  const pixelCount = scaledWidth * scaledHeight;
  const mask = Buffer.alloc(pixelCount);

  if (mode.kind === "violet") {
    // HSV-based violet text isolation — targets the purple/violet hue of
    // Warframe riven card text while rejecting Kuva animation noise.
    for (let bufferIndex = 0, pixelIndex = 0; bufferIndex < rawBuffer.length; bufferIndex += 4, pixelIndex++) {
      const red = rawBuffer[bufferIndex];
      const green = rawBuffer[bufferIndex + 1];
      const blue = rawBuffer[bufferIndex + 2];
      mask[pixelIndex] = isVioletPixel(red, green, blue) ? 1 : 0;
    }
  } else {
    // Brightness-based threshold (existing logic)
    for (let bufferIndex = 0, pixelIndex = 0; bufferIndex < rawBuffer.length; bufferIndex += 4, pixelIndex++) {
      const red = rawBuffer[bufferIndex];
      const green = rawBuffer[bufferIndex + 1];
      const blue = rawBuffer[bufferIndex + 2];
      const maxChannel = Math.max(red, green, blue);
      mask[pixelIndex] = maxChannel >= mode.threshold ? 1 : 0;
    }
  }

  // Violet mode cleanup: morphological close (fill 1px gaps in thin strokes)
  // then remove isolated noise pixels.  Intentionally gentler than the
  // brightness-mode erode — the violet filter already rejects most non-text
  // pixels by hue, so only tiny scattered dots remain.
  if (mode.kind === "violet") {
    // Close: dilate then erode — fills 1px gaps in text strokes
    const dilated = Buffer.alloc(pixelCount);
    for (let y = 0; y < scaledHeight; y++) {
      for (let x = 0; x < scaledWidth; x++) {
        const i = y * scaledWidth + x;
        if (mask[i]) {
          dilated[i] = 1;
          if (x > 0) dilated[i - 1] = 1;
          if (x < scaledWidth - 1) dilated[i + 1] = 1;
          if (y > 0) dilated[i - scaledWidth] = 1;
          if (y < scaledHeight - 1) dilated[i + scaledWidth] = 1;
        }
      }
    }
    // Erode back to original size
    for (let y = 0; y < scaledHeight; y++) {
      for (let x = 0; x < scaledWidth; x++) {
        const i = y * scaledWidth + x;
        if (dilated[i]) {
          // Keep pixel only if all 4-connected neighbours survived dilation
          const hasAll =
            (x === 0 || dilated[i - 1]) &&
            (x === scaledWidth - 1 || dilated[i + 1]) &&
            (y === 0 || dilated[i - scaledWidth]) &&
            (y === scaledHeight - 1 || dilated[i + scaledWidth]);
          mask[i] = hasAll ? 1 : 0;
        } else {
          mask[i] = 0;
        }
      }
    }
  }

  const output = Buffer.alloc(pixelCount);
  const shouldDilate = "dilate" in mode && mode.dilate;
  if (shouldDilate) {
    for (let y = 0; y < scaledHeight; y++) {
      for (let x = 0; x < scaledWidth; x++) {
        let found = false;
        for (let dy = -1; dy <= 1 && !found; dy++) {
          for (let dx = -1; dx <= 1 && !found; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (
              nx >= 0 &&
              nx < scaledWidth &&
              ny >= 0 &&
              ny < scaledHeight &&
              mask[ny * scaledWidth + nx]
            ) {
              found = true;
            }
          }
        }
        output[y * scaledWidth + x] = found ? 0 : 255;
      }
    }
  } else {
    for (let index = 0; index < pixelCount; index++) {
      output[index] = mask[index] ? 0 : 255;
    }
  }

  return sharp(output, {
    raw: { width: scaledWidth, height: scaledHeight, channels: 1 },
  })
    .png()
    .toBuffer();
}
