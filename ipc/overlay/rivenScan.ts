/**
 * OCR scanning for the riven rolling screen.
 *
 * Scanning strategy:
 *  1. Session opens -> scanInitialCard() - OCR the centered single card
 *  2. Roll confirmed -> scanNewRoll() - centered crop matching AlecaFrame's
 *     CutBitmapToRoughSize, with edge detection to isolate the card.
 *
 * At 2750ms after roll confirm, the game may still be transitioning from the
 * single new-card display to the two-panel diorama layout.  The CENTERED crop
 * (matching AlecaFrame exactly) captures whatever card is visible in the center
 * at that moment, and our Sobel edge detection (detectRivenCardFrame) narrows
 * to the actual text area.
 */

import { withScope } from "../../services/logger";
import { captureScreenFast } from "../../services/rewardScannerCapture";
import { cropRect, cropRectContent, detectGameContentRect } from "../../services/rewardScannerImage";
import { rivenOcrOnnxAvailable, recognizeStatArea, hasLowConfidenceLine, LOW_CONFIDENCE_THRESHOLD } from "../../services/rivenOcrOnnx";
import type { RivenOcrResult } from "../../services/rivenOcrOnnx";
import { sleep } from "../../services/rewardScannerUtils";
import {
  abortRivenScanWaits,
  computeRivenFrameHash,
  resetRivenScanWaits,
  waitForRivenUiReady,
} from "./rivenScanImage";
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
import type { NativeImage } from "electron";

const MIN_ACCEPTABLE_RIVEN_STATS = 2;

interface RivenScanTiming {
  captureMs: number;
  cropRefineMs: number;
  enhanceMs: number;
  ocrMs: number;
  ocrCalls: number;
  parseMs: number;
  totalMs: number;
}

let _lastScanTiming: RivenScanTiming | null = null;

function logScanTiming(label: string, t: RivenScanTiming): void {
  log.log(
    `[RivenScan] timing ${label}: capture=${t.captureMs}ms crop=${t.cropRefineMs}ms ` +
      `enhance=${t.enhanceMs}ms ocr=${t.ocrMs}ms(${t.ocrCalls}calls) ` +
      `parse=${t.parseMs}ms total=${t.totalMs}ms`,
  );
}

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

// Initial / choice scan: single centred card covers x 0.22–0.78.
const SINGLE_CARD_CROP = { x: 0.22, y: 0.43, width: 0.56, height: 0.45 };

// Roll scan: AlecaFrame-matching centered crop.  AlecaFrame's CutBitmapToRoughSize
// for RivenReroll crops a CENTER strip (not offset to right) and relies on edge
// detection (DetailedRivenCrop) to isolate the card within.  At 2750ms after roll
// confirm the new card may still be centered on screen before the two-panel diorama
// layout settles.  Exact AlecaFrame math at 1920×1080:
//   roughHeight = H*0.7 = 756, roughWidth = roughHeight*0.45 = 340
//   x = W/2 - roughWidth/2 = 790 (41.1%), topCut = 0.38*roughHeight = 287
//   y = H/2 - roughHeight/2 + topCut = 449 (41.6%), h = roughHeight - topCut = 469
// As fractions: { x: 0.411, y: 0.416, width: 0.177, height: 0.434 }
const ROLL_CARD_CROP = { x: 0.411, y: 0.416, width: 0.177, height: 0.434 };

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

// The Python benchmark achieves 98% accuracy with this simple approach.
// Edge-based crop refinement is unreliable with Kuva portal animation.
const CARD_ASPECT_RATIO = 287 / 433; // ≈ 0.663 (riven card width/height)

function _cropStatAreaForVgb(roughCrop: NativeImage): NativeImage {
  const { width: w, height: h } = roughCrop.getSize();
  if (w < 50 || h < 50) return roughCrop;

  // Step 1: Trim to card aspect ratio (matches Python trim_to_card_aspect)
  // SINGLE_CARD_CROP is ~2.2:1 aspect, card is 0.663:1, so this centers on the card.
  const expectedW = Math.floor(h * CARD_ASPECT_RATIO);
  let trimmed = roughCrop;
  let tw = w;
  const th = h;
  if (w > expectedW * 1.10) {
    const excess = w - expectedW;
    const x1 = Math.floor(excess / 2);
    tw = expectedW;
    trimmed = roughCrop.crop({ x: x1, y: 0, width: expectedW, height: h });
  }

  // Step 2: Fixed stat area crop (matches Python refine_crop)
  // Stat text occupies ~34-84% of card height, 8-92% of card width.
  const sy0 = Math.floor(th * 0.34);
  const sy1 = Math.floor(th * 0.84);
  const sx0 = Math.floor(tw * 0.08);
  const sx1 = Math.floor(tw * 0.92);
  const cropW = sx1 - sx0;
  const cropH = sy1 - sy0;

  if (cropW < 30 || cropH < 30) return roughCrop;

  return trimmed.crop({ x: sx0, y: sy0, width: cropW, height: cropH });
}

async function ocrCropMultiStrategy(
  image: NativeImage,
  rect: { x: number; y: number; width: number; height: number },
  label = "",
  _expectedWeaponName = "",
  _statsOnly = false,
  _isMultipanel = false,
): Promise<{ text: string; titleText: string; footerText: string; stats: RivenStat[] }> {
  const myGeneration = _scanGeneration; // snapshot; stale if a new scan started
  const totalStart = Date.now();

  const cropStart = Date.now();
  const roughCrop = cropRectContent(image, rect, detectGameContentRect(image));
  const cropRefineMs = Date.now() - cropStart;

  // YOLO stat-line detector + PaddleOCR CH v3 recognition pipeline.
  // No VGB preprocessing needed — YOLO detects lines directly from raw image.
  if (rivenOcrOnnxAvailable()) {
    /** Retry up to 2× on low-confidence scans — riven card animation may still be settling. */
    const MAX_RETRIES = 2;
    /** Short delay between retries to let the on-screen card fully render. */
    const RETRY_DELAY_MS = 300;

    const sharp = require("sharp") as typeof import("sharp");

    let bestResult: RivenOcrResult | null = null;
    let bestStats: RivenStat[] = [];
    let bestText = "";

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (_ocrAborted || _scanGeneration !== myGeneration) {
        return { text: "", titleText: "", footerText: "", stats: [] };
      }

      try {
        // Fixed-percentage crop matching the Python benchmark exactly.
        const statAreaCrop = _cropStatAreaForVgb(roughCrop);
        const statAreaSize = statAreaCrop.getSize();

        // Convert NativeImage to raw RGBA buffer for the ONNX pipeline
        const statAreaPng = statAreaCrop.toPNG();
        const { data: rgbaBuf, info: rgbaInfo } = await sharp(statAreaPng)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });

        const ocrResult = await recognizeStatArea(
          rgbaBuf as Buffer,
          rgbaInfo.width as number,
          rgbaInfo.height as number,
        );

        const stats = parseRivenStats(ocrResult.text);

        if (label) {
          log.log(
            `[RivenScan] YOLO+PaddleOCR ${label} attempt=${attempt}: ${stats.length} stats, ` +
            `${ocrResult.yoloBoxCount} YOLO boxes, minConf=${ocrResult.minConfidence.toFixed(3)} ` +
            `(source ${statAreaSize.width}×${statAreaSize.height}) — ` +
            stats.map((s) => `${s.positive ? "+" : "-"}${s.value ?? "?"}${s.multiplier ? "x" : "%"} ${s.name}`).join(", "),
          );
          for (const line of ocrResult.lines) {
            log.log(`  [OCR] "${line.text}" conf=${line.confidence.toFixed(3)}`);
          }
        }

        // Keep the best result across retries (most stats wins)
        if (stats.length > bestStats.length) {
          bestResult = ocrResult;
          bestStats = stats;
          bestText = ocrResult.text;
        }

        // Good enough: ≥2 stats and all lines have sufficient confidence
        if (stats.length >= MIN_ACCEPTABLE_RIVEN_STATS) {
          const lowConf = hasLowConfidenceLine(ocrResult);
          const hasNullValues = stats.some((s) => s.value === null);
          if (!lowConf && !hasNullValues) break;
          if (label) {
            log.log(
              `[RivenScan] YOLO+PaddleOCR ${label}: ` +
              (lowConf ? `low confidence (min=${ocrResult.minConfidence.toFixed(3)} < ${LOW_CONFIDENCE_THRESHOLD}), ` : "") +
              (hasNullValues ? "null values, " : "") +
              "retrying...",
            );
          }
        }
      } catch (err) {
        log.warn(`[RivenScan] YOLO+PaddleOCR attempt=${attempt} failed:`, String(err));
      }

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    }

    // If best result has low confidence on any stat, return empty (show error, not wrong stats)
    if (bestResult && bestStats.length >= MIN_ACCEPTABLE_RIVEN_STATS && hasLowConfidenceLine(bestResult)) {
      if (label) {
        log.warn(
          `[RivenScan] YOLO+PaddleOCR ${label}: low confidence after all retries ` +
          `(min=${bestResult.minConfidence.toFixed(3)}), returning error instead of wrong stats`,
        );
      }
      return { text: "", titleText: "", footerText: "", stats: [] };
    }

    _lastScanTiming = {
      captureMs: 0,
      cropRefineMs,
      enhanceMs: 0,
      ocrMs: 0,
      ocrCalls: 0,
      parseMs: 0,
      totalMs: Date.now() - totalStart,
    };
    logScanTiming(label || "yolo-paddle", _lastScanTiming);

    return { text: bestText, titleText: "", footerText: "", stats: bestStats };
  }

  // YOLO + PaddleOCR pipeline is the only supported riven OCR path.
  log.warn("[RivenScan] ONNX models not found — riven OCR unavailable.");
  return { text: "", titleText: "", footerText: "", stats: [] };
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

export async function scanInitialCard(expectedWeaponName = ""): Promise<InitialScanResult> {
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
    if (_lastScanTiming) _lastScanTiming.captureMs = captureMs;
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

export async function scanNewRoll(expectedWeaponName = "", skipGate = true): Promise<RollPanelResult> {
  log.log(`[RivenScan] >>> scanNewRoll ENTERED (weapon="${expectedWeaponName}", skipGate=${skipGate})`);
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
    let rightResult = await ocrCropMultiStrategy(
      capture.image,
      ROLL_CARD_CROP,
      "roll-right",
      expectedWeaponName,
      true,  // statsOnly
      true,  // isMultipanel
    );
    log.log(
      `[RivenScan] roll scan: right=${rightResult.stats.length} stats, elapsed=${Date.now() - startAt}ms`,
    );
    if (_lastScanTiming) _lastScanTiming.captureMs = rollCaptureMs;

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

        const retryResult = await ocrCropMultiStrategy(
          retryCapture.image,
          ROLL_CARD_CROP,
          "roll-right-retry",
          expectedWeaponName,
          true,  // statsOnly
          true,  // isMultipanel
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
  // AlecaFrame model: CHOICE_RESCAN_DELAY_MS (1200 ms) already elapsed.
  // Capture immediately — no readiness gate polling.
  // Use non-zero DXGI timeout to force a fresh frame after the choice animation.
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
    let result = await ocrCropMultiStrategy(
      capture.image,
      SINGLE_CARD_CROP,
      "choice-rescan",
      expectedWeaponName,
      true,
    );
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
        return ocrCropMultiStrategy(
          retryCapture.image,
          SINGLE_CARD_CROP,
          "choice-rescan-retry",
          expectedWeaponName,
          true,
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
