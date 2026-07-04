import type { NativeImage } from "electron";

import { withScope } from "../../services/logger";
import { sleep } from "../../services/rewardScannerUtils";
import {
  hasLowConfidenceLine,
  LOW_CONFIDENCE_THRESHOLD,
  recognizeStatArea,
  rivenOcrOnnxAvailable,
  type RivenOcrResult,
} from "../../services/rivenOcrOnnx";
import { cropRivenStatImage, type RivenScanCropRect } from "./rivenScanImage";
import { parseRivenStats, type RivenStat } from "./rivenScanText";

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
}

interface RivenCardRecognitionOptions {
  label?: string;
  captureMs?: number;
  generation: number;
  isStale: (generation: number) => boolean;
}

function logScanTiming(label: string, t: RivenScanTiming): void {
  log.info(
    `[RivenScan] timing ${label}: capture=${t.captureMs}ms crop=${t.cropRefineMs}ms ` +
      `enhance=${t.enhanceMs}ms ocr=${t.ocrMs}ms(${t.ocrCalls}calls) ` +
      `parse=${t.parseMs}ms total=${t.totalMs}ms`,
  );
}

// When a scan finds nothing, keep the card/stat crops on disk so users can
// attach them to reports - misaligned crops are impossible to diagnose from
// OCR fragments alone. Only the card region is saved, never the full screen.
const DEBUG_DUMP_KEEP = 10;

function dumpFailedScanCrops(label: string, cardCrop: NativeImage, statCrop: NativeImage): void {
  try {
    const { app } = require("electron") as typeof import("electron");
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const dir = path.join(app.getPath("userData"), "riven-scan-debug");
    fs.mkdirSync(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(dir, `${stamp}-${label}-card.png`), cardCrop.toPNG());
    fs.writeFileSync(path.join(dir, `${stamp}-${label}-stats.png`), statCrop.toPNG());

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".png"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - DEBUG_DUMP_KEEP))) {
      fs.unlinkSync(path.join(dir, f));
    }
    log.info(`[RivenScan] ${label}: saved failed-scan crops to ${dir}`);
  } catch (err) {
    log.warn("[RivenScan] failed-scan crop dump failed:", String(err));
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
  const { cardCrop, statCrop } = cropRivenStatImage(image, rect);
  const cropRefineMs = Date.now() - cropStart;

  if (!rivenOcrOnnxAvailable()) {
    log.warn("[RivenScan] ONNX models not found - riven OCR unavailable.");
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
      const statAreaSize = statCrop.getSize();
      const statAreaPng = statCrop.toPNG();
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
        log.info(
          `[RivenScan] YOLO+PaddleOCR ${options.label} attempt=${attempt}: ${stats.length} stats, ` +
            `${ocrResult.yoloBoxCount} YOLO boxes, minConf=${ocrResult.minConfidence.toFixed(3)} ` +
            `(source ${statAreaSize.width}×${statAreaSize.height}) - ` +
            stats.map(formatStatForLog).join(", "),
        );
        for (const line of ocrResult.lines) {
          log.info(`  [OCR] "${line.text}" conf=${line.confidence.toFixed(3)}`);
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

  if (bestStats.length === 0) {
    dumpFailedScanCrops(label, cardCrop, statCrop);
  }

  return { text: bestText, titleText: "", footerText: "", stats: bestStats };
}
