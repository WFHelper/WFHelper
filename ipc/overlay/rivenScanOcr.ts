import type { NativeImage } from "electron";

import { withScope } from "../../services/logger";
import { cropRectContent, detectGameContentRect } from "../../services/rewardScannerImage";
import { sleep } from "../../services/rewardScannerUtils";
import {
  hasLowConfidenceLine,
  LOW_CONFIDENCE_THRESHOLD,
  recognizeStatArea,
  rivenOcrOnnxAvailable,
  type RivenOcrResult,
} from "../../services/rivenOcrOnnx";
import { cropRivenStatArea, type RivenScanCropRect } from "./rivenScanImage";
import { parseRivenStats, type RivenStat } from "./rivenScanText";

const log = withScope("rivenScan");
const MIN_ACCEPTABLE_RIVEN_STATS = 2;
const MAX_LOW_CONFIDENCE_RETRIES = 2;
const LOW_CONFIDENCE_RETRY_DELAY_MS = 300;

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
}

export interface RivenCardRecognitionOptions {
  label?: string;
  captureMs?: number;
  generation: number;
  isStale: (generation: number) => boolean;
}

function logScanTiming(label: string, t: RivenScanTiming): void {
  log.log(
    `[RivenScan] timing ${label}: capture=${t.captureMs}ms crop=${t.cropRefineMs}ms ` +
      `enhance=${t.enhanceMs}ms ocr=${t.ocrMs}ms(${t.ocrCalls}calls) ` +
      `parse=${t.parseMs}ms total=${t.totalMs}ms`,
  );
}

export async function recognizeRivenCardStats(
  image: NativeImage,
  rect: RivenScanCropRect,
  options: RivenCardRecognitionOptions,
): Promise<RivenCardRecognitionResult> {
  const label = options.label || "yolo-paddle";
  const totalStart = Date.now();

  const cropStart = Date.now();
  const roughCrop = cropRectContent(image, rect, detectGameContentRect(image));
  const cropRefineMs = Date.now() - cropStart;

  if (!rivenOcrOnnxAvailable()) {
    log.warn("[RivenScan] ONNX models not found — riven OCR unavailable.");
    return { text: "", titleText: "", footerText: "", stats: [] };
  }

  const sharp = require("sharp") as typeof import("sharp");
  let bestResult: RivenOcrResult | null = null;
  let bestStats: RivenStat[] = [];
  let bestText = "";
  let ocrMs = 0;
  let parseMs = 0;
  let ocrCalls = 0;

  for (let attempt = 0; attempt <= MAX_LOW_CONFIDENCE_RETRIES; attempt += 1) {
    if (options.isStale(options.generation)) {
      return { text: "", titleText: "", footerText: "", stats: [] };
    }

    try {
      const statAreaCrop = cropRivenStatArea(roughCrop);
      const statAreaSize = statAreaCrop.getSize();
      const statAreaPng = statAreaCrop.toPNG();
      const { data: rgbaBuf, info: rgbaInfo } = await sharp(statAreaPng)
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
      const stats = parseRivenStats(ocrResult.text);
      parseMs += Date.now() - parseStart;

      if (options.label) {
        log.log(
          `[RivenScan] YOLO+PaddleOCR ${options.label} attempt=${attempt}: ${stats.length} stats, ` +
            `${ocrResult.yoloBoxCount} YOLO boxes, minConf=${ocrResult.minConfidence.toFixed(3)} ` +
            `(source ${statAreaSize.width}×${statAreaSize.height}) — ` +
            stats
              .map(
                (stat) =>
                  `${stat.positive ? "+" : "-"}${stat.value ?? "?"}${stat.multiplier ? "x" : "%"} ${stat.name}`,
              )
              .join(", "),
        );
        for (const line of ocrResult.lines) {
          log.log(`  [OCR] "${line.text}" conf=${line.confidence.toFixed(3)}`);
        }
      }

      if (stats.length > bestStats.length) {
        bestResult = ocrResult;
        bestStats = stats;
        bestText = ocrResult.text;
      }

      if (stats.length >= MIN_ACCEPTABLE_RIVEN_STATS) {
        const lowConf = hasLowConfidenceLine(ocrResult);
        const hasNullValues = stats.some((stat) => stat.value === null);
        if (!lowConf && !hasNullValues) break;
        if (options.label) {
          log.log(
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

  if (
    bestResult &&
    bestStats.length >= MIN_ACCEPTABLE_RIVEN_STATS &&
    hasLowConfidenceLine(bestResult)
  ) {
    if (options.label) {
      log.warn(
        `[RivenScan] YOLO+PaddleOCR ${options.label}: low confidence after all retries ` +
          `(min=${bestResult.minConfidence.toFixed(3)}), returning error instead of wrong stats`,
      );
    }
    return { text: "", titleText: "", footerText: "", stats: [] };
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

  return { text: bestText, titleText: "", footerText: "", stats: bestStats };
}
