import crypto from "node:crypto";
import type { NativeImage } from "electron";

import { REWARD_FRAME_DEDUP_TTL_MS } from "../config/runtime/cacheConfig";
import { normalizeErrorMessage } from "../config/shared/errors";
import { withScope } from "./logger";
import { captureScreenFast, type CaptureResult } from "./rewardScannerCapture";
import { buildOcrVariants, cropRewardBand, detectConsoleOpen } from "./rewardScannerImage";
import { matchItemsDetailed, MAX_REWARD_SLOTS, type SortedItem } from "./rewardScannerMatch";
import {
  scanRewardSlotsFallback,
  type RewardReader,
  type StructuredOcrBufferRunner,
} from "./rewardScannerSlotScan";
import { CROP_PRESETS, SCANNER_TUNING } from "./rewardScannerSupport";
import { round4 } from "./rewardScannerUtils";

const log = withScope("rewardScanner");

// capture -> guards (console open, frame dedup) -> slot scan -> text fallback.

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
  runOCRStructuredBuffer: StructuredOcrBufferRunner;
  reader?: RewardReader;
}

type Screenshot = CaptureResult | PreCaptureResult;

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
  band,
  score,
  exactCount,
  variant,
  strategy,
  elapsedMs,
  hadOcrSuccess,
}: {
  screenshot: Screenshot | null;
  band: { top: number; height: number } | null;
  score: number | null;
  exactCount: number | null;
  variant: string;
  strategy: string;
  elapsedMs: number;
  hadOcrSuccess: boolean;
}): Record<string, unknown> {
  const captureSize = screenshot?.image?.getSize?.() || { width: 0, height: 0 };
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
    passIndex: 0,
    passCount: 1,
    score: Number.isFinite(score) ? Number(Number(score).toFixed(3)) : null,
    exactCount: typeof exactCount === "number" ? exactCount : null,
    strategy: strategy || "none",
    ocrVariant: variant,
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
  screenshot: Screenshot | null;
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

const FALLBACK_BAND = CROP_PRESETS.balanced[1] || CROP_PRESETS.balanced[0];

// Fallback for when the slot scan finds nothing (single centred reward, odd
// layout): OCR one band and match the whole strip.
async function scanRewardFallbackText(
  screenshot: Screenshot,
  options: {
    sortedItems: SortedItem[];
    threshold: number;
    ocrTimeoutMs: number;
    budgetMs: number;
    startedAt: number;
    runOCRStructuredBuffer: StructuredOcrBufferRunner;
  },
): Promise<{ items: SortedItem[]; score: number; exactCount: number }> {
  let crop: NativeImage;
  try {
    crop = cropRewardBand(screenshot.image, FALLBACK_BAND);
  } catch {
    return { items: [], score: 0, exactCount: 0 };
  }

  let best: { items: SortedItem[]; score: number; exactCount: number } | null = null;

  for (const variant of buildOcrVariants(crop)) {
    const remaining = options.budgetMs - (Date.now() - options.startedAt);
    if (remaining <= 0) break;
    try {
      const png: Buffer = variant.image.toPNG();
      const structured = await options.runOCRStructuredBuffer(
        png,
        Math.max(500, Math.min(options.ocrTimeoutMs, remaining)),
      );
      const text = String(structured?.text || "");
      const match = matchItemsDetailed(text, options.threshold, options.sortedItems);
      const candidate = {
        items: match.items.slice(0, MAX_REWARD_SLOTS),
        score: match.score,
        exactCount: match.exactCount,
      };
      if (
        !best ||
        candidate.items.length > best.items.length ||
        (candidate.items.length === best.items.length && candidate.score > best.score)
      ) {
        best = candidate;
      }
    } catch {
      continue;
    }
  }

  return best || { items: [], score: 0, exactCount: 0 };
}

export async function runRewardScanPipeline({
  preCapture,
  sortedItems,
  settings,
  runOCRStructuredBuffer,
  reader,
}: RewardScanPipelineOptions): Promise<{
  items: SortedItem[];
  meta: Record<string, unknown>;
} | null> {
  const scanStartedAt = Date.now();
  const totalBudgetMs = computeRewardScanBudgetMs(settings);

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
    log.info("[RewardScanner] Chat console detected - skipping scan");
    return null;
  }

  const frameHash = computeFrameHash(screenshot.image);
  if (
    frameHash &&
    frameHash === _lastFrameHash &&
    _lastFrameResult &&
    Date.now() - _lastFrameHashTs < REWARD_FRAME_DEDUP_TTL_MS
  ) {
    log.info("[RewardScanner] Frame unchanged - returning cached result");
    return _lastFrameResult;
  }

  // Primary path: per-slot OCR over detected reward layouts.
  const slotResult = await scanRewardSlotsFallback(
    screenshot,
    MAX_REWARD_SLOTS,
    totalBudgetMs,
    scanStartedAt,
    { sortedItems, ocrTimeoutMs: settings.ocrTimeoutMs, runOCRStructuredBuffer, reader },
  );

  let items: SortedItem[] = slotResult?.items ? slotResult.items.slice(0, MAX_REWARD_SLOTS) : [];
  let strategy = slotResult?.strategy || "slot";
  let score: number | null = slotResult ? slotResult.score : null;
  let exactCount: number | null = slotResult ? slotResult.exactCount : null;
  let band: { top: number; height: number } | null = null;
  let variant = "slot";

  if (items.length > 0) {
    log.info(
      `[RewardScanner] Slot scan: ${items.length}/${slotResult?.slotCount ?? items.length} ` +
        `(exact=${slotResult?.exactCount ?? 0}, avg=${(slotResult?.avgConfidence ?? 0).toFixed(3)}): ` +
        items.map((item) => item.name).join(" | "),
    );
  } else {
    // The text fallback is a Windows-OCR band read; skip it when the caller
    // pinned the onnx reader (harness isolation).
    const fallback =
      reader === "onnx"
        ? { items: [] as SortedItem[], score: 0, exactCount: 0 }
        : await scanRewardFallbackText(screenshot, {
            sortedItems,
            threshold: settings.matchThreshold,
            ocrTimeoutMs: settings.ocrTimeoutMs,
            budgetMs: totalBudgetMs,
            startedAt: scanStartedAt,
            runOCRStructuredBuffer,
          });
    if (fallback.items.length > 0) {
      items = fallback.items;
      strategy = "text-fallback";
      score = fallback.score;
      exactCount = fallback.exactCount;
      band = { top: FALLBACK_BAND.top, height: FALLBACK_BAND.height };
      variant = "text-fallback";
      log.info(
        `[RewardScanner] Text fallback matched ${items.length} item(s): ` +
          items.map((item) => item.name).join(" | "),
      );
    } else {
      log.info("[RewardScanner] No items matched");
    }
  }

  _lastTriggerStats = {
    captureCount,
    captureMs,
    ocrCallCount: 0,
    ocrTotalMs: 0,
    slotDetectMs: 0,
    strategy,
    failureReason: items.length === 0 ? "no-items" : null,
  };

  const result = {
    items,
    meta: buildScanMeta({
      screenshot,
      band,
      score,
      exactCount,
      variant,
      strategy,
      elapsedMs: Date.now() - scanStartedAt,
      hadOcrSuccess: items.length > 0,
    }),
  };

  cacheFrameResult(frameHash, result);
  return result;
}
