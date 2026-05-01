import { captureScreenFast, type CaptureResult } from "../../services/rewardScannerCapture";
import type { NativeImage } from "electron";
import { cropRectContent, detectGameContentRect } from "../../services/rewardScannerImage";
import { clamp01, computeMeanAndStd, sleep } from "../../services/rewardScannerUtils";

interface TextBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface RivenTextMetrics {
  score: number;
  coverage: number;
  activeRows: number;
  activeCols: number;
  rowGroups: number;
  bounds: TextBounds | null;
}

interface RivenUiReadyResult {
  ready: boolean;
  attempts: number;
  elapsedMs: number;
  bestScore: number;
  screenshot: CaptureResult | null;
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
function getRivenBitmap(nativeImage: NativeImage): { bitmap: Buffer; width: number; height: number } | null {
  if (!nativeImage || typeof nativeImage.getSize !== "function") return null;
  const { width, height } = nativeImage.getSize();
  if (width < 24 || height < 24) return null;
  return { bitmap: nativeImage.toBitmap(), width, height };
}

function analyzeRivenTextMetrics(nativeImage: NativeImage, shared?: { bitmap: Buffer; width: number; height: number } | null): RivenTextMetrics {
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

export function computeRivenFrameHash(nativeImage: NativeImage, shared?: { bitmap: Buffer; width: number; height: number } | null): string {
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
  let bestScreenshot: CaptureResult | null = null;
  let bestFrameHash = "";
  let lastMetrics: RivenTextMetrics | null = null;
  let lastFrameHash = "";
  let lastScreenshot: CaptureResult | null = null;
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

    let roughCrop: NativeImage;
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

