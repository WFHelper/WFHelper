"use strict";

/**
 * OCR scanning for the riven rolling screen.
 *
 * Scanning strategy:
 *  1. Session opens -> scanInitialCard() - OCR the centered single card
 *  2. Roll confirmed -> scanNewRoll() - OCR only the RIGHT panel (new roll)
 *
 * The left panel (current/old stats) is never scanned - we already know those
 * stats from step 1 or from the previous roll cycle.
 */

import path from "node:path";
import { withScope } from "../../services/logger";
import { captureScreen } from "../../services/rewardScannerCapture";
import { cropRect } from "../../services/rewardScannerImage";
import { createRewardOcrRunner } from "../../services/rewardScannerOcr";
import { sleep } from "../../services/rewardScannerUtils";
import {
  abortRivenScanWaits,
  computeRivenFrameHash,
  cropAbsolute,
  deriveRivenRegions,
  enhanceForRivenOcr,
  refineRivenTextCrop,
  resetRivenScanWaits,
  waitForRivenUiReady,
  type EnhanceMode,
} from "./rivenScanImage";
import {
  extractSignAndValue,
  parseRivenStats,
  preprocessOcrText,
  sanitiseValue,
  scoreStatsCandidate,
  splitRivenStructuredText,
  type RivenStat,
} from "./rivenScanText";

export { parseRivenStats };
export type { RivenStat } from "./rivenScanText";

const log = withScope("rivenScan");

// __dirname at runtime is .electron-build/ipc/overlay/ - three levels up to reach project root
const OCR_SCRIPT = path.join(__dirname, "..", "..", "..", "scripts", "ocr.ps1");
const OCR_TIMEOUT_MS = 8000;
const MIN_ACCEPTABLE_RIVEN_STATS = 2;

// Display ID pinning: set from the initial card scan so all subsequent
// captures (roll, choice) use the same monitor as the initial capture.
let _rivenDisplayId: string | null = null;

const ocrRunner = createRewardOcrRunner({
  log,
  ocrScriptPath: OCR_SCRIPT,
  getRequestedEngine: () => "native",
});

const ENHANCE_STRATEGIES: readonly EnhanceMode[] = Object.freeze([
  { kind: "original" },
  { kind: "bright", threshold: 150, dilate: true },
]);

// Initial / choice scan: single centred card covers x 0.22–0.78.
const SINGLE_CARD_CROP = { x: 0.22, y: 0.43, width: 0.56, height: 0.45 };

// Roll scan: crop around the new-roll card (RIGHT card in the two-panel roll view).
// Brightness analysis of corpus images confirms the new card sits at x≈819-1104 (43-57%).
// Using x=0.38 (729px) gives a left margin before the card edge and avoids the stats
// text area of the old left card (which ends around x=780).
// Ending at x=0.64 (1229px) covers the full card with room to spare.
// y=0.35-0.80 covers the card title, stats rows, and MR/roll counter.
const ROLL_CARD_CROP = { x: 0.38, y: 0.35, width: 0.26, height: 0.45 };

export interface RollPanelResult {
  left: RivenStat[];
  right: RivenStat[];
}

export interface InitialScanResult {
  stats: RivenStat[];
  rawText: string;
  titleText: string;
  footerText: string;
}

interface CandidateResult {
  text: string;
  titleText: string;
  footerText: string;
  stats: RivenStat[];
  score: number;
  cropId: string;
  refined: boolean;
  valueCount: number;
  modeLabel: string;
}

function buildOrderedCandidates(
  hasRefinedCrop: boolean,
): Array<{ cropId: "rough" | "refined"; mode: EnhanceMode }> {
  const ordered: Array<{ cropId: "rough" | "refined"; mode: EnhanceMode }> = [];
  for (const mode of ENHANCE_STRATEGIES) {
    ordered.push({ cropId: "rough", mode });
    if (hasRefinedCrop) ordered.push({ cropId: "refined", mode });
  }
  return ordered;
}

function isConfidentEnough(result: CandidateResult): boolean {
  if (result.score < 0) return false;
  if (result.stats.length >= 4 && result.valueCount >= 3 && result.score >= 75) return true;
  if (result.stats.length >= 3 && result.valueCount >= 3 && result.score >= 85) return true;
  if (result.stats.length === 2 && result.valueCount === 2 && result.score >= 55) return true;
  return false;
}

async function retrySparseRivenScan<T>(
  attemptLabel: string,
  currentStats: RivenStat[],
  retryDelayMs: number,
  runRetry: () => Promise<T>,
  getStats: (value: T) => RivenStat[],
): Promise<T | null> {
  if (currentStats.length >= MIN_ACCEPTABLE_RIVEN_STATS) return null;
  log.log(
    `[RivenScan] ${attemptLabel}: sparse result (${currentStats.length} stats), retrying in ${retryDelayMs}ms`,
  );
  await sleep(retryDelayMs);
  const retried = await runRetry();
  const retriedStats = getStats(retried);
  if (retriedStats.length > currentStats.length) {
    log.log(`[RivenScan] ${attemptLabel}: retry improved to ${retriedStats.length} stats`);
    return retried;
  }
  return null;
}

async function runStructuredRegion(
  imageRegion: any,
  mode: EnhanceMode,
): Promise<{
  text: string;
  titleText: string;
  footerText: string;
  statsText: string;
}> {
  const enhanced = await enhanceForRivenOcr(imageRegion, mode);
  const structured = await ocrRunner.runOCRStructuredBuffer(enhanced, OCR_TIMEOUT_MS);
  const split = splitRivenStructuredText(structured);
  return {
    text: split.mergedText || structured.text || "",
    titleText: split.titleText || "",
    footerText: split.footerText || "",
    statsText: split.statsText || structured.text || "",
  };
}

async function ocrCropMultiStrategy(
  image: any,
  rect: { x: number; y: number; width: number; height: number },
  label = "",
  expectedWeaponName = "",
): Promise<{ text: string; titleText: string; footerText: string; stats: RivenStat[] }> {
  const roughCrop = cropRect(image, rect);
  const refined = refineRivenTextCrop(roughCrop);
  const cropVariants = [{ id: "rough", image: roughCrop, refined: false, metrics: refined.metrics }];
  if (refined.refined && refined.metrics.coverage < 0.25) {
    cropVariants.push({
      id: "refined",
      image: refined.image,
      refined: true,
      metrics: refined.metrics,
    });
  }

  if (label) {
    for (const variant of cropVariants) {
      const size = variant.image.getSize?.() ?? { width: 0, height: 0 };
      log.log(
        `[RivenScan] ${label} crop ${variant.id}: score=${variant.metrics.score.toFixed(3)} ` +
          `coverage=${variant.metrics.coverage.toFixed(4)} rows=${variant.metrics.activeRows} cols=${variant.metrics.activeCols} ` +
          `size=${size.width}x${size.height}`,
      );
    }
  }

  const orderedCandidates = buildOrderedCandidates(
    cropVariants.some((variant) => variant.id === "refined"),
  );
  const results: CandidateResult[] = [];

  for (const plan of orderedCandidates) {
    const cropVariant = cropVariants.find((variant) => variant.id === plan.cropId);
    if (!cropVariant) continue;

    const modeLabel =
      plan.mode.kind === "original"
        ? `${cropVariant.id}:original`
        : `${cropVariant.id}:bright-${plan.mode.threshold}${plan.mode.dilate ? "+dilate" : ""}`;

    let result: CandidateResult;
    try {
      const enhancedPng = await enhanceForRivenOcr(cropVariant.image, plan.mode);
      const structured = await ocrRunner.runOCRStructuredBuffer(enhancedPng, OCR_TIMEOUT_MS);
      const split = splitRivenStructuredText(structured);

      let mergedText = split.mergedText || structured.text || "";
      let titleText = split.titleText || "";
      let footerText = split.footerText || "";
      let stats = parseRivenStats(split.statsText || structured.text || "");

      if (cropVariant.metrics.bounds && (stats.length < 2 || !titleText)) {
        try {
          const regions = deriveRivenRegions(cropVariant.image, cropVariant.metrics.bounds);
          const statsRegion = await runStructuredRegion(
            cropAbsolute(cropVariant.image, regions.stats),
            plan.mode,
          );
          const titleRegion = !titleText
            ? await runStructuredRegion(cropAbsolute(cropVariant.image, regions.title), plan.mode)
            : null;
          const footerRegion = footerText
            ? null
            : await runStructuredRegion(cropAbsolute(cropVariant.image, regions.footer), plan.mode);
          const regionTitle = titleText || titleRegion?.text || "";
          const regionFooter = footerText || footerRegion?.text || "";
          const regionStats = parseRivenStats(statsRegion.statsText || statsRegion.text || "");
          if (regionStats.length > stats.length) {
            stats = regionStats;
            titleText = regionTitle || titleText;
            footerText = regionFooter || footerText;
            mergedText = [titleText, statsRegion.text, footerText].filter(Boolean).join("\n");
          }
          if (!titleText && regionTitle) titleText = regionTitle;
          if (!footerText && regionFooter) footerText = regionFooter;
          if (titleText || footerText) {
            mergedText = [titleText, statsRegion.text || mergedText, footerText]
              .filter(Boolean)
              .join("\n");
          }
        } catch {
          // Region OCR is an optional refinement path.
        }
      }

      result = {
        text: mergedText,
        titleText,
        footerText,
        stats,
        score: scoreStatsCandidate(stats, mergedText, expectedWeaponName, titleText),
        cropId: cropVariant.id,
        refined: cropVariant.refined,
        valueCount: stats.filter((stat) => stat.value !== null).length,
        modeLabel,
      };
    } catch {
      result = {
        text: "",
        titleText: "",
        footerText: "",
        stats: [],
        score: -1,
        cropId: cropVariant.id,
        refined: cropVariant.refined,
        valueCount: 0,
        modeLabel,
      };
    }

    if (label) {
      const preview = result.text.replace(/\r?\n/g, " | ").slice(0, 150);
      log.log(
        `[RivenScan] OCR ${label} ${result.modeLabel}: ${result.stats.length} stats (score=${result.score}) "${preview}"`,
      );
    }

    results.push(result);
    if (isConfidentEnough(result)) {
      if (label) {
        log.log(
          `[RivenScan] early-accept ${label} candidate crop=${result.cropId} refined=${result.refined} ` +
            `score=${result.score} stats=${result.stats.length} values=${result.valueCount}`,
        );
      }
      return {
        text: result.text,
        titleText: result.titleText,
        footerText: result.footerText,
        stats: result.stats,
      };
    }
  }

  let best: CandidateResult | null = null;
  for (const result of results) {
    if (!best) {
      best = result;
      continue;
    }
    if (result.score > best.score) {
      best = result;
      continue;
    }
    if (result.score < best.score) continue;
    if (result.stats.length > best.stats.length) {
      best = result;
      continue;
    }
    if (result.stats.length < best.stats.length) continue;
    if (result.valueCount > best.valueCount) {
      best = result;
      continue;
    }
    if (result.valueCount < best.valueCount) continue;
    if (result.refined && !best.refined) {
      best = result;
      continue;
    }
    if (!result.refined && best.refined) continue;
    if (result.text.length > best.text.length) {
      best = result;
    }
  }

  const chosen =
    best ?? {
      text: "",
      titleText: "",
      footerText: "",
      stats: [],
      score: -1,
      cropId: "",
      refined: false,
      valueCount: 0,
      modeLabel: "",
    };

  if (label) {
    log.log(
      `[RivenScan] chose ${label} candidate crop=${chosen.cropId || "unknown"} refined=${chosen.refined} ` +
        `score=${chosen.score} stats=${chosen.stats.length} values=${chosen.valueCount}`,
    );
  }

  return {
    text: chosen.text,
    titleText: chosen.titleText,
    footerText: chosen.footerText,
    stats: chosen.stats,
  };
}

export function abortRivenScans(): void {
  abortRivenScanWaits();
}

export function resetRivenScanAbort(): void {
  resetRivenScanWaits();
}

export async function scanInitialCard(expectedWeaponName = ""): Promise<InitialScanResult> {
  const ready = await waitForRivenUiReady(SINGLE_CARD_CROP, "initial");
  if (!ready.ready) {
    log.log(
      `[RivenScan] initial UI gate timed out after ${ready.elapsedMs}ms (${ready.attempts} samples, best=${ready.bestScore.toFixed(3)})`,
    );
  }

  const capture = ready.screenshot || (await captureScreen());
  if (!capture) {
    log.warn("[RivenScan] scanInitialCard: captureScreen returned null");
    return { stats: [], rawText: "", titleText: "", footerText: "" };
  }

  if (capture.sourceDisplayId && capture.sourceDisplayId !== _rivenDisplayId) {
    _rivenDisplayId = capture.sourceDisplayId;
    log.log(`[RivenScan] pinned to display id=${_rivenDisplayId}`);
  }

  const imgSize = capture.image.getSize?.() ?? { width: "?", height: "?" };
  let frameHash = ready.frameHash;
  if (!frameHash) {
    try {
      frameHash = computeRivenFrameHash(cropRect(capture.image, SINGLE_CARD_CROP));
    } catch {
      frameHash = "";
    }
  }
  log.log(
    `[RivenScan] initial capture: source=${capture.sourceType} name="${capture.sourceName}" size=${imgSize.width}x${imgSize.height}`,
  );

  try {
    let result = await ocrCropMultiStrategy(
      capture.image,
      SINGLE_CARD_CROP,
      "initial-card",
      expectedWeaponName,
    );
    const retry = await retrySparseRivenScan(
      "initial-card",
      result.stats,
      650,
      async () => {
        const retryCapture = await captureScreen({ preferredDisplayId: _rivenDisplayId });
        if (!retryCapture) return result;
        try {
          const retryHash = computeRivenFrameHash(cropRect(retryCapture.image, SINGLE_CARD_CROP));
          if (retryHash && retryHash === frameHash) {
            log.log("[RivenScan] initial-card-retry skipped identical frame hash");
            return result;
          }
        } catch {
          // Ignore hash errors.
        }
        return ocrCropMultiStrategy(
          retryCapture.image,
          SINGLE_CARD_CROP,
          "initial-card-retry",
          expectedWeaponName,
        );
      },
      (value) => value.stats,
    );
    if (retry) result = retry;

    const { stats, text, titleText, footerText } = result;
    log.log(
      `[RivenScan] initial card scan: ${stats.length} stats found`,
      stats.map((stat) => `${stat.positive ? "+" : "-"}${stat.value ?? "?"}% ${stat.name}`).join(", "),
    );
    return { stats, rawText: text, titleText, footerText };
  } catch (err) {
    log.warn("[RivenScan] initial card OCR failed:", String(err));
    return { stats: [], rawText: "", titleText: "", footerText: "" };
  }
}

export async function scanNewRoll(expectedWeaponName = "", skipGate = false): Promise<RollPanelResult> {
  const startAt = Date.now();
  let capture: Awaited<ReturnType<typeof captureScreen>>;
  let frameHash = "";
  if (skipGate) {
    // Diorama-triggered path: both cards are confirmed loaded, skip stability
    // polling and capture directly.  Matches AlecaFrame’s immediate-screenshot
    // behaviour on OmegaRerollSelection.lua: Diorama setup.
    capture = await captureScreen({ preferredDisplayId: _rivenDisplayId });
    if (!capture) {
      log.warn("[RivenScan] scanNewRoll: captureScreen returned null");
      return { left: [], right: [] };
    }
  } else {
    const ready = await waitForRivenUiReady(ROLL_CARD_CROP, "roll", _rivenDisplayId);
    if (!ready.ready) {
      log.log(
        `[RivenScan] roll UI gate timed out after ${ready.elapsedMs}ms (${ready.attempts} samples, best=${ready.bestScore.toFixed(3)})`,
      );
    }
    capture = ready.screenshot || (await captureScreen({ preferredDisplayId: _rivenDisplayId }));
    if (!capture) {
      log.warn("[RivenScan] scanNewRoll: captureScreen returned null");
      return { left: [], right: [] };
    }
    frameHash = ready.frameHash;
  }
  if (!frameHash) {
    try {
      frameHash = computeRivenFrameHash(cropRect(capture.image, ROLL_CARD_CROP));
    } catch {
      frameHash = "";
    }
  }
  const imgSize = capture.image.getSize?.() ?? { width: "?", height: "?" };
  log.log(
    `[RivenScan] roll capture: source=${capture.sourceType} name="${capture.sourceName}" size=${imgSize.width}x${imgSize.height}`,
  );

  try {
    let rightResult = await ocrCropMultiStrategy(
      capture.image,
      ROLL_CARD_CROP,
      "roll-right",
      expectedWeaponName,
    );
    log.log(
      `[RivenScan] roll scan: right=${rightResult.stats.length} stats, elapsed=${Date.now() - startAt}ms`,
    );

    if (rightResult.stats.length < MIN_ACCEPTABLE_RIVEN_STATS) {
      await sleep(800);
      const retryCapture = await captureScreen({ preferredDisplayId: _rivenDisplayId });
      if (retryCapture) {
        try {
          const retryHash = computeRivenFrameHash(cropRect(retryCapture.image, ROLL_CARD_CROP));
          if (retryHash && retryHash === frameHash) {
            log.log("[RivenScan] roll-right-retry skipped identical frame hash");
            return { left: [], right: rightResult.stats };
          }
        } catch {
          // Ignore hash errors.
        }

        const retryResult = await ocrCropMultiStrategy(
          retryCapture.image,
          ROLL_CARD_CROP,
          "roll-right-retry",
          expectedWeaponName,
        );
        log.log(
          `[RivenScan] roll-retry: right=${retryResult.stats.length} stats, elapsed=${Date.now() - startAt}ms`,
        );
        if (retryResult.stats.length >= rightResult.stats.length) {
          rightResult = retryResult;
        }
      }
    }

    return { left: [], right: rightResult.stats };
  } catch (err) {
    log.warn("[RivenScan] roll scan OCR failed:", String(err));
    return { left: [], right: [] };
  }
}

export async function scanChoiceRescan(expectedWeaponName = ""): Promise<RivenStat[]> {
  const ready = await waitForRivenUiReady(SINGLE_CARD_CROP, "choice", _rivenDisplayId);
  if (!ready.ready) {
    log.log(
      `[RivenScan] choice UI gate timed out after ${ready.elapsedMs}ms (${ready.attempts} samples, best=${ready.bestScore.toFixed(3)})`,
    );
  }

  const capture = ready.screenshot || (await captureScreen({ preferredDisplayId: _rivenDisplayId }));
  if (!capture) {
    log.warn("[RivenScan] scanChoiceRescan: captureScreen returned null");
    return [];
  }

  let frameHash = ready.frameHash;
  if (!frameHash) {
    try {
      frameHash = computeRivenFrameHash(cropRect(capture.image, SINGLE_CARD_CROP));
    } catch {
      frameHash = "";
    }
  }

  try {
    let result = await ocrCropMultiStrategy(
      capture.image,
      SINGLE_CARD_CROP,
      "choice-rescan",
      expectedWeaponName,
    );
    const retry = await retrySparseRivenScan(
      "choice-rescan",
      result.stats,
      500,
      async () => {
        const retryCapture = await captureScreen({ preferredDisplayId: _rivenDisplayId });
        if (!retryCapture) return result;
        try {
          const retryHash = computeRivenFrameHash(cropRect(retryCapture.image, SINGLE_CARD_CROP));
          if (retryHash && retryHash === frameHash) {
            log.log("[RivenScan] choice-rescan-retry skipped identical frame hash");
            return result;
          }
        } catch {
          // Ignore hash errors.
        }
        return ocrCropMultiStrategy(
          retryCapture.image,
          SINGLE_CARD_CROP,
          "choice-rescan-retry",
          expectedWeaponName,
        );
      },
      (value) => value.stats,
    );
    if (retry) result = retry;

    const { stats } = result;
    log.log(
      `[RivenScan] choice rescan: ${stats.length} stats found`,
      stats.map((stat) => `${stat.positive ? "+" : "-"}${stat.value ?? "?"}% ${stat.name}`).join(", "),
    );
    return stats;
  } catch (err) {
    log.warn("[RivenScan] choice rescan OCR failed:", String(err));
    return [];
  }
}

export const __test__ = Object.freeze({
  preprocessOcrText,
  sanitiseValue,
  extractSignAndValue,
  scoreStatsCandidate,
});
