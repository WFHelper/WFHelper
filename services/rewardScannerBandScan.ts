import type { NativeImage } from "electron";

import { normalizeErrorMessage } from "../config/shared/errors";
import { withScope } from "./logger";
import { buildOcrVariants, cropRewardBand } from "./rewardScannerImage";
import {
  chooseBetterOcrPass,
  matchItemsDetailed,
  type PassResult,
  type SortedItem,
} from "./rewardScannerMatch";
import { hasSufficientTextureForOcr } from "./rewardScannerSupport";
import { extractRewardTitleTexts, type StructuredOcrBufferRunner } from "./rewardScannerSlotScan";

const log = withScope("rewardScanner");

export async function scanRewardBandPasses({
  screenshot,
  bands,
  expectedItemCount,
  totalBudgetMs,
  scanStartedAt,
  threshold,
  sortedItems,
  ocrTimeoutMs,
  runOCRStructuredBuffer,
}: {
  screenshot: { image: NativeImage };
  bands: Array<{ top: number; height: number }>;
  expectedItemCount: number;
  totalBudgetMs: number;
  scanStartedAt: number;
  threshold: number;
  sortedItems: SortedItem[];
  ocrTimeoutMs: number;
  runOCRStructuredBuffer: StructuredOcrBufferRunner;
}): Promise<{
  hadOcrSuccess: boolean;
  passResults: PassResult[];
  bestPass: PassResult | null;
  ocrCallCount: number;
  ocrTotalMs: number;
}> {
  let hadOcrSuccess = false;
  const passResults: PassResult[] = [];
  let bestPass: PassResult | null = null;
  let ocrCallCount = 0;
  let ocrTotalMs = 0;

  for (let i = 0; i < bands.length; i += 1) {
    if (Date.now() - scanStartedAt >= totalBudgetMs) {
      log.info(`[RewardScanner] scan budget exhausted before pass ${i + 1}/${bands.length}`);
      break;
    }

    let cropped: NativeImage;
    try {
      cropped = cropRewardBand(screenshot.image, bands[i]);
    } catch (err) {
      log.error(`[RewardScanner] crop/write failed on pass ${i + 1}:`, normalizeErrorMessage(err));
      continue;
    }

    let passResult: PassResult | null = null;
    const variants = buildOcrVariants(cropped);

    for (const variant of variants) {
      const elapsed = Date.now() - scanStartedAt;
      const remainingBudgetMs = totalBudgetMs - elapsed;
      if (remainingBudgetMs <= 0) {
        log.info(`[RewardScanner] scan budget exhausted before OCR on pass ${i + 1}`);
        break;
      }

      if (!hasSufficientTextureForOcr(variant.image)) {
        log.info(`[RewardScanner] Skipping low-texture crop (pass ${i + 1} ${variant.id})`);
        continue;
      }

      let matched: ReturnType<typeof matchItemsDetailed> | null = null;
      let ocrTextForLog: string;
      try {
        const pngBuf = variant.image.toPNG();
        const ocrStart = Date.now();
        const structured = await runOCRStructuredBuffer(
          pngBuf,
          Math.max(700, Math.min(ocrTimeoutMs, remainingBudgetMs)),
        );
        ocrTotalMs += Date.now() - ocrStart;
        ocrCallCount++;
        hadOcrSuccess = true;
        const candidateTexts = extractRewardTitleTexts(structured);
        ocrTextForLog = structured.text || "";
        for (const ctext of candidateTexts) {
          const nextMatch = matchItemsDetailed(ctext, threshold, sortedItems);
          if (!matched || nextMatch.score > matched.score) matched = nextMatch;
        }
        if (!matched) matched = matchItemsDetailed(structured.text || "", threshold, sortedItems);
      } catch (err) {
        log.error(
          `[RewardScanner] OCR failed on pass ${i + 1} (${variant.id}):`,
          normalizeErrorMessage(err),
        );
        continue;
      }

      const candidate = {
        ...matched,
        passIndex: i + 1,
        band: bands[i],
        text: ocrTextForLog,
        ocrVariant: variant.id,
      };

      passResult = chooseBetterOcrPass(passResult, candidate);

      if (matched.items.length >= expectedItemCount && matched.exactCount >= expectedItemCount) {
        break;
      }
    }

    if (!passResult) continue;

    passResults.push(passResult);
    if (!bestPass || passResult.score > bestPass.score) {
      bestPass = passResult;
    }

    if (
      passResult.items.length >= expectedItemCount &&
      passResult.exactCount >= expectedItemCount
    ) {
      break;
    }
  }

  return { hadOcrSuccess, passResults, bestPass, ocrCallCount, ocrTotalMs };
}
