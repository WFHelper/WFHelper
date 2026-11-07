import fs from "node:fs";
import { withScope } from "./logger";
import { createEraOcr, createRewardOcrRunner } from "./rewardScannerOcr";
import { recognizeRewardStripOnnx, rewardOcrOnnxAvailable } from "./rewardOcrOnnx";
import { SCANNER_TUNING } from "./rewardScannerSupport";
import { detectRelicSelectionEra as detectRelicSelectionEraWithOcr } from "./rewardScannerEra";
import {
  resetFrameDedup,
  runRewardScanPipeline,
  type PreCaptureResult,
  type RewardScanSettings,
} from "./rewardScannerPipeline";
import type { SortedItem } from "./rewardScannerMatch";
import { hasQuantityPrefix, stripQuantityPrefix } from "../config/shared/quantityPrefix";
import type { RewardReader } from "./rewardScannerSlotScan";
import { REFERENCE_WARFRAME_UI_SCALE } from "../config/runtime/overlaySettings";

export { captureSourceMeta } from "./screenCapture";
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

// The card prints the game-language name, so each localized reward also enters the
// pool under it; scan results are handed back under the English join key.
function gameLanguageAlias(item: SortedItem): SortedItem | null {
  const localized = item.displayName;
  if (typeof localized !== "string" || !localized || localized === item.name) return null;
  // DE drops the "2X" from "2X Forma Blueprint", which would collide with plain Forma.
  const count = item.name.slice(0, item.name.length - stripQuantityPrefix(item.name).length);
  const name = count && !hasQuantityPrefix(localized) ? `${count}${localized}` : localized;
  return { ...item, name, englishName: item.name };
}

function toEnglishName(item: SortedItem): SortedItem {
  if (typeof item.englishName !== "string") return item;
  const { englishName, ...rest } = item;
  return { ...rest, name: englishName };
}

export function setRelicItems(items: SortedItem[]): void {
  relicItems = Array.isArray(items) ? items : [];
  const aliases = relicItems.map(gameLanguageAlias).filter((item) => item !== null);
  sortedItems = [...relicItems, ...aliases].sort((a, b) => b.name.length - a.name.length);
  log.info(
    `[RewardScanner] Item list updated: ${relicItems.length} items, ${aliases.length} localized`,
  );
}

const eraOcr = createEraOcr({
  runOCR,
  runOCRBuffer,
  recognizeStrip: recognizeRewardStripOnnx,
  stripAvailable: rewardOcrOnnxAvailable,
  readFile: (imagePath) => fs.readFileSync(imagePath),
});

export function detectRelicSelectionEra(
  options: { timeoutMs?: number; preferredDisplayId?: string | null; labelOnly?: boolean } = {},
): ReturnType<typeof detectRelicSelectionEraWithOcr> {
  return detectRelicSelectionEraWithOcr(options, eraOcr, REWARD_SCAN_SETTINGS);
}

export async function scanRewardsDetailed(
  preCapture?: PreCaptureResult | null,
  scanOptions?: { reader?: RewardReader; warframeUiScale?: number },
): Promise<{
  items: SortedItem[];
  meta: Record<string, unknown>;
} | null> {
  if (sortedItems.length === 0) {
    log.warn("[RewardScanner] No relic items loaded - call setRelicItems() first");
    return null;
  }

  const result = await runRewardScanPipeline({
    preCapture,
    sortedItems,
    settings: {
      ...REWARD_SCAN_SETTINGS,
      warframeUiScale: scanOptions?.warframeUiScale ?? REFERENCE_WARFRAME_UI_SCALE,
    },
    runOCRStructuredBuffer,
    // Windows OCR does not exist off-Windows; pin the cross-platform onnx reader.
    reader: process.platform === "win32" ? scanOptions?.reader : "onnx",
  });
  return result && { ...result, items: result.items.map(toEnglishName) };
}
