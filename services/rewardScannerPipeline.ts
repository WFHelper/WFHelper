import crypto from "node:crypto";
import type { NativeImage } from "electron";

import { REWARD_FRAME_DEDUP_TTL_MS } from "../config/runtime/cacheConfig";
import { REFERENCE_WARFRAME_UI_SCALE } from "../config/runtime/overlaySettings";
import { normalizeErrorMessage } from "../config/shared/errors";
import { withScope } from "./logger";
import { captureScreenFast, type CaptureResult } from "./screenCapture";
import {
  buildOcrVariants,
  cropRewardBand,
  detectConsoleOpen,
  sampleRewardCardBand,
} from "./rewardScannerImage";
import { matchItemsDetailed, MAX_REWARD_SLOTS, type SortedItem } from "./rewardScannerMatch";
import {
  scanRewardSlotsFallback,
  type RewardReader,
  type SlotScanStats,
  type StructuredOcrBufferRunner,
} from "./rewardScannerSlotScan";
import { CROP_PRESETS, SCANNER_TUNING } from "./rewardScannerSupport";
import { round4, yieldToEventLoop } from "./rewardScannerUtils";

const log = withScope("rewardScanner");

// capture -> guards (console open, frame dedup) -> slot scan -> text fallback.

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
  warframeUiScale?: number;
}

interface RewardScanPipelineOptions {
  preCapture?: PreCaptureResult | null;
  sortedItems: SortedItem[];
  settings: RewardScanSettings;
  runOCRStructuredBuffer: StructuredOcrBufferRunner;
  reader?: RewardReader;
}

type Screenshot = CaptureResult | PreCaptureResult;

let _lastFrameHash: string | null = null;
let _lastFrameResult: { items: SortedItem[]; meta: Record<string, unknown> } | null = null;
let _lastFrameHashTs = 0;

function computeFrameHash(nativeImage: NativeImage, uiScale: number): string | null {
  try {
    const band = sampleRewardCardBand(nativeImage, uiScale);
    if (band) return crypto.createHash("sha1").update(band).digest("hex");
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
  layoutCount,
  slotCount,
  cardCount,
}: {
  screenshot: Screenshot | null;
  band: { top: number; height: number } | null;
  score: number | null;
  exactCount: number | null;
  variant: string;
  strategy: string;
  elapsedMs: number;
  hadOcrSuccess: boolean;
  layoutCount: number;
  /** Slots of the winning card layout; the trigger loop's completeness check. */
  slotCount: number;
  /** Cards counted off the card bars, 0 when the frame had to be searched. */
  cardCount: number;
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
    layoutCount,
    slotCount,
    cardCount,
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

async function captureRewardScreen(
  preCapture: PreCaptureResult | null | undefined,
  uiScale: number,
): Promise<{ screenshot: Screenshot | null; captureMs: number }> {
  if (preCapture?.image) {
    log.info(
      "[RewardScanner] Using pre-captured screenshot" +
        ` (${preCapture.sourceType || "file"}:${preCapture.sourceName || preCapture.sourceId || "injected"})`,
    );
    return { screenshot: preCapture, captureMs: 0 };
  }

  const captureStart = Date.now();
  try {
    const screenshot = await captureScreenFast();
    const captureMs = Date.now() - captureStart;
    if (!screenshot) {
      log.warn("[RewardScanner] Could not capture screen");
      return { screenshot: null, captureMs };
    }
    // Frame size and UI scale decide every crop ratio, so a bug report without
    // them cannot be reproduced.
    const frame = screenshot.image?.getSize?.();
    log.info(
      "[RewardScanner] Scan capture source -> " +
        `${screenshot.sourceType}: ${screenshot.sourceName || screenshot.sourceId || "unknown"} ` +
        `(display:${screenshot.sourceDisplayId || "n/a"}) ` +
        `frame=${frame ? `${frame.width}x${frame.height}` : "unknown"} ` +
        `uiScale=${uiScale}`,
    );
    return { screenshot, captureMs };
  } catch (err) {
    log.error("[RewardScanner] captureScreen error:", normalizeErrorMessage(err));
    return { screenshot: null, captureMs: Date.now() - captureStart };
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
  await yieldToEventLoop();
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
      await yieldToEventLoop();
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

  const { screenshot, captureMs } = await captureRewardScreen(
    preCapture,
    settings.warframeUiScale ?? REFERENCE_WARFRAME_UI_SCALE,
  );
  if (!screenshot) return null;

  const guardsStartedAt = Date.now();
  // Never a reason to skip - the titles sit well above the console and the matcher
  // rejects stray chat text. Kept so an empty scan can say why instead of blaming OCR.
  const consoleOpen = detectConsoleOpen(screenshot.image);
  if (consoleOpen) log.info("[RewardScanner] Chat console detected - scanning anyway");

  const frameHash = computeFrameHash(
    screenshot.image,
    settings.warframeUiScale ?? REFERENCE_WARFRAME_UI_SCALE,
  );
  const cacheKey = frameHash
    ? `${frameHash}:${settings.warframeUiScale ?? REFERENCE_WARFRAME_UI_SCALE}`
    : null;
  if (
    cacheKey &&
    cacheKey === _lastFrameHash &&
    _lastFrameResult &&
    Date.now() - _lastFrameHashTs < REWARD_FRAME_DEDUP_TTL_MS
  ) {
    log.info("[RewardScanner] Frame unchanged - returning cached result");
    return _lastFrameResult;
  }

  const guardsMs = Date.now() - guardsStartedAt;

  // Primary path: per-slot OCR over detected reward layouts.
  const slotStats: SlotScanStats = {
    layoutCount: 0,
    cardCount: 0,
    layoutMs: 0,
    ocrMs: 0,
    ocrReads: 0,
    layoutsTried: 0,
  };
  const slotsStartedAt = Date.now();
  const slotResult = await scanRewardSlotsFallback(
    screenshot,
    MAX_REWARD_SLOTS,
    totalBudgetMs,
    scanStartedAt,
    {
      sortedItems,
      ocrTimeoutMs: settings.ocrTimeoutMs,
      runOCRStructuredBuffer,
      reader,
      warframeUiScale: settings.warframeUiScale,
      stats: slotStats,
    },
  );

  const slotsMs = Date.now() - slotsStartedAt;
  let fallbackMs = 0;

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
    const fallbackStartedAt = Date.now();
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
    fallbackMs = Date.now() - fallbackStartedAt;
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

  const frameSize = screenshot.image?.getSize?.() || { width: 0, height: 0 };
  log.info(
    `[RewardScanner] timing capture=${captureMs}ms guards=${guardsMs}ms ` +
      `layout=${slotStats.layoutMs}ms(${slotStats.layoutsTried}/${slotStats.layoutCount} tried, cards=${slotStats.cardCount}) ` +
      `slots=${slotsMs}ms(${slotStats.ocrReads} reads, ocr ${slotStats.ocrMs}ms) ` +
      `fallback=${fallbackMs}ms total=${Date.now() - scanStartedAt}ms ` +
      `frame=${frameSize.width}x${frameSize.height}`,
  );

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
      layoutCount: slotStats.layoutCount,
      slotCount: slotResult?.slotCount ?? 0,
      cardCount: slotStats.cardCount,
    }),
  };

  // An empty result is not cached: the trigger loop counts empty attempts to
  // decide it is not the reward screen, and instant cache hits would spend
  // those attempts before the cards had a chance to render.
  if (items.length > 0) cacheFrameResult(cacheKey, result);
  return result;
}
