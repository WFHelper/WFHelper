/**
 * OCR scanning for the riven rolling screen.
 *
 * Overlay/session timing stays in rivenOverlayIpc. This module owns scan state,
 * the three public scan entrypoints, and one shared capture/hash/retry runner.
 */

import { withScope } from "../../services/logger";
import { captureScreenFast, type CaptureResult } from "../../services/rewardScannerCapture";
import { detectGameContentRect } from "../../services/rewardScannerImage";
import { sleep } from "../../services/rewardScannerUtils";
import {
  abortRivenScanWaits,
  computeRivenFrameHashForCrop,
  RIVEN_SCAN_CROPS,
  resetRivenScanWaits,
  type RivenScanCropRect,
  waitForRivenUiReady,
} from "./rivenScanImage";
import {
  recognizeRivenCardStats,
  MIN_ACCEPTABLE_RIVEN_STATS,
  type RivenCardRecognitionResult,
} from "./rivenScanOcr";
import type { RivenStat } from "./rivenScanText";

export type { RivenStat } from "./rivenScanText";

const log = withScope("rivenScan");
const DXGI_FRESH_TIMEOUT_MS = 100;

export interface RollPanelResult {
  left: RivenStat[];
  right: RivenStat[];
  /** Raw OCR text of the scanned card (title line included) for weapon detection.
   *  Only set by the scanner; absent on the overlay IPC payload. */
  rawText?: string;
}

interface InitialScanResult {
  stats: RivenStat[];
  rawText: string;
  titleText: string;
  footerText: string;
}

interface RivenScanProfile {
  label: string;
  crop: RivenScanCropRect;
  readyMode?: "initial" | "roll" | "choice";
  captureTimeoutMs?: number;
  retryDelayMs: number;
  acceptEqualRetry?: boolean;
}

interface RivenScanAttemptResult extends RivenCardRecognitionResult {
  capture: CaptureResult | null;
  elapsedMs: number;
}

const RIVEN_SCAN_PROFILES = Object.freeze({
  initial: {
    label: "initial-card",
    crop: RIVEN_SCAN_CROPS.singleCard,
    readyMode: "initial",
    retryDelayMs: 650,
  },
  roll: {
    label: "roll-right",
    crop: RIVEN_SCAN_CROPS.rollCard,
    captureTimeoutMs: DXGI_FRESH_TIMEOUT_MS,
    retryDelayMs: 800,
    acceptEqualRetry: true,
  },
  choice: {
    label: "choice-rescan",
    crop: RIVEN_SCAN_CROPS.singleCard,
    captureTimeoutMs: DXGI_FRESH_TIMEOUT_MS,
    retryDelayMs: 500,
  },
} satisfies Record<string, RivenScanProfile>);

// Display ID pinning: set from the initial card scan so all subsequent
// captures (roll, choice) use the same monitor as the initial capture.
let _rivenDisplayId: string | null = null;

// Abort flag: set by abortRivenScans() to cancel between-iteration OCR work.
let _ocrAborted = false;

// Incremented at each public scan entry so slow OCR cannot publish stale output.
let _scanGeneration = 0;

function isRivenScanStale(generation: number): boolean {
  return _ocrAborted || _scanGeneration !== generation;
}

function emptyRecognitionResult(): RivenCardRecognitionResult {
  return { text: "", titleText: "", footerText: "", stats: [] };
}

function pinCaptureDisplay(capture: CaptureResult): void {
  if (capture.sourceDisplayId && capture.sourceDisplayId !== _rivenDisplayId) {
    _rivenDisplayId = capture.sourceDisplayId;
    log.info(`[RivenScan] pinned to display id=${_rivenDisplayId}`);
  }
}

function logCapture(profile: RivenScanProfile, capture: CaptureResult): void {
  const imgSize = capture.image.getSize?.() ?? { width: "?", height: "?" };
  // Note when letterbox detection trimmed the frame - a dark scene edge shaved
  // here shifts every fraction-based crop and is invisible in the log otherwise.
  let contentNote = "";
  try {
    const content = detectGameContentRect(capture.image);
    if (
      content.x !== 0 ||
      content.y !== 0 ||
      content.width !== imgSize.width ||
      content.height !== imgSize.height
    ) {
      contentNote = ` content=${content.width}x${content.height}@${content.x},${content.y}`;
    }
  } catch {
    /* diagnostic only */
  }
  log.info(
    `[RivenScan] ${profile.label} capture: source=${capture.sourceType} ` +
      `name="${capture.sourceName}" size=${imgSize.width}x${imgSize.height}${contentNote}`,
  );
}

function frameHashForCapture(capture: CaptureResult, profile: RivenScanProfile): string {
  try {
    return computeRivenFrameHashForCrop(capture.image, profile.crop);
  } catch {
    // Hashing failed (e.g. invalid crop region) - empty hash disables dedup for this frame.
    return "";
  }
}

async function captureForProfile(
  profile: RivenScanProfile,
): Promise<{ capture: CaptureResult | null; captureMs: number; frameHash: string }> {
  const startedAt = Date.now();

  if (profile.readyMode) {
    const ready = await waitForRivenUiReady(profile.crop, profile.readyMode, _rivenDisplayId);
    if (!ready.ready) {
      log.info(
        `[RivenScan] ${profile.label} UI gate timed out after ${ready.elapsedMs}ms ` +
          `(${ready.attempts} samples, best=${ready.bestScore.toFixed(3)})`,
      );
    }

    const capture = ready.screenshot || (await captureScreenFast(_rivenDisplayId));
    return { capture, captureMs: Date.now() - startedAt, frameHash: ready.frameHash };
  }

  const capture = await captureScreenFast(_rivenDisplayId, profile.captureTimeoutMs);
  return { capture, captureMs: Date.now() - startedAt, frameHash: "" };
}

async function recognizeCapture(
  capture: CaptureResult,
  profile: RivenScanProfile,
  generation: number,
  captureMs: number,
  label = profile.label,
): Promise<RivenCardRecognitionResult> {
  return recognizeRivenCardStats(capture.image, profile.crop, {
    label,
    captureMs,
    generation,
    isStale: isRivenScanStale,
  });
}

async function runRivenScanAttempt(
  profile: RivenScanProfile,
  generation: number,
): Promise<RivenScanAttemptResult> {
  const attemptStart = Date.now();
  const { capture, captureMs, frameHash: readyFrameHash } = await captureForProfile(profile);
  if (!capture) {
    log.warn(`[RivenScan] ${profile.label}: captureScreen returned null`);
    return { ...emptyRecognitionResult(), capture: null, elapsedMs: Date.now() - attemptStart };
  }

  pinCaptureDisplay(capture);
  logCapture(profile, capture);

  const frameHash = readyFrameHash || frameHashForCapture(capture, profile);
  let result = await recognizeCapture(capture, profile, generation, captureMs);
  log.info(
    `[RivenScan] ${profile.label}: ${result.stats.length} stats, elapsed=${Date.now() - attemptStart}ms`,
  );

  if (result.stats.length >= MIN_ACCEPTABLE_RIVEN_STATS || isRivenScanStale(generation)) {
    return { ...result, capture, elapsedMs: Date.now() - attemptStart };
  }

  log.info(
    `[RivenScan] ${profile.label}: sparse result (${result.stats.length} stats), ` +
      `retrying in ${profile.retryDelayMs}ms`,
  );
  await sleep(profile.retryDelayMs);
  if (isRivenScanStale(generation)) {
    return { ...result, capture, elapsedMs: Date.now() - attemptStart };
  }

  const retryStart = Date.now();
  const retryCapture = await captureScreenFast(_rivenDisplayId, profile.captureTimeoutMs);
  if (!retryCapture) {
    return { ...result, capture, elapsedMs: Date.now() - attemptStart };
  }

  const retryHash = frameHashForCapture(retryCapture, profile);
  if (retryHash && retryHash === frameHash) {
    log.info(`[RivenScan] ${profile.label}-retry skipped identical frame hash`);
    return { ...result, capture, elapsedMs: Date.now() - attemptStart };
  }

  const retryResult = await recognizeCapture(
    retryCapture,
    profile,
    generation,
    Date.now() - retryStart,
    `${profile.label}-retry`,
  );
  const retryIsBetter = profile.acceptEqualRetry
    ? retryResult.stats.length >= result.stats.length
    : retryResult.stats.length > result.stats.length;
  if (retryIsBetter) {
    log.info(`[RivenScan] ${profile.label}: retry improved to ${retryResult.stats.length} stats`);
    result = retryResult;
  }

  return { ...result, capture, elapsedMs: Date.now() - attemptStart };
}

function formatStatsForLog(stats: RivenStat[]): string {
  return stats
    .map((stat) => {
      const displayPositive =
        typeof stat.displayPositive === "boolean" ? stat.displayPositive : stat.positive;
      const valueText =
        stat.multiplier && stat.value != null
          ? `x${stat.value}`
          : `${displayPositive ? "+" : "-"}${stat.value ?? "?"}%`;
      return `${valueText} ${stat.name}`;
    })
    .join(", ");
}

export function abortRivenScans(): void {
  _ocrAborted = true;
  abortRivenScanWaits();
}

export function resetRivenScanAbort(): void {
  _ocrAborted = false;
  resetRivenScanWaits();
}

export async function scanInitialCard(): Promise<InitialScanResult> {
  const generation = ++_scanGeneration;
  try {
    const result = await runRivenScanAttempt(RIVEN_SCAN_PROFILES.initial, generation);
    log.info(
      `[RivenScan] initial card scan: ${result.stats.length} stats found`,
      formatStatsForLog(result.stats),
    );
    return {
      stats: result.stats,
      rawText: result.text,
      titleText: result.titleText,
      footerText: result.footerText,
    };
  } catch (err) {
    log.warn("[RivenScan] initial card OCR failed:", String(err));
    return { stats: [], rawText: "", titleText: "", footerText: "" };
  }
}

export async function scanNewRoll(): Promise<RollPanelResult> {
  const generation = ++_scanGeneration;
  try {
    const result = await runRivenScanAttempt(RIVEN_SCAN_PROFILES.roll, generation);
    return { left: [], right: result.stats, rawText: result.text };
  } catch (err) {
    log.warn("[RivenScan] roll scan OCR failed:", String(err));
    return { left: [], right: [], rawText: "" };
  }
}

export async function scanChoiceRescan(): Promise<RivenStat[]> {
  const generation = ++_scanGeneration;
  try {
    const result = await runRivenScanAttempt(RIVEN_SCAN_PROFILES.choice, generation);
    log.info(
      `[RivenScan] choice rescan: ${result.stats.length} stats found`,
      formatStatsForLog(result.stats),
    );
    return result.stats;
  } catch (err) {
    log.warn("[RivenScan] choice rescan OCR failed:", String(err));
    return [];
  }
}
