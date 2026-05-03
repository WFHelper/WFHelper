/**
 * Reward scanner public surface.
 *
 * The scan pipeline lives in rewardScannerPipeline.ts; this file stays small so callers have a
 * stable import target while the capture, OCR, consensus, and telemetry stages remain reviewable.
 */

export { captureSourceMeta } from "./rewardScannerCapture";
export { getAdaptiveStrategyHint } from "./rewardScannerSupport";
export {
  detectRelicSelectionEra,
  resetFrameDedup,
  scanRewardsDetailed,
  setRelicItems,
  waitForRewardUiReady,
} from "./rewardScannerPipeline";
