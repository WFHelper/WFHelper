import type { NativeImage } from "electron";

import { withScope } from "../../services/logger";
import { areOcrDebugDumpsEnabled } from "../../services/rewardScanDebug";
import { sleep } from "../../services/sleep";
import type { CaptureResult } from "../../services/screenCapture";
import {
  hasLowConfidenceLine,
  LOW_CONFIDENCE_THRESHOLD,
  recognizeStatArea,
  rivenOcrOnnxAvailable,
  type RivenOcrResult,
} from "../../services/rivenOcrOnnx";
import { userDataPath } from "../../services/userDataPath";
import {
  cropRivenStatAreaFallback,
  statCropUpscaleFactor,
  cropRivenStatImage,
  type RivenFallbackCrop,
  type RivenScanCropRect,
} from "./rivenScanImage";
import { parseRivenStats, type RivenParseDiagnostics, type RivenStat } from "./rivenScanText";

const log = withScope("rivenScan");
export const MIN_ACCEPTABLE_RIVEN_STATS = 2;
const MAX_LOW_CONFIDENCE_RETRIES = 2;
const LOW_CONFIDENCE_RETRY_DELAY_MS = 300;

function formatStatForLog(stat: RivenStat): string {
  const displayPositive =
    typeof stat.displayPositive === "boolean" ? stat.displayPositive : stat.positive;
  const valueText =
    stat.multiplier && stat.value != null
      ? `x${stat.value}`
      : `${displayPositive ? "+" : "-"}${stat.value ?? "?"}%`;
  return `${valueText} ${stat.name}`;
}

interface RivenScanTiming {
  captureMs: number;
  cropRefineMs: number;
  enhanceMs: number;
  ocrMs: number;
  ocrCalls: number;
  parseMs: number;
  totalMs: number;
}

export interface RivenCardRecognitionResult {
  text: string;
  titleText: string;
  footerText: string;
  stats: RivenStat[];
  /** Stats were read but stayed under the confidence gate: text too small. */
  lowConfidence: boolean;
}

interface RivenCardRecognitionOptions {
  label?: string;
  captureMs?: number;
  sourceType?: CaptureResult["sourceType"];
  generation: number;
  isStale: (generation: number) => boolean;
}

function countNullValues(stats: RivenStat[]): number {
  return stats.reduce((total, stat) => total + (stat.value === null ? 1 : 0), 0);
}

function logScanTiming(label: string, t: RivenScanTiming): void {
  log.info(
    `[RivenScan] timing ${label}: capture=${t.captureMs}ms crop=${t.cropRefineMs}ms ` +
      `enhance=${t.enhanceMs}ms ocr=${t.ocrMs}ms(${t.ocrCalls}calls) ` +
      `parse=${t.parseMs}ms total=${t.totalMs}ms`,
  );
}

// OCR text cannot reveal crop alignment, so the crop is kept alongside it.
// Rotated per outcome: a shared window lets a rolling session's successful
// scans evict the empty ones, which are the only crops worth having.
const DEBUG_DUMP_KEEP = Object.freeze({ empty: 10, failed: 10, dropped: 10, ok: 4 });
type ScanDumpOutcome = keyof typeof DEBUG_DUMP_KEEP;

function dumpScanCrops(
  label: string,
  outcome: ScanDumpOutcome,
  cardCrop: NativeImage,
  statCrop: NativeImage,
): void {
  if (!areOcrDebugDumpsEnabled()) return;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const dir = userDataPath("riven-scan-debug");
    fs.mkdirSync(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(dir, `${stamp}-${outcome}-${label}-card.png`), cardCrop.toPNG());
    fs.writeFileSync(path.join(dir, `${stamp}-${outcome}-${label}-stats.png`), statCrop.toPNG());

    // The stamp always ends in "Z", so this anchors on the outcome field rather
    // than matching a label that happens to contain the same word.
    const bucket = `Z-${outcome}-`;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".png") && f.includes(bucket))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - DEBUG_DUMP_KEEP[outcome]))) {
      fs.unlinkSync(path.join(dir, f));
    }
    log.info(`[RivenScan] ${label}: saved ${outcome} scan crops to ${dir}`);
  } catch (err) {
    log.warn("[RivenScan] scan crop dump failed:", String(err));
  }
}

export async function recognizeRivenCardStats(
  image: NativeImage,
  rect: RivenScanCropRect,
  options: RivenCardRecognitionOptions,
): Promise<RivenCardRecognitionResult> {
  const label = options.label || "yolo-paddle";
  const totalStart = Date.now();

  const cropStart = Date.now();
  const { cardCrop, statCrop } = cropRivenStatImage(image, rect, options.sourceType);
  const cropRefineMs = Date.now() - cropStart;

  if (!rivenOcrOnnxAvailable()) {
    log.warn("[RivenScan] ONNX models not found - riven OCR unavailable.");
    return { text: "", titleText: "", footerText: "", stats: [], lowConfidence: false };
  }

  const sharp = require("sharp") as (typeof import("sharp"))["default"];
  let fallbackCrop: RivenFallbackCrop | null | undefined;
  let bestResult: RivenOcrResult | null = null;
  let bestStats: RivenStat[] = [];
  let bestText = "";
  let ocrMs = 0;
  let parseMs = 0;
  let ocrCalls = 0;
  let droppedAnyLine = false;

  for (let attempt = 0; attempt <= MAX_LOW_CONFIDENCE_RETRIES; attempt += 1) {
    if (options.isStale(options.generation)) {
      return { text: "", titleText: "", footerText: "", stats: [], lowConfidence: false };
    }

    try {
      // Rereading identical pixels cannot improve; retries switch to the
      // upscaled text-bounds crop. The first read keeps that framing and only
      // scales it, because a short band drops its curse line silently and so
      // never reaches the retry gate.
      let scanImage = statCrop;
      let upscaleFactor = statCropUpscaleFactor(statCrop.getSize().height);
      if (attempt > 0) {
        upscaleFactor = 1;
        if (fallbackCrop === undefined) fallbackCrop = cropRivenStatAreaFallback(cardCrop);
        if (fallbackCrop) {
          scanImage = fallbackCrop.image;
          upscaleFactor = fallbackCrop.upscaleFactor;
        }
      }
      const statAreaSize = scanImage.getSize();
      const statAreaPng = scanImage.toPNG();
      let pipeline = sharp(statAreaPng);
      if (upscaleFactor > 1) {
        pipeline = pipeline.resize(
          statAreaSize.width * upscaleFactor,
          statAreaSize.height * upscaleFactor,
          { kernel: "lanczos3" },
        );
      }
      const { data: rgbaBuf, info: rgbaInfo } = await pipeline
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const ocrStart = Date.now();
      const ocrResult = await recognizeStatArea(
        rgbaBuf as Buffer,
        rgbaInfo.width as number,
        rgbaInfo.height as number,
      );
      ocrMs += Date.now() - ocrStart;
      ocrCalls += 1;

      const parseStart = Date.now();
      const diagnostics: RivenParseDiagnostics = { droppedLines: [] };
      const stats = parseRivenStats(ocrResult.text, diagnostics);
      parseMs += Date.now() - parseStart;

      // Loud drops: a signed line that parsed to nothing is the signal that
      // turns a user's "misread" report into an actionable log.
      for (const line of diagnostics.droppedLines) {
        log.warn(`[RivenScan] unparsed stat-like line: "${line}"`);
      }

      if (options.label) {
        log.info(
          `[RivenScan] YOLO+PaddleOCR ${options.label} attempt=${attempt}: ${stats.length} stats, ` +
            `${ocrResult.yoloBoxCount} YOLO boxes, minConf=${ocrResult.minConfidence.toFixed(3)} ` +
            `(source ${statAreaSize.width}×${statAreaSize.height}` +
            `${upscaleFactor > 1 ? ` upscaled x${upscaleFactor}` : ""}) - ` +
            stats.map(formatStatForLog).join(", "),
        );
        for (const line of ocrResult.lines) {
          log.info(`  [OCR] "${line.text}" conf=${line.confidence.toFixed(3)}`);
        }
      }

      // The retry loop runs to escape a low-confidence or null-valued read, so an
      // attempt that ties on stat count and reads cleaner has to take over.
      const nulls = countNullValues(stats);
      const betterTie =
        bestResult !== null &&
        stats.length > 0 &&
        stats.length === bestStats.length &&
        (nulls < countNullValues(bestStats) ||
          (nulls === countNullValues(bestStats) &&
            ocrResult.minConfidence > bestResult.minConfidence));

      if (stats.length > bestStats.length || betterTie) {
        bestResult = ocrResult;
        bestStats = stats;
        bestText = ocrResult.text;
        droppedAnyLine = diagnostics.droppedLines.length > 0;
      }

      if (stats.length >= MIN_ACCEPTABLE_RIVEN_STATS) {
        const lowConf = hasLowConfidenceLine(ocrResult);
        const hasNullValues = stats.some((stat) => stat.value === null);
        if (!lowConf && !hasNullValues) break;
        if (options.label) {
          log.info(
            `[RivenScan] YOLO+PaddleOCR ${options.label}: ` +
              (lowConf
                ? `low confidence (min=${ocrResult.minConfidence.toFixed(3)} < ${LOW_CONFIDENCE_THRESHOLD}), `
                : "") +
              (hasNullValues ? "null values, " : "") +
              "retrying...",
          );
        }
      }
    } catch (err) {
      log.warn(`[RivenScan] YOLO+PaddleOCR attempt=${attempt} failed:`, String(err));
    }

    if (attempt < MAX_LOW_CONFIDENCE_RETRIES) {
      await sleep(LOW_CONFIDENCE_RETRY_DELAY_MS);
    }
  }

  const lowConfidenceResult =
    bestResult && bestStats.length >= MIN_ACCEPTABLE_RIVEN_STATS && hasLowConfidenceLine(bestResult)
      ? bestResult
      : null;
  // Rivens have at least two stats; a lone survivor is a misread.
  const belowStatMinimum = bestStats.length > 0 && bestStats.length < MIN_ACCEPTABLE_RIVEN_STATS;

  // Every scan, not only empty ones: a confident read of a badly cropped card
  // looks perfect in the log, so the image is the only evidence that settles it.
  // Dumped before the failure returns, because a scan the overlay rejected is
  // the one whose crop is worth keeping.
  let outcome: ScanDumpOutcome = "ok";
  if (bestStats.length === 0) outcome = "empty";
  else if (lowConfidenceResult || belowStatMinimum) outcome = "failed";
  // A dropped line means a stat was lost (a missed curse reads as "ok"), so it
  // gets the deeper bucket. The ok bucket keeps 4 files and a scan writes two
  // of them, so a clean scan rotates out after two more.
  else if (droppedAnyLine) outcome = "dropped";
  dumpScanCrops(label, outcome, cardCrop, statCrop);

  if (lowConfidenceResult) {
    if (options.label) {
      log.warn(
        `[RivenScan] YOLO+PaddleOCR ${options.label}: low confidence after all retries ` +
          `(min=${lowConfidenceResult.minConfidence.toFixed(3)}), returning error instead of wrong stats`,
      );
    }
    return { text: "", titleText: "", footerText: "", stats: [], lowConfidence: true };
  }

  logScanTiming(label, {
    captureMs: options.captureMs ?? 0,
    cropRefineMs,
    enhanceMs: 0,
    ocrMs,
    ocrCalls,
    parseMs,
    totalMs: Date.now() - totalStart,
  });

  if (belowStatMinimum) {
    if (options.label) {
      log.warn(
        `[RivenScan] YOLO+PaddleOCR ${options.label}: only ${bestStats.length} stat(s) read, ` +
          `below the ${MIN_ACCEPTABLE_RIVEN_STATS} minimum - returning error`,
      );
    }
    return { text: bestText, titleText: "", footerText: "", stats: [], lowConfidence: true };
  }

  return { text: bestText, titleText: "", footerText: "", stats: bestStats, lowConfidence: false };
}
