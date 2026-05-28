import crypto from "node:crypto";
import type { NativeImage } from "electron";

import { REWARD_FRAME_DEDUP_TTL_MS } from "../config/runtime/cacheConfig";
import { normalizeErrorMessage } from "../config/shared/errors";
import { withScope } from "./logger";
import { captureScreenFast, type CaptureResult } from "./rewardScannerCapture";
import { detectConsoleOpen, detectRewardSlotLayout } from "./rewardScannerImage";
import {
  buildConsensusSelection,
  MAX_REWARD_SLOTS,
  type PassResult,
  type SortedItem,
} from "./rewardScannerMatch";
import { scanRewardBandPasses } from "./rewardScannerBandScan";
import { scanRewardSlotsFallback, type StructuredOcrBufferRunner } from "./rewardScannerSlotScan";
import {
  expectedRewardItemCount,
  findTemporalFallback,
  getAdaptiveStrategyHint,
  hasConfidentSlotLayout,
  recordStrategyWin,
  recordTemporalEntry,
  SCANNER_TUNING,
} from "./rewardScannerSupport";
import { round4 } from "./rewardScannerUtils";

const log = withScope("rewardScanner");

interface TriggerStats {
  captureCount: number;
  captureMs: number;
  ocrCallCount: number;
  ocrTotalMs: number;
  slotDetectMs: number;
  strategy: string;
  failureReason: string | null;
}

export interface PreCaptureResult {
  image: NativeImage;
  sourceType: string | null;
  sourceName: string | null;
  sourceId: string | null;
  sourceDisplayId: string | null;
}

export interface RewardScanSettings {
  cropPreset: string;
  ocrPasses: number;
  matchThreshold: number;
  ocrTimeoutMs: number;
}

interface RewardScanPipelineOptions {
  preCapture?: PreCaptureResult | null;
  sortedItems: SortedItem[];
  settings: RewardScanSettings;
  getBandsForPasses: (presetName: string, passes: number) => Array<{ top: number; height: number }>;
  runOCRStructuredBuffer: StructuredOcrBufferRunner;
}

let _lastTriggerStats: TriggerStats | null = null;
let _lastFrameHash: string | null = null;
let _lastFrameResult: { items: SortedItem[]; meta: Record<string, unknown> } | null = null;
let _lastFrameHashTs = 0;

function computeFrameHash(nativeImage: NativeImage): string | null {
  try {
    const bitmap: Buffer = nativeImage.toBitmap();
    const sample = Buffer.alloc(Math.ceil(bitmap.length / 256));
    for (let i = 0; i < sample.length; i++) {
      sample[i] = bitmap[i * 256];
    }
    return crypto.createHash("sha1").update(sample).digest("hex");
  } catch {
    return null;
  }
}

export function resetFrameDedup(): void {
  _lastFrameHash = null;
  _lastFrameResult = null;
  _lastFrameHashTs = 0;
}

function computeRewardScanBudgetMs(settings: RewardScanSettings): number {
  const passes = Math.max(1, Math.floor(settings.ocrPasses || 1));
  const perAttempt = Math.max(500, Math.min(Number(settings.ocrTimeoutMs) || 0, 2000));
  return Math.max(
    SCANNER_TUNING.budget.minMs,
    Math.min(SCANNER_TUNING.budget.maxMs, 800 + passes * 500 + perAttempt),
  );
}

function buildScanMeta({
  screenshot,
  selectedPass,
  passCount,
  strategy,
  elapsedMs,
  hadOcrSuccess,
}: {
  screenshot: {
    image?: NativeImage;
    sourceType?: string | null;
    sourceName?: string | null;
    sourceId?: string | null;
    sourceDisplayId?: string | null;
  } | null;
  selectedPass: {
    band?: { top: number; height: number } | null;
    passIndex?: number;
    score?: number;
    exactCount?: number;
    ocrVariant?: string;
    text?: string;
  } | null;
  passCount: number;
  strategy: string;
  elapsedMs: number;
  hadOcrSuccess: boolean;
}): Record<string, unknown> {
  const captureSize = screenshot?.image?.getSize?.() || { width: 0, height: 0 };
  const band = selectedPass?.band || null;
  const top = band ? round4(band.top, 0) : null;
  const height = band ? round4(band.height, 0) : null;
  const bottom = top != null && height != null ? round4(top + height, null) : null;

  return {
    sourceType: screenshot?.sourceType || null,
    sourceName: screenshot?.sourceName || null,
    sourceId: screenshot?.sourceId || null,
    sourceDisplayId: screenshot?.sourceDisplayId || null,
    captureWidth: captureSize.width,
    captureHeight: captureSize.height,
    passIndex: selectedPass?.passIndex ?? null,
    passCount,
    score: Number.isFinite(selectedPass?.score) ? Number(selectedPass!.score!.toFixed(3)) : null,
    exactCount: typeof selectedPass?.exactCount === "number" ? selectedPass.exactCount : null,
    strategy: strategy || "none",
    hadOcrSuccess: !!hadOcrSuccess,
    bandTopRatio: top,
    bandHeightRatio: height,
    bandBottomRatio: bottom,
    elapsedMs: Math.max(0, Math.round(elapsedMs || 0)),
  };
}

function cacheFrameResult(
  frameHash: string | null,
  result: { items: SortedItem[]; meta: Record<string, unknown> },
): void {
  if (!frameHash) return;
  _lastFrameHash = frameHash;
  _lastFrameResult = result;
  _lastFrameHashTs = Date.now();
}

async function captureRewardScreen(preCapture: PreCaptureResult | null | undefined): Promise<{
  screenshot: CaptureResult | PreCaptureResult | null;
  captureCount: number;
  captureMs: number;
  failureReason: "capture-error" | "capture-null" | null;
}> {
  if (preCapture?.image) {
    log.info(
      "[RewardScanner] Using pre-captured screenshot" +
        ` (${preCapture.sourceType || "file"}:${preCapture.sourceName || preCapture.sourceId || "injected"})`,
    );
    return { screenshot: preCapture, captureCount: 0, captureMs: 0, failureReason: null };
  }

  const captureStart = Date.now();
  try {
    const screenshot = await captureScreenFast();
    const captureMs = Date.now() - captureStart;
    if (!screenshot) {
      log.warn("[RewardScanner] Could not capture screen");
      return { screenshot: null, captureCount: 1, captureMs, failureReason: "capture-null" };
    }
    log.info(
      "[RewardScanner] Scan capture source -> " +
        `${screenshot.sourceType}: ${screenshot.sourceName || screenshot.sourceId || "unknown"} ` +
        `(display:${screenshot.sourceDisplayId || "n/a"})`,
    );
    return { screenshot, captureCount: 1, captureMs, failureReason: null };
  } catch (err) {
    log.error("[RewardScanner] captureScreen error:", normalizeErrorMessage(err));
    return {
      screenshot: null,
      captureCount: 1,
      captureMs: Date.now() - captureStart,
      failureReason: "capture-error",
    };
  }
}

export async function runRewardScanPipeline({
  preCapture,
  sortedItems,
  settings,
  getBandsForPasses,
  runOCRStructuredBuffer,
}: RewardScanPipelineOptions): Promise<{
  items: SortedItem[];
  meta: Record<string, unknown>;
} | null> {
  const scanStartedAt = Date.now();
  const totalBudgetMs = computeRewardScanBudgetMs(settings);
  let ocrCallCount = 0;
  let ocrTotalMs = 0;

  const capture = await captureRewardScreen(preCapture);
  const { screenshot, captureCount, captureMs } = capture;
  if (!screenshot) {
    _lastTriggerStats = {
      captureCount,
      captureMs,
      ocrCallCount: 0,
      ocrTotalMs: 0,
      slotDetectMs: 0,
      strategy: "failed",
      failureReason: capture.failureReason,
    };
    return null;
  }

  if (detectConsoleOpen(screenshot.image)) {
    log.info("[RewardScanner] Chat console detected — skipping scan");
    return null;
  }

  const frameHash = computeFrameHash(screenshot.image);
  if (
    frameHash &&
    frameHash === _lastFrameHash &&
    _lastFrameResult &&
    Date.now() - _lastFrameHashTs < REWARD_FRAME_DEDUP_TTL_MS
  ) {
    log.info("[RewardScanner] Frame unchanged — returning cached result");
    return _lastFrameResult;
  }

  const bands = getBandsForPasses(settings.cropPreset, settings.ocrPasses);
  const adaptiveHint = getAdaptiveStrategyHint();
  if (adaptiveHint && adaptiveHint.bandIndex > 0 && adaptiveHint.bandIndex < bands.length) {
    const hintBand = bands[adaptiveHint.bandIndex];
    bands.splice(adaptiveHint.bandIndex, 1);
    bands.unshift(hintBand);
  }

  const slotDetectStart = Date.now();
  const detectedLayout = detectRewardSlotLayout(screenshot.image);
  const slotDetectMs = Date.now() - slotDetectStart;
  let expectedItemCount = expectedRewardItemCount(detectedLayout);

  log.info(
    `[RewardScanner] Slot layout estimate: count=${detectedLayout.count} confidence=${detectedLayout.confidence.toFixed(3)} expected=${expectedItemCount}`,
  );

  let slotFirstResult: Awaited<ReturnType<typeof scanRewardSlotsFallback>> | null = null;

  if (hasConfidentSlotLayout(detectedLayout)) {
    slotFirstResult = await scanRewardSlotsFallback(
      screenshot,
      expectedItemCount,
      totalBudgetMs,
      scanStartedAt,
      { sortedItems, ocrTimeoutMs: settings.ocrTimeoutMs, runOCRStructuredBuffer },
    );

    if (
      slotFirstResult &&
      slotFirstResult.items.length >= expectedItemCount &&
      slotFirstResult.exactCount > 0 &&
      slotFirstResult.avgConfidence >= 0.84
    ) {
      log.info(
        `[RewardScanner] Early slot-primary hit: ${slotFirstResult.items.length}/${expectedItemCount} items ` +
          `(exact=${slotFirstResult.exactCount}, confidence=${slotFirstResult.slotConfidence.toFixed(3)}, avg=${slotFirstResult.avgConfidence.toFixed(3)})`,
      );
      const result = {
        items: slotFirstResult.items,
        meta: buildScanMeta({
          screenshot,
          selectedPass: {
            passIndex: 0,
            score: slotFirstResult.score,
            ocrVariant: "slot-primary",
            band: null,
            exactCount: slotFirstResult.exactCount,
          },
          passCount: bands.length,
          strategy: slotFirstResult.strategy,
          elapsedMs: Date.now() - scanStartedAt,
          hadOcrSuccess: true,
        }),
      };
      cacheFrameResult(frameHash, result);
      recordTemporalEntry(slotFirstResult.items, expectedItemCount);
      _lastTriggerStats = {
        captureCount,
        captureMs,
        ocrCallCount,
        ocrTotalMs,
        slotDetectMs,
        strategy: slotFirstResult.strategy,
        failureReason: null,
      };
      return result;
    }

    if (
      slotFirstResult &&
      (slotFirstResult.exactCount > 0 || slotFirstResult.avgConfidence >= 0.96) &&
      slotFirstResult.items.length >= expectedItemCount
    ) {
      log.info(
        `[RewardScanner] Partial slot-primary hit: ${slotFirstResult.items.length}/${expectedItemCount} items ` +
          `(exact=${slotFirstResult.exactCount}, confidence=${slotFirstResult.slotConfidence.toFixed(3)}) — skipping band OCR`,
      );
      const result = {
        items: slotFirstResult.items,
        meta: buildScanMeta({
          screenshot,
          selectedPass: {
            passIndex: 0,
            score: slotFirstResult.score,
            ocrVariant: "slot-primary-partial",
            band: null,
            exactCount: slotFirstResult.exactCount,
          },
          passCount: bands.length,
          strategy: "slot-partial",
          elapsedMs: Date.now() - scanStartedAt,
          hadOcrSuccess: true,
        }),
      };
      cacheFrameResult(frameHash, result);
      return result;
    }

    if (expectedItemCount < MAX_REWARD_SLOTS) {
      log.info(
        `[RewardScanner] Expanding OCR target from ${expectedItemCount} to ${MAX_REWARD_SLOTS} after slot-primary was not conclusive`,
      );
      expectedItemCount = MAX_REWARD_SLOTS;
    }
  }

  const bandScan = await scanRewardBandPasses({
    screenshot,
    bands,
    expectedItemCount,
    totalBudgetMs,
    scanStartedAt,
    threshold: settings.matchThreshold,
    sortedItems,
    ocrTimeoutMs: settings.ocrTimeoutMs,
    runOCRStructuredBuffer,
  });
  const hadOcrSuccess = bandScan.hadOcrSuccess;
  const passResults = bandScan.passResults;
  const bestPass = bandScan.bestPass;
  ocrCallCount += bandScan.ocrCallCount;
  ocrTotalMs += bandScan.ocrTotalMs;

  if (!hadOcrSuccess) {
    return null;
  }

  const consensus = buildConsensusSelection(passResults);
  const selectedPass: PassResult | null =
    consensus?.selectedPass || bestPass || passResults[0] || null;
  let items: SortedItem[] = (consensus?.items || selectedPass?.items || []).slice(
    0,
    expectedItemCount,
  );
  let finalStrategy = consensus?.strategy || "best-pass";

  if (
    slotFirstResult &&
    (slotFirstResult.exactCount > 0 || slotFirstResult.avgConfidence >= 0.96) &&
    (slotFirstResult.items.length > items.length ||
      (slotFirstResult.items.length === items.length && slotFirstResult.exactCount > 0))
  ) {
    items = slotFirstResult.items.slice(0, expectedItemCount);
    finalStrategy = slotFirstResult.strategy;
  }

  if (items.length < expectedItemCount) {
    const slotFallback =
      slotFirstResult && slotFirstResult.items.length > 0
        ? slotFirstResult
        : await scanRewardSlotsFallback(
            screenshot,
            expectedItemCount,
            totalBudgetMs,
            scanStartedAt,
            { sortedItems, ocrTimeoutMs: settings.ocrTimeoutMs, runOCRStructuredBuffer },
          );
    if (
      slotFallback &&
      (slotFallback.exactCount > 0 || slotFallback.avgConfidence >= 0.96) &&
      slotFallback.items.length > items.length
    ) {
      items = slotFallback.items;
      finalStrategy = slotFallback.strategy;
      log.info(
        `[RewardScanner] Slot fallback improved result: ${slotFallback.items.length}/${expectedItemCount} items ` +
          `(exact=${slotFallback.exactCount}, confidence=${slotFallback.slotConfidence.toFixed(3)}, avg=${slotFallback.avgConfidence.toFixed(3)})`,
      );
    }
  }

  const temporalFallback = findTemporalFallback(items, expectedItemCount);
  if (temporalFallback) {
    log.info(
      `[RewardScanner] Temporal consistency: sparse result (${items.length}/${expectedItemCount}), ` +
        `using recent full result (${temporalFallback.length} items)`,
    );
    items = temporalFallback;
    finalStrategy = "temporal-consensus";
  }

  if (items.length > 0) {
    log.info(
      `[RewardScanner] Detected (${finalStrategy} pass ${selectedPass?.passIndex ?? "?"}, ` +
        `score ${Number(selectedPass?.score || 0).toFixed(2)}, variant ${selectedPass?.ocrVariant || "raw"}):`,
      items.map((item: SortedItem) => item.name).join(" | "),
    );
  } else {
    const textPreview = selectedPass?.text
      ? selectedPass.text.slice(0, SCANNER_TUNING.ocr.textPreviewMaxChars).replace(/\s+/g, " ")
      : "";
    log.info(
      textPreview
        ? "[RewardScanner] No items matched OCR text:"
        : "[RewardScanner] No items matched OCR text",
      textPreview,
    );
  }

  recordTemporalEntry(items, expectedItemCount);
  _lastTriggerStats = {
    captureCount,
    captureMs,
    ocrCallCount,
    ocrTotalMs,
    slotDetectMs,
    strategy: finalStrategy,
    failureReason: items.length === 0 ? "no-items" : null,
  };
  log.info(
    `[RewardScanner] Stats: captures=${captureCount} captureMs=${captureMs} ` +
      `ocrCalls=${ocrCallCount} ocrMs=${ocrTotalMs} strategy=${finalStrategy}`,
  );

  const result = {
    items,
    meta: buildScanMeta({
      screenshot,
      selectedPass,
      passCount: bands.length,
      strategy: finalStrategy,
      elapsedMs: Date.now() - scanStartedAt,
      hadOcrSuccess,
    }),
  };

  if (selectedPass && items.length > 0) {
    recordStrategyWin(
      selectedPass.passIndex != null ? selectedPass.passIndex - 1 : 0,
      selectedPass.ocrVariant || "raw",
      selectedPass.score || 0,
    );
  }

  cacheFrameResult(frameHash, result);
  return result;
}
