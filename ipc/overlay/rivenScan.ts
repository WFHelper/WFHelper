import { withScope } from "../../services/logger";
import { captureScreenFast, type CaptureResult } from "../../services/screenCapture";
import { sleep } from "../../services/sleep";
import {
  abortRivenScanWaits,
  computeRivenFrameHashForCrop,
  RIVEN_SCAN_CROPS,
  resetRivenScanWaits,
  rivenContentRect,
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
export type InitialCardLayout = "reroll" | "chat";

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
  /** Frame the accepted OCR pass ran on; reused for the fits-in weapon read. */
  capture: CaptureResult | null;
  /** Stats were seen but stayed under the confidence gate: text too small. */
  lowConfidence: boolean;
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
  chat: {
    label: "chat-card",
    crop: RIVEN_SCAN_CROPS.chatCard,
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
  return { text: "", titleText: "", footerText: "", stats: [], lowConfidence: false };
}

function pinCaptureDisplay(capture: CaptureResult): void {
  if (capture.sourceDisplayId && capture.sourceDisplayId !== _rivenDisplayId) {
    _rivenDisplayId = capture.sourceDisplayId;
    log.info(`[RivenScan] pinned to display id=${_rivenDisplayId}`);
  }
}

function logCapture(profile: RivenScanProfile, capture: CaptureResult): void {
  const imgSize = capture.image.getSize?.() ?? { width: "?", height: "?" };
  // A shaved crop base shifts every fraction-based crop and is otherwise
  // invisible in the log, so name it when bar trim or the 16:9 clamp bites.
  let contentNote = "";
  try {
    const content = rivenContentRect(capture.image, capture.sourceType);
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
    return computeRivenFrameHashForCrop(capture.image, profile.crop, capture.sourceType);
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
    sourceType: capture.sourceType,
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
  let resultCapture = capture;
  if (retryIsBetter) {
    log.info(`[RivenScan] ${profile.label}: retry improved to ${retryResult.stats.length} stats`);
    result = retryResult;
    resultCapture = retryCapture;
  }

  return { ...result, capture: resultCapture, elapsedMs: Date.now() - attemptStart };
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

export async function scanInitialCard(
  layout: InitialCardLayout = "reroll",
): Promise<InitialScanResult> {
  const generation = ++_scanGeneration;
  const profile = layout === "chat" ? RIVEN_SCAN_PROFILES.chat : RIVEN_SCAN_PROFILES.initial;
  try {
    const result = await runRivenScanAttempt(profile, generation);
    log.info(
      `[RivenScan] ${profile.label} scan: ${result.stats.length} stats found`,
      formatStatsForLog(result.stats),
    );
    return {
      stats: result.stats,
      rawText: result.text,
      titleText: result.titleText,
      footerText: result.footerText,
      capture: result.capture,
      lowConfidence: result.lowConfidence,
    };
  } catch (err) {
    log.warn(`[RivenScan] ${profile.label} OCR failed:`, String(err));
    return {
      stats: [],
      rawText: "",
      titleText: "",
      footerText: "",
      capture: null,
      lowConfidence: false,
    };
  }
}

export async function scanNewRoll(): Promise<RollPanelResult> {
  const generation = ++_scanGeneration;
  try {
    const result = await runRivenScanAttempt(RIVEN_SCAN_PROFILES.roll, generation);
    log.info(
      `[RivenScan] roll scan: ${result.stats.length} stats found`,
      formatStatsForLog(result.stats),
    );
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
