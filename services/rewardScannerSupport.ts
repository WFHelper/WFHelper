import os from "os";
import path from "path";
import type { NativeImage } from "electron";

import { REWARD_STRATEGY_HISTORY_TTL_MS } from "../config/runtime/cacheConfig";
import { MAX_REWARD_SLOTS, type SortedItem } from "./rewardScannerMatch";
import { luminanceFromBgr } from "./rewardScannerUtils";

export type RewardBand = { top: number; height: number };

export const SCANNER_TUNING = Object.freeze({
  paths: Object.freeze({
    ocrScript: path.join(__dirname, "..", "scripts", "ocr.ps1"),
    tempImage: path.join(os.tmpdir(), "wf-companion-reward-ocr.png"),
  }),
  budget: Object.freeze({
    // Enough for one structured-OCR pass on slower machines.
    minMs: 1800,
    // Keeps the overlay responsive instead of waiting on diminishing OCR passes.
    maxMs: 5000,
  }),
  temporal: Object.freeze({
    // Reward screens are short-lived; 12s spans one screen without bleeding far into the next run.
    windowMs: 12_000,
    maxResults: 5,
  }),
  lowInfoCrop: Object.freeze({
    // Sample roughly a 40x40 grid and skip crops whose luminance barely changes.
    sampleGrid: 40,
    minLuminanceRange: 18,
  }),
  strategy: Object.freeze({
    historyMax: 10,
  }),
  slot: Object.freeze({
    minLayoutConfidence: 0.38,
    partialAcceptFillRatio: 0.75,
    partialAcceptElapsedRatio: 0.7,
  }),
  ocr: Object.freeze({
    textPreviewMaxChars: 240,
  }),
});

export const RELIC_ERA_BANDS: ReadonlyArray<RewardBand> = Object.freeze([
  { top: 0.12, height: 0.12 },
  { top: 0.16, height: 0.13 },
  { top: 0.2, height: 0.14 },
]);

export const RELIC_ROW_TILE_LABEL_RECTS: ReadonlyArray<{
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}> = Object.freeze([
  { id: "slot-1", x: 0.02, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-2", x: 0.2, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-3", x: 0.38, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-4", x: 0.56, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-5", x: 0.74, y: 0.5, width: 0.18, height: 0.42 },
]);

export const CROP_PRESETS: Readonly<Record<string, ReadonlyArray<RewardBand>>> = Object.freeze({
  balanced: Object.freeze([
    { top: 0.38, height: 0.36 },
    { top: 0.36, height: 0.4 },
    { top: 0.4, height: 0.34 },
  ]),
});

interface StrategyWin {
  bandIndex: number;
  variantId: string;
  score: number;
  timestamp: number;
}

const strategyHistory: StrategyWin[] = [];

export function recordStrategyWin(bandIndex: number, variantId: string, score: number): void {
  strategyHistory.push({ bandIndex, variantId, score, timestamp: Date.now() });
  if (strategyHistory.length > SCANNER_TUNING.strategy.historyMax) {
    strategyHistory.shift();
  }
}

export function getAdaptiveStrategyHint(): { bandIndex: number; variantId: string } | null {
  const now = Date.now();
  const recent = strategyHistory.filter(
    (win) => now - win.timestamp < REWARD_STRATEGY_HISTORY_TTL_MS,
  );
  if (recent.length < 2) return null;

  const bandCounts = new Map<number, number>();
  const variantCounts = new Map<string, number>();
  for (const win of recent) {
    bandCounts.set(win.bandIndex, (bandCounts.get(win.bandIndex) || 0) + 1);
    variantCounts.set(win.variantId, (variantCounts.get(win.variantId) || 0) + 1);
  }

  let bestBand = -1;
  let bestBandCount = 0;
  for (const [band, count] of bandCounts) {
    if (count > bestBandCount) {
      bestBand = band;
      bestBandCount = count;
    }
  }

  let bestVariant = "raw";
  let bestVariantCount = 0;
  for (const [variant, count] of variantCounts) {
    if (count > bestVariantCount) {
      bestVariant = variant;
      bestVariantCount = count;
    }
  }

  return bestBand >= 0 ? { bandIndex: bestBand, variantId: bestVariant } : null;
}

interface TemporalEntry {
  items: SortedItem[];
  expectedCount: number;
  ts: number;
}

const recentScanEntries: TemporalEntry[] = [];

export function recordTemporalEntry(items: SortedItem[], expectedCount: number): void {
  recentScanEntries.push({ items: items.slice(), expectedCount, ts: Date.now() });
  while (recentScanEntries.length > SCANNER_TUNING.temporal.maxResults) recentScanEntries.shift();
}

export function findTemporalFallback(
  items: SortedItem[],
  expectedCount: number,
): SortedItem[] | null {
  if (items.length >= expectedCount) return null;
  const now = Date.now();
  const recent = recentScanEntries.filter(
    (entry) =>
      now - entry.ts < SCANNER_TUNING.temporal.windowMs && entry.items.length >= expectedCount,
  );
  if (recent.length < 2) return null;
  return recent[recent.length - 1].items;
}

export function hasSufficientTextureForOcr(nativeImage: NativeImage): boolean {
  try {
    const { width, height } = nativeImage.getSize();
    const bitmap: Buffer = nativeImage.toBitmap();
    const step = Math.max(
      1,
      Math.floor(Math.max(width, height) / SCANNER_TUNING.lowInfoCrop.sampleGrid),
    );
    let minLum = 255;
    let maxLum = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const idx = (y * width + x) * 4;
        const lum = luminanceFromBgr(bitmap[idx], bitmap[idx + 1], bitmap[idx + 2]);
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
        if (maxLum - minLum >= SCANNER_TUNING.lowInfoCrop.minLuminanceRange) return true;
      }
    }
    return maxLum - minLum >= SCANNER_TUNING.lowInfoCrop.minLuminanceRange;
  } catch {
    return true;
  }
}

export interface RewardSlotLayoutSummary {
  count: number;
  confidence: number;
}

export function hasConfidentSlotLayout(layout: RewardSlotLayoutSummary): boolean {
  return layout.count >= 2 && layout.confidence >= SCANNER_TUNING.slot.minLayoutConfidence;
}

export function expectedRewardItemCount(layout: RewardSlotLayoutSummary): number {
  return hasConfidentSlotLayout(layout)
    ? Math.min(layout.count, MAX_REWARD_SLOTS)
    : MAX_REWARD_SLOTS;
}

export function shouldAcceptPartialSlotResult({
  itemCount,
  expectedCount,
  elapsedRatio,
}: {
  itemCount: number;
  expectedCount: number;
  elapsedRatio: number;
}): boolean {
  return (
    itemCount >= Math.ceil(expectedCount * SCANNER_TUNING.slot.partialAcceptFillRatio) &&
    (elapsedRatio >= SCANNER_TUNING.slot.partialAcceptElapsedRatio || itemCount === expectedCount)
  );
}
