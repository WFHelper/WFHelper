import fs from "fs";
import path from "path";
import type { NativeImage } from "electron";

import { normalizeErrorMessage } from "../config/shared/errors";
import { withScope } from "./logger";
import { captureScreenFast, type CaptureResult } from "./rewardScannerCapture";
import { buildOcrVariants, cropBand, cropRect } from "./rewardScannerImage";
import { detectRelicEraFromText, detectRelicEraFromTileLabelText } from "./rewardScannerMatch";
import { RELIC_ERA_BANDS, RELIC_ROW_TILE_LABEL_RECTS, SCANNER_TUNING } from "./rewardScannerSupport";
import { round4 } from "./rewardScannerUtils";
import { clampNumber } from "../config/shared/numeric";

const log = withScope("rewardScanner");

interface RelicEraDetectionResult {
  era: string | null;
  confidence: number;
  elapsedMs: number;
  textPreview: string;
  candidateId?: string | null;
  bandTopRatio?: number | null;
  bandHeightRatio?: number | null;
  ocrVariant?: string | null;
  sourceType?: string | null;
  sourceName?: string | null;
  sourceId?: string | null;
  sourceDisplayId?: string | null;
}

interface RelicEraCandidate {
  era: string | null;
  confidence: number;
  textPreview: string;
  candidateId: string | null;
  bandTopRatio: number | null;
  bandHeightRatio: number | null;
  ocrVariant: string | null;
}

function emptyCandidate(): RelicEraCandidate {
  return {
    era: null,
    confidence: 0,
    textPreview: "",
    candidateId: null,
    bandTopRatio: null,
    bandHeightRatio: null,
    ocrVariant: null,
  };
}

function buildTempImagePath(basePath: string, label: string): string {
  const ext = path.extname(basePath) || ".png";
  const stem = ext ? basePath.slice(0, -ext.length) : basePath;
  const safeLabel = String(label || "scan").replace(/[^a-z0-9_-]+/gi, "-");
  return `${stem}-${safeLabel}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
}

async function runVariantOcr(
  variantImage: NativeImage,
  timeoutMs: number,
  label: string,
  ocr: {
    runOCR: (imagePath: string, timeoutMs: number) => Promise<string>;
    runOCRBuffer: (buffer: Buffer, timeoutMs: number) => Promise<string>;
  },
): Promise<string> {
  const pngBuffer: Buffer = variantImage.toPNG();
  try {
    return await ocr.runOCRBuffer(pngBuffer, timeoutMs);
  } catch {
    const tempPath = buildTempImagePath(SCANNER_TUNING.paths.tempImage, label);
    fs.writeFileSync(tempPath, pngBuffer);
    try {
      return await ocr.runOCR(tempPath, timeoutMs);
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // best effort temp cleanup
      }
    }
  }
}

function textPreview(ocrText: string): string {
  return String(ocrText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SCANNER_TUNING.ocr.textPreviewMaxChars);
}

async function scanTileLabels(
  screenshot: CaptureResult,
  timeoutMs: number,
  perAttemptTimeoutMs: number,
  startedAt: number,
  ocr: {
    runOCR: (imagePath: string, timeoutMs: number) => Promise<string>;
    runOCRBuffer: (buffer: Buffer, timeoutMs: number) => Promise<string>;
  },
): Promise<RelicEraCandidate> {
  let best = emptyCandidate();

  for (const rect of RELIC_ROW_TILE_LABEL_RECTS) {
    let cropped: NativeImage;
    try {
      cropped = cropRect(screenshot.image, rect);
    } catch {
      continue;
    }

    const variants = buildOcrVariants(cropped);
    for (const variant of variants) {
      if (Date.now() - startedAt >= timeoutMs) break;

      let ocrText: string;
      try {
        ocrText = await runVariantOcr(
          variant.image,
          perAttemptTimeoutMs,
          `era-${rect.id}-${variant.id}`,
          ocr,
        );
      } catch {
        continue;
      }

      const hit = detectRelicEraFromTileLabelText(ocrText);
      if (hit.confidence > best.confidence) {
        best = {
          era: hit.era,
          confidence: hit.confidence,
          textPreview: textPreview(ocrText),
          candidateId: `tile-${rect.id}`,
          bandTopRatio: round4(rect.y, null),
          bandHeightRatio: round4(rect.height, null),
          ocrVariant: variant.id,
        };
      }

      if (best.confidence >= 0.99) break;
    }

    if (best.confidence >= 0.99) break;
  }

  return best;
}

async function scanHeaderBands(
  screenshot: CaptureResult,
  timeoutMs: number,
  perAttemptTimeoutMs: number,
  startedAt: number,
  ocr: {
    runOCR: (imagePath: string, timeoutMs: number) => Promise<string>;
    runOCRBuffer: (buffer: Buffer, timeoutMs: number) => Promise<string>;
  },
): Promise<RelicEraCandidate> {
  let best = emptyCandidate();

  for (const band of RELIC_ERA_BANDS) {
    let cropped: NativeImage;
    try {
      cropped = cropBand(screenshot.image, band);
    } catch {
      continue;
    }

    const variants = buildOcrVariants(cropped);
    for (const variant of variants) {
      if (Date.now() - startedAt >= timeoutMs) break;

      let ocrText: string;
      try {
        ocrText = await runVariantOcr(
          variant.image,
          perAttemptTimeoutMs,
          `era-band-${variant.id}`,
          ocr,
        );
      } catch {
        continue;
      }

      const hit = detectRelicEraFromText(ocrText);
      if (hit.confidence > best.confidence) {
        best = {
          era: hit.era,
          confidence: hit.confidence,
          textPreview: textPreview(ocrText),
          candidateId: "header-band",
          bandTopRatio: round4(band.top, null),
          bandHeightRatio: round4(band.height, null),
          ocrVariant: variant.id,
        };
      }

      if (best.confidence >= 0.99) break;
    }

    if (best.confidence >= 0.99) break;
  }

  return best;
}

export async function detectRelicSelectionEra(
  options: { timeoutMs?: number; preferredDisplayId?: string | null } = {},
  ocr: {
    runOCR: (imagePath: string, timeoutMs: number) => Promise<string>;
    runOCRBuffer: (buffer: Buffer, timeoutMs: number) => Promise<string>;
  },
  scanSettings: { ocrTimeoutMs: number },
): Promise<RelicEraDetectionResult> {
  const timeoutMs = Math.floor(clampNumber(options.timeoutMs, 600, 12000, 4500));
  const startedAt = Date.now();

  let screenshot: CaptureResult | null;
  try {
    screenshot = await captureScreenFast(options.preferredDisplayId || null);
  } catch (err) {
    log.warn("[RewardScanner] Relic era capture failed:", normalizeErrorMessage(err));
    return {
      era: null,
      confidence: 0,
      elapsedMs: Date.now() - startedAt,
      textPreview: "",
    };
  }

  if (!screenshot?.image) {
    return {
      era: null,
      confidence: 0,
      elapsedMs: Date.now() - startedAt,
      textPreview: "",
    };
  }

  const perAttemptTimeoutMs = Math.max(900, Math.min(scanSettings.ocrTimeoutMs, timeoutMs));
  let best = await scanTileLabels(screenshot, timeoutMs, perAttemptTimeoutMs, startedAt, ocr);

  if (best.confidence < 0.9) {
    const headerBest = await scanHeaderBands(
      screenshot,
      timeoutMs,
      perAttemptTimeoutMs,
      startedAt,
      ocr,
    );
    if (headerBest.confidence > best.confidence) best = headerBest;
  }

  return {
    ...best,
    sourceType: screenshot.sourceType || null,
    sourceName: screenshot.sourceName || null,
    sourceId: screenshot.sourceId || null,
    sourceDisplayId: screenshot.sourceDisplayId || null,
    elapsedMs: Date.now() - startedAt,
  };
}
