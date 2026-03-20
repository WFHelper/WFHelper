"use strict";

/**
 * UI readiness detection for reward scanning.
 * Analyzes screen captures to determine if the reward selection UI is visible.
 */

import {
  clampNumber,
  clamp01,
  round4,
  computeMeanAndStd,
  sleep,
  luminanceFromBgr,
} from "./rewardScannerUtils";
import { cropRewardBand, detectRewardSlotLayout } from "./rewardScannerImage";
import { captureScreen } from "./rewardScannerCapture";

export const UI_READY_DEFAULT_TIMEOUT_MS = 2_200;
export const UI_READY_DEFAULT_POLL_MS = 120;
export const UI_READY_DEFAULT_REQUIRED_HITS = 2;
export const UI_READY_DEFAULT_SCORE_THRESHOLD = 0.58;
export const UI_READY_MIN_PEAK_COUNT = 3;
export const UI_READY_MIN_TEXTURE_SCORE = 0.18;

export const READINESS_ANALYSIS: Readonly<{
  minCropWidth: number;
  minCropHeight: number;
  targetSampleCols: number;
  targetSampleRows: number;
  smoothingDivisor: number;
  thresholdStdMultiplier: number;
  minSegmentWidthFloor: number;
  minSegmentWidthRatio: number;
  peakBaseline: number;
  peakRange: number;
  textureBaseline: number;
  textureRange: number;
  coverageNormalizer: number;
  scoreWeights: Readonly<{ peak: number; texture: number; coverage: number }>;
}> = Object.freeze({
  minCropWidth: 40,
  minCropHeight: 24,
  targetSampleCols: 420,
  targetSampleRows: 120,
  smoothingDivisor: 3,
  thresholdStdMultiplier: 0.35,
  minSegmentWidthFloor: 3,
  minSegmentWidthRatio: 0.06,
  peakBaseline: 2,
  peakRange: 2,
  textureBaseline: 90,
  textureRange: 230,
  coverageNormalizer: 0.7,
  scoreWeights: Object.freeze({
    peak: 0.55,
    texture: 0.3,
    coverage: 0.15,
  }),
});

export const UI_READY_OPTION_LIMITS: Readonly<{
  timeoutMinMs: number;
  timeoutMaxMs: number;
  pollMinMs: number;
  pollMaxMs: number;
  requiredHitsMin: number;
  requiredHitsMax: number;
  scoreThresholdMin: number;
  scoreThresholdMax: number;
}> = Object.freeze({
  timeoutMinMs: 200,
  timeoutMaxMs: 8_000,
  pollMinMs: 60,
  pollMaxMs: 500,
  requiredHitsMin: 1,
  requiredHitsMax: 4,
  scoreThresholdMin: 0.35,
  scoreThresholdMax: 0.95,
});

interface Band {
  top?: number;
  height?: number;
}

interface ReadinessResult {
  ready: boolean;
  score: number;
  peakCount: number;
  textureScore: number;
  coverageScore: number;
  slotCount: number;
  slotConfidence: number;
  bandTopRatio: number | null;
  bandHeightRatio: number | null;
  bandBottomRatio: number | null;
}

export function analyzeRewardBandReadiness(
  nativeImage: any,
  band: Band | null | undefined,
): ReadinessResult {
  if (!nativeImage || typeof nativeImage.getSize !== "function") {
    return {
      ready: false,
      score: 0,
      peakCount: 0,
      textureScore: 0,
      coverageScore: 0,
      slotCount: 0,
      slotConfidence: 0,
      bandTopRatio: round4(band?.top, 0),
      bandHeightRatio: round4(band?.height, 0),
      bandBottomRatio: round4((Number(band?.top) || 0) + (Number(band?.height) || 0), 0),
    };
  }

  let cropped: any;
  try {
    cropped = cropRewardBand(nativeImage, band);
  } catch {
    return {
      ready: false,
      score: 0,
      peakCount: 0,
      textureScore: 0,
      coverageScore: 0,
      slotCount: 0,
      slotConfidence: 0,
      bandTopRatio: round4(band?.top, 0),
      bandHeightRatio: round4(band?.height, 0),
      bandBottomRatio: round4((Number(band?.top) || 0) + (Number(band?.height) || 0), 0),
    };
  }

  const { width, height } = cropped.getSize();
  if (width < READINESS_ANALYSIS.minCropWidth || height < READINESS_ANALYSIS.minCropHeight) {
    return {
      ready: false,
      score: 0,
      peakCount: 0,
      textureScore: 0,
      coverageScore: 0,
      slotCount: 0,
      slotConfidence: 0,
      bandTopRatio: round4(band?.top, 0),
      bandHeightRatio: round4(band?.height, 0),
      bandBottomRatio: round4((Number(band?.top) || 0) + (Number(band?.height) || 0), 0),
    };
  }

  const bitmap: Buffer = cropped.toBitmap();
  const stepX = Math.max(1, Math.floor(width / READINESS_ANALYSIS.targetSampleCols));
  const stepY = Math.max(1, Math.floor(height / READINESS_ANALYSIS.targetSampleRows));
  const sampleCols = Math.max(1, Math.floor(width / stepX));

  const energies = new Array<number>(sampleCols).fill(0);

  for (let column = 0; column < sampleCols; column += 1) {
    const x = Math.min(width - 1, column * stepX);
    let sum = 0;
    let sumSq = 0;
    let count = 0;

    for (let y = 0; y < height; y += stepY) {
      const idx = (y * width + x) * 4;
      const blue = bitmap[idx];
      const green = bitmap[idx + 1];
      const red = bitmap[idx + 2];
      const lum = luminanceFromBgr(blue, green, red);

      sum += lum;
      sumSq += lum * lum;
      count += 1;
    }

    const mean = sum / Math.max(1, count);
    const variance = Math.max(0, sumSq / Math.max(1, count) - mean * mean);
    energies[column] = variance;
  }

  const smoothed = energies.map((value, index) => {
    const prev = index > 0 ? energies[index - 1] : value;
    const next = index < energies.length - 1 ? energies[index + 1] : value;
    return (prev + value + next) / READINESS_ANALYSIS.smoothingDivisor;
  });

  const stats = computeMeanAndStd(smoothed);
  const threshold = stats.mean + stats.std * READINESS_ANALYSIS.thresholdStdMultiplier;
  const minSegmentWidth = Math.max(
    READINESS_ANALYSIS.minSegmentWidthFloor,
    Math.floor(sampleCols * READINESS_ANALYSIS.minSegmentWidthRatio),
  );

  let peakCount = 0;
  let coverageCols = 0;
  let runLength = 0;

  for (let i = 0; i < smoothed.length; i += 1) {
    if (smoothed[i] > threshold) {
      runLength += 1;
      continue;
    }

    if (runLength >= minSegmentWidth) {
      peakCount += 1;
      coverageCols += runLength;
    }
    runLength = 0;
  }

  if (runLength >= minSegmentWidth) {
    peakCount += 1;
    coverageCols += runLength;
  }

  const peakScore = clamp01(
    (peakCount - READINESS_ANALYSIS.peakBaseline) / READINESS_ANALYSIS.peakRange,
  );
  const textureScore = clamp01(
    (stats.std - READINESS_ANALYSIS.textureBaseline) / READINESS_ANALYSIS.textureRange,
  );
  const coverageScore = clamp01(
    coverageCols / Math.max(1, sampleCols) / READINESS_ANALYSIS.coverageNormalizer,
  );
  const score =
    peakScore * READINESS_ANALYSIS.scoreWeights.peak +
    textureScore * READINESS_ANALYSIS.scoreWeights.texture +
    coverageScore * READINESS_ANALYSIS.scoreWeights.coverage;

  const slotLayout = detectRewardSlotLayout(nativeImage);
  const slotConfidence = slotLayout.count >= 2 ? slotLayout.confidence : 0;
  const finalScore = clamp01(score * 0.8 + slotConfidence * 0.2);

  const ready =
    (peakCount >= UI_READY_MIN_PEAK_COUNT &&
      textureScore >= UI_READY_MIN_TEXTURE_SCORE &&
      finalScore >= UI_READY_DEFAULT_SCORE_THRESHOLD) ||
    (slotLayout.count >= 2 && slotConfidence >= 0.55);

  return {
    ready,
    score: Number(finalScore.toFixed(3)),
    peakCount,
    textureScore: Number(textureScore.toFixed(3)),
    coverageScore: Number(coverageScore.toFixed(3)),
    slotCount: slotLayout.count,
    slotConfidence: Number(slotConfidence.toFixed(3)),
    bandTopRatio: round4(band?.top, 0),
    bandHeightRatio: round4(band?.height, 0),
    bandBottomRatio: round4((Number(band?.top) || 0) + (Number(band?.height) || 0), 0),
  };
}

interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  requiredHits?: number;
  scoreThreshold?: number;
  band?: Band;
}

interface WaitResult {
  ready: boolean;
  attempts: number;
  elapsedMs: number;
  threshold: number;
  best:
    | (ReadinessResult & {
        sourceType: string | null;
        sourceDisplayId: string | null;
        sourceName: string | null;
        attempt: number;
      })
    | null;
}

export async function waitForRewardUiReady(
  options: WaitOptions = {},
  getPrimaryBand: () => Band,
): Promise<WaitResult> {
  const timeoutMs = Math.floor(
    clampNumber(
      options.timeoutMs,
      UI_READY_OPTION_LIMITS.timeoutMinMs,
      UI_READY_OPTION_LIMITS.timeoutMaxMs,
      UI_READY_DEFAULT_TIMEOUT_MS,
    ),
  );
  const pollMs = Math.floor(
    clampNumber(
      options.pollMs,
      UI_READY_OPTION_LIMITS.pollMinMs,
      UI_READY_OPTION_LIMITS.pollMaxMs,
      UI_READY_DEFAULT_POLL_MS,
    ),
  );
  const requiredHits = Math.floor(
    clampNumber(
      options.requiredHits,
      UI_READY_OPTION_LIMITS.requiredHitsMin,
      UI_READY_OPTION_LIMITS.requiredHitsMax,
      UI_READY_DEFAULT_REQUIRED_HITS,
    ),
  );
  const scoreThreshold = clampNumber(
    options.scoreThreshold,
    UI_READY_OPTION_LIMITS.scoreThresholdMin,
    UI_READY_OPTION_LIMITS.scoreThresholdMax,
    UI_READY_DEFAULT_SCORE_THRESHOLD,
  );

  const band: Band =
    options.band && Number.isFinite(options.band.top) && Number.isFinite(options.band.height)
      ? options.band
      : getPrimaryBand();

  const startedAt = Date.now();
  let attempts = 0;
  let consecutiveHits = 0;
  let best: WaitResult["best"] = null;

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;

    const screenshot = await captureScreen();
    if (!screenshot || !screenshot.image) {
      consecutiveHits = 0;
      await sleep(pollMs);
      continue;
    }

    const readiness = analyzeRewardBandReadiness(screenshot.image, band);
    const sample = {
      ...readiness,
      sourceType: screenshot.sourceType || null,
      sourceDisplayId: screenshot.sourceDisplayId || null,
      sourceName: screenshot.sourceName || null,
      attempt: attempts,
    };

    if (!best || sample.score > best.score) {
      best = sample;
    }

    const hit =
      sample.peakCount >= UI_READY_MIN_PEAK_COUNT &&
      sample.textureScore >= UI_READY_MIN_TEXTURE_SCORE &&
      sample.score >= scoreThreshold;

    consecutiveHits = hit ? consecutiveHits + 1 : 0;

    if (consecutiveHits >= requiredHits) {
      return {
        ready: true,
        attempts,
        elapsedMs: Date.now() - startedAt,
        threshold: scoreThreshold,
        best: sample,
      };
    }

    await sleep(pollMs);
  }

  return {
    ready: false,
    attempts,
    elapsedMs: Date.now() - startedAt,
    threshold: scoreThreshold,
    best,
  };
}
