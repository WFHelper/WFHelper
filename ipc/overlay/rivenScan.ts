/**
 * OCR scanning for the riven rolling screen.
 *
 * Scanning strategy:
 *  1. Session opens -> scanInitialCard() - OCR the centered single card
 *  2. Roll confirmed -> scanNewRoll() - centered crop with edge detection to isolate the card.
 *
 * At 2750ms after roll confirm, the game may still be transitioning from the
 * single new-card display to the two-panel diorama layout. The centered crop captures
 * whatever card is visible at that moment, and edge detection narrows to the text area.
 */

import type { NativeImage } from "electron";

import { withScope } from "../../services/logger";
import { captureScreenFast } from "../../services/rewardScannerCapture";
import { cropRect } from "../../services/rewardScannerImage";
import { sleep } from "../../services/rewardScannerUtils";
import {
  abortRivenScanWaits,
  computeRivenFrameHash,
  RIVEN_SCAN_CROPS,
  resetRivenScanWaits,
  type RivenScanCropRect,
  waitForRivenUiReady,
} from "./rivenScanImage";
import { recognizeRivenCardStats } from "./rivenScanOcr";
import {
  extractSignAndValue,
  parseRivenStats,
  preprocessOcrText,
  sanitiseValue,
  scoreStatsCandidate,
  type RivenStat,
} from "./rivenScanText";

export { parseRivenStats };
export type { RivenStat } from "./rivenScanText";

const log = withScope("rivenScan");

const MIN_ACCEPTABLE_RIVEN_STATS = 2;

// Display ID pinning: set from the initial card scan so all subsequent
// captures (roll, choice) use the same monitor as the initial capture.
let _rivenDisplayId: string | null = null;

// Abort flag: set by abortRivenScans() to cancel between-iteration OCR work.
let _ocrAborted = false;

// Scan generation counter: incremented at the start of every public scan entry
// (scanInitialCard / scanNewRoll). Inner loops capture their generation and abort
// early when the counter has moved on, preventing a slow scan from publishing
// stale results after a new scan has already started.
let _scanGeneration = 0;

const SINGLE_CARD_CROP = RIVEN_SCAN_CROPS.singleCard;
const ROLL_CARD_CROP = RIVEN_SCAN_CROPS.rollCard;

// GDI timeout hint for captures that MUST return a fresh frame (roll scans,
// choice re-scans). GDI BitBlt always returns the current framebuffer, so this
// is mainly a semantic marker passed through `captureScreenFast`.
const DXGI_FRESH_TIMEOUT_MS = 100;

export interface RollPanelResult {
  left: RivenStat[];
  right: RivenStat[];
}

interface InitialScanResult {
  stats: RivenStat[];
  rawText: string;
  titleText: string;
  footerText: string;
}

function isRivenScanStale(generation: number): boolean {
  return _ocrAborted || _scanGeneration !== generation;
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

async function scanRivenStatsFromImage(
  image: NativeImage,
  rect: RivenScanCropRect,
  label = "",
  captureMs = 0,
): Promise<{ text: string; titleText: string; footerText: string; stats: RivenStat[] }> {
  return recognizeRivenCardStats(image, rect, {
    label,
    captureMs,
    generation: _scanGeneration,
    isStale: isRivenScanStale,
  });
}

export function abortRivenScans(): void {
  _ocrAborted = true;
  abortRivenScanWaits();
}

export function resetRivenScanAbort(): void {
  _ocrAborted = false;
  resetRivenScanWaits();
  // OCR runner warms up on first call; no explicit warmup needed.
}

export async function scanInitialCard(_expectedWeaponName = ""): Promise<InitialScanResult> {
  ++_scanGeneration;
  const entryStart = Date.now();
  const ready = await waitForRivenUiReady(SINGLE_CARD_CROP, "initial");
  if (!ready.ready) {
    log.log(
      `[RivenScan] initial UI gate timed out after ${ready.elapsedMs}ms (${ready.attempts} samples, best=${ready.bestScore.toFixed(3)})`,
    );
  }

  const capture = ready.screenshot || (await captureScreenFast());
  const captureMs = Date.now() - entryStart;
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
    let result = await scanRivenStatsFromImage(
      capture.image,
      SINGLE_CARD_CROP,
      "initial-card",
      captureMs,
    );
    const retry = await retrySparseRivenScan(
      "initial-card",
      result.stats,
      650,
      async () => {
        const retryCapture = await captureScreenFast(_rivenDisplayId);
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
        return scanRivenStatsFromImage(retryCapture.image, SINGLE_CARD_CROP, "initial-card-retry");
      },
      (value) => value.stats,
    );
    if (retry) result = retry;

    const { stats, text, titleText, footerText } = result;
    log.log(
      `[RivenScan] initial card scan: ${stats.length} stats found`,
      stats
        .map((stat) => `${stat.positive ? "+" : "-"}${stat.value ?? "?"}% ${stat.name}`)
        .join(", "),
    );
    return { stats, rawText: text, titleText, footerText };
  } catch (err) {
    log.warn("[RivenScan] initial card OCR failed:", String(err));
    return { stats: [], rawText: "", titleText: "", footerText: "" };
  }
}

export async function scanNewRoll(
  expectedWeaponName = "",
  skipGate = true,
): Promise<RollPanelResult> {
  log.log(
    `[RivenScan] >>> scanNewRoll ENTERED (weapon="${expectedWeaponName}", skipGate=${skipGate})`,
  );
  ++_scanGeneration;
  const startAt = Date.now();
  const captureStart = Date.now();
  const capture = await captureScreenFast(_rivenDisplayId, DXGI_FRESH_TIMEOUT_MS);
  const rollCaptureMs = Date.now() - captureStart;
  if (!capture) {
    log.warn("[RivenScan] scanNewRoll: captureScreen returned null");
    return { left: [], right: [] };
  }
  let frameHash: string;
  try {
    frameHash = computeRivenFrameHash(cropRect(capture.image, ROLL_CARD_CROP));
  } catch {
    frameHash = "";
  }
  const imgSize = capture.image.getSize?.() ?? { width: "?", height: "?" };
  log.log(
    `[RivenScan] roll capture: source=${capture.sourceType} name="${capture.sourceName}" size=${imgSize.width}x${imgSize.height}`,
  );

  try {
    let rightResult = await scanRivenStatsFromImage(
      capture.image,
      ROLL_CARD_CROP,
      "roll-right",
      rollCaptureMs,
    );
    log.log(
      `[RivenScan] roll scan: right=${rightResult.stats.length} stats, elapsed=${Date.now() - startAt}ms`,
    );
    if (rightResult.stats.length < MIN_ACCEPTABLE_RIVEN_STATS) {
      await sleep(800);
      const retryCapture = await captureScreenFast(_rivenDisplayId, DXGI_FRESH_TIMEOUT_MS);
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

        const retryResult = await scanRivenStatsFromImage(
          retryCapture.image,
          ROLL_CARD_CROP,
          "roll-right-retry",
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

export async function scanChoiceRescan(_expectedWeaponName = ""): Promise<RivenStat[]> {
  // CHOICE_RESCAN_DELAY_MS has already elapsed, so capture immediately without
  // readiness polling. Use a non-zero DXGI timeout to force a fresh frame.
  const capture = await captureScreenFast(_rivenDisplayId, DXGI_FRESH_TIMEOUT_MS);
  if (!capture) {
    log.warn("[RivenScan] scanChoiceRescan: captureScreen returned null");
    return [];
  }

  let frameHash = "";
  try {
    frameHash = computeRivenFrameHash(cropRect(capture.image, SINGLE_CARD_CROP));
  } catch {
    frameHash = "";
  }

  try {
    let result = await scanRivenStatsFromImage(capture.image, SINGLE_CARD_CROP, "choice-rescan");
    const retry = await retrySparseRivenScan(
      "choice-rescan",
      result.stats,
      500,
      async () => {
        const retryCapture = await captureScreenFast(_rivenDisplayId, DXGI_FRESH_TIMEOUT_MS);
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
        return scanRivenStatsFromImage(retryCapture.image, SINGLE_CARD_CROP, "choice-rescan-retry");
      },
      (value) => value.stats,
    );
    if (retry) result = retry;

    const { stats } = result;
    log.log(
      `[RivenScan] choice rescan: ${stats.length} stats found`,
      stats
        .map((stat) => `${stat.positive ? "+" : "-"}${stat.value ?? "?"}% ${stat.name}`)
        .join(", "),
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
