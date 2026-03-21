"use strict";

import { captureScreen } from "../../services/rewardScannerCapture";
import { cropRect } from "../../services/rewardScannerImage";
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

export type EnhanceMode = OriginalMode | FilteredMode;

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
  // Roll gate: kept SHORT because the diorama event is the authoritative trigger
  // and arrives ~1500–2500 ms after roll confirm.  When the diorama fires, the
  // fallback scan (now 3500 ms) is aborted immediately, so the gate rarely runs
  // to timeout in normal use.  500 ms gives ~12 polls as a safety net for the
  // rare case the fallback scan fires (no diorama event received).
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

function analyzeRivenTextMetrics(nativeImage: any): RivenTextMetrics {
  if (!nativeImage || typeof nativeImage.getSize !== "function") {
    return {
      score: 0,
      coverage: 0,
      activeRows: 0,
      activeCols: 0,
      rowGroups: 0,
      bounds: null,
    };
  }

  const { width, height } = nativeImage.getSize();
  if (width < 24 || height < 24) {
    return {
      score: 0,
      coverage: 0,
      activeRows: 0,
      activeCols: 0,
      rowGroups: 0,
      bounds: null,
    };
  }

  const bitmap: Buffer = nativeImage.toBitmap();
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

export function computeRivenFrameHash(nativeImage: any): string {
  if (!nativeImage || typeof nativeImage.getSize !== "function") return "";
  const { width, height } = nativeImage.getSize();
  const bitmap: Buffer = nativeImage.toBitmap();
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

function detectRivenCardFrame(nativeImage: any): TextBounds | null {
  if (!nativeImage?.getSize) return null;
  const { width, height } = nativeImage.getSize();
  if (width < 160 || height < 120) return null;

  const bitmap: Buffer = nativeImage.toBitmap();
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
  const metrics = analyzeRivenTextMetrics(nativeImage);
  const cardFrame = detectRivenCardFrame(nativeImage);
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

  while (Date.now() - startedAt < timeoutMs) {
    if (_rivenScanAborted) break;
    attempts += 1;

    const screenshot = await captureScreen({ preferScreenCapture: true, preferredDisplayId });
    if (!screenshot?.image) {
      consecutiveHits = 0;
      await sleep(RIVEN_READY_POLL_MS);
      continue;
    }
    lastScreenshot = screenshot;

    let roughCrop: any;
    try {
      roughCrop = cropRect(screenshot.image, rect);
    } catch {
      consecutiveHits = 0;
      await sleep(RIVEN_READY_POLL_MS);
      continue;
    }

    const metrics = analyzeRivenTextMetrics(roughCrop);
    const frameHash = computeRivenFrameHash(roughCrop);
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
  for (let bufferIndex = 0, pixelIndex = 0; bufferIndex < rawBuffer.length; bufferIndex += 4, pixelIndex++) {
    const red = rawBuffer[bufferIndex];
    const green = rawBuffer[bufferIndex + 1];
    const blue = rawBuffer[bufferIndex + 2];
    const maxChannel = Math.max(red, green, blue);
    mask[pixelIndex] = maxChannel >= mode.threshold ? 1 : 0;
  }

  const output = Buffer.alloc(pixelCount);
  if (mode.dilate) {
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
