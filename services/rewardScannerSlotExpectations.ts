import { MAX_REWARD_SLOTS } from "./rewardScannerMatch";
import { SCANNER_TUNING } from "./rewardScannerTuning";

export interface RewardSlotLayoutSummary {
  count: number;
  confidence: number;
}

export function hasConfidentSlotLayout(layout: RewardSlotLayoutSummary): boolean {
  return layout.count >= 2 && layout.confidence >= SCANNER_TUNING.slot.minLayoutConfidence;
}

export function expectedRewardItemCount(layout: RewardSlotLayoutSummary): number {
  return hasConfidentSlotLayout(layout) ? Math.min(layout.count, MAX_REWARD_SLOTS) : MAX_REWARD_SLOTS;
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
