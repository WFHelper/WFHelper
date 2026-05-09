/**
 * Reward scanner public surface and runtime wiring.
 *
 * The heavy scan steps are split into cohesive stage modules:
 *   - rewardScannerPipeline.ts  (capture, guard, dedup, stage orchestration, telemetry)
 *   - rewardScannerSlotScan.ts  (slot-first OCR and unique reward assignment)
 *   - rewardScannerBandScan.ts  (band OCR passes and pass scoring)
 *   - rewardScannerEra.ts       (relic selection era OCR)
 */

import { withScope } from "./logger";
import { createRewardOcrRunner } from "./rewardScannerOcr";
import { CROP_PRESETS, SCANNER_TUNING } from "./rewardScannerSupport";
import { detectRelicSelectionEra as detectRelicSelectionEraWithOcr } from "./rewardScannerEra";
import {
  resetFrameDedup,
  runRewardScanPipeline,
  type PreCaptureResult,
  type RewardScanSettings,
} from "./rewardScannerPipeline";
import type { SortedItem } from "./rewardScannerMatch";

export { captureSourceMeta } from "./rewardScannerCapture";
export { getAdaptiveStrategyHint } from "./rewardScannerSupport";
export { resetFrameDedup };

const log = withScope("rewardScanner");

const REWARD_SCAN_SETTINGS: RewardScanSettings = Object.freeze({
  cropPreset: "balanced",
  ocrPasses: 2,
  matchThreshold: 0.74,
  ocrTimeoutMs: 15_000,
});

const { runOCR, runOCRBuffer, runOCRStructuredBuffer } = createRewardOcrRunner({
  log,
  getRequestedEngine: () => "windows",
  ocrScriptPath: SCANNER_TUNING.paths.ocrScript,
  engineWindows: "windows",
});

let relicItems: SortedItem[] = [];
let sortedItems: SortedItem[] = [];

function getBandsForPasses(
  presetName: string,
  passes: number,
): Array<{ top: number; height: number }> {
  const preset = CROP_PRESETS[presetName] || CROP_PRESETS.balanced;
  const bands: Array<{ top: number; height: number }> = [];
  for (let i = 0; i < passes; i += 1) {
    bands.push(preset[i % preset.length]);
  }
  return bands;
}

export function setRelicItems(items: SortedItem[]): void {
  relicItems = Array.isArray(items) ? items : [];
  sortedItems = [...relicItems].sort((a, b) => b.name.length - a.name.length);
  log.log(`[RewardScanner] Item list updated: ${relicItems.length} items`);
}

export function detectRelicSelectionEra(
  options: { timeoutMs?: number; preferredDisplayId?: string | null } = {},
): ReturnType<typeof detectRelicSelectionEraWithOcr> {
  return detectRelicSelectionEraWithOcr(options, { runOCR, runOCRBuffer }, REWARD_SCAN_SETTINGS);
}

export async function scanRewardsDetailed(preCapture?: PreCaptureResult | null): Promise<{
  items: SortedItem[];
  meta: Record<string, unknown>;
} | null> {
  if (sortedItems.length === 0) {
    log.warn("[RewardScanner] No relic items loaded - call setRelicItems() first");
    return null;
  }

  return runRewardScanPipeline({
    preCapture,
    sortedItems,
    settings: REWARD_SCAN_SETTINGS,
    getBandsForPasses,
    runOCRStructuredBuffer,
  });
}
