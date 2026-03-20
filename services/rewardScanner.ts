"use strict";

/**
 * Reward scanner orchestrator.
 *
 * State management, settings, OCR runner setup, and high-level scan orchestration.
 * Implementation details are split across:
 *   - rewardScannerUtils.ts      (pure math/string utilities)
 *   - rewardScannerCapture.ts    (Electron screen capture)
 *   - rewardScannerImage.ts      (image cropping / enhancement)
 *   - rewardScannerMatch.ts      (OCR text → item matching)
 *   - rewardScannerReadiness.ts  (UI readiness detection)
 */

import { withScope } from "./logger";
const { normalizeErrorMessage } = require("../config/shared/errors.cjs") as {
  normalizeErrorMessage: (err: any) => string;
};

import fs from "fs";
import os from "os";
import path from "path";
import { createRewardOcrRunner } from "./rewardScannerOcr";
const { OVERLAY_SETTINGS_DEFAULTS, OVERLAY_SETTINGS_LIMITS } =
  require("../config/runtime/overlaySettings") as {
    OVERLAY_SETTINGS_DEFAULTS: Record<string, any>;
    OVERLAY_SETTINGS_LIMITS: Record<string, any>;
  };

import { clampNumber, round4 } from "./rewardScannerUtils";
import { captureScreen, captureDebugFrame, captureSourceMeta } from "./rewardScannerCapture";
import {
  cropRewardBand,
  cropBand,
  cropRect,
  buildOcrVariants,
  detectRewardSlotLayout,
} from "./rewardScannerImage";
import {
  matchItemsDetailed,
  chooseBetterOcrPass,
  detectRelicEraFromText,
  detectRelicEraFromTileLabelText,
  buildConsensusSelection,
  MAX_REWARD_SLOTS,
} from "./rewardScannerMatch";
import { waitForRewardUiReady as _waitForRewardUiReady } from "./rewardScannerReadiness";

export { captureDebugFrame, captureSourceMeta };

const log = withScope("rewardScanner");

// --- Paths ------------------------------------------------------------------

const OCR_SCRIPT = path.join(__dirname, "..", "scripts", "ocr.ps1");
const TEMP_IMAGE = path.join(os.tmpdir(), "wf-companion-reward-ocr.png");
const TEMP_ERA_IMAGE = path.join(os.tmpdir(), "wf-companion-era-ocr.png");

const REWARD_SCAN_BUDGET_MIN_MS = 2500;
const REWARD_SCAN_BUDGET_MAX_MS = 9000;

// --- OCR engine constants ---------------------------------------------------

const OCR_ENGINE_AUTO = "auto";
const OCR_ENGINE_WINDOWS = "windows";
const OCR_ENGINE_POWERSHELL = "powershell";
const OCR_ENGINE_TESSERACT = "tesseract";
const OCR_ENGINE_ENV = String(process.env.WF_OCR_ENGINE || OCR_ENGINE_AUTO)
  .trim()
  .toLowerCase();
const TESSERACT_LANGUAGE = "eng";

// --- Relic era scan config --------------------------------------------------

const RELIC_ERA_BANDS: ReadonlyArray<{ top: number; height: number }> = Object.freeze([
  { top: 0.12, height: 0.12 },
  { top: 0.16, height: 0.13 },
  { top: 0.2, height: 0.14 },
]);

const RELIC_ROW_TILE_LABEL_RECTS: ReadonlyArray<{
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}> = Object.freeze([
  { id: "slot-1", x: 0.02, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-2", x: 0.2, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-3", x: 0.38, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-4", x: 0.56, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-5", x: 0.74, y: 0.5, width: 0.18, height: 0.42 },
]);

const OCR_TEXT_PREVIEW_MAX_CHARS = 240;

// --- Crop presets -----------------------------------------------------------

const CROP_PRESETS: Record<string, Array<{ top: number; height: number }>> = {
  balanced: [
    { top: 0.38, height: 0.36 },
    { top: 0.36, height: 0.4 },
    { top: 0.4, height: 0.34 },
  ],
  tight: [
    { top: 0.42, height: 0.3 },
    { top: 0.4, height: 0.32 },
    { top: 0.44, height: 0.28 },
  ],
  wide: [
    { top: 0.34, height: 0.44 },
    { top: 0.32, height: 0.46 },
    { top: 0.36, height: 0.42 },
  ],
};

// --- State ------------------------------------------------------------------

export const DEFAULT_SCAN_SETTINGS: Record<string, any> = OVERLAY_SETTINGS_DEFAULTS;

let relicItems: any[] = [];
let sortedItems: any[] = [];
let scanSettings: Record<string, any> = sanitizeSettings(DEFAULT_SCAN_SETTINGS);

// --- Settings helpers -------------------------------------------------------

function normalizeOcrEngine(value: any, fallback: string = OCR_ENGINE_WINDOWS): string {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  if (v === OCR_ENGINE_WINDOWS || v === OCR_ENGINE_POWERSHELL) return OCR_ENGINE_WINDOWS;
  if (v === OCR_ENGINE_TESSERACT) return OCR_ENGINE_TESSERACT;
  if (v === OCR_ENGINE_AUTO) return OCR_ENGINE_AUTO;
  return fallback;
}

function sanitizeSettings(raw: any): Record<string, any> {
  const candidate = raw && typeof raw === "object" ? raw : {};
  const preset =
    typeof candidate.cropPreset === "string" ? candidate.cropPreset.trim().toLowerCase() : "";

  let cropTopRatio = clampNumber(
    candidate.cropTopRatio,
    OVERLAY_SETTINGS_LIMITS.cropTopRatioMin,
    OVERLAY_SETTINGS_LIMITS.cropTopRatioMax,
    DEFAULT_SCAN_SETTINGS.cropTopRatio,
  );
  let cropHeightRatio = clampNumber(
    candidate.cropHeightRatio,
    OVERLAY_SETTINGS_LIMITS.cropHeightRatioMin,
    OVERLAY_SETTINGS_LIMITS.cropHeightRatioMax,
    DEFAULT_SCAN_SETTINGS.cropHeightRatio,
  );

  const minHeight = OVERLAY_SETTINGS_LIMITS.cropHeightRatioMin;
  if (cropTopRatio + cropHeightRatio > 1.0) {
    cropHeightRatio = Math.max(minHeight, 1.0 - cropTopRatio);
  }
  if (cropTopRatio + cropHeightRatio > 1.0) {
    cropTopRatio = Math.max(0, 1.0 - cropHeightRatio);
  }

  return {
    cropPreset:
      preset === "custom" || CROP_PRESETS[preset] ? preset : DEFAULT_SCAN_SETTINGS.cropPreset,
    cropTopRatio,
    cropHeightRatio,
    ocrEngine: normalizeOcrEngine(candidate.ocrEngine, DEFAULT_SCAN_SETTINGS.ocrEngine),
    ocrPasses: Math.floor(
      clampNumber(
        candidate.ocrPasses,
        OVERLAY_SETTINGS_LIMITS.ocrPassesMin,
        OVERLAY_SETTINGS_LIMITS.ocrPassesMax,
        DEFAULT_SCAN_SETTINGS.ocrPasses,
      ),
    ),
    matchThreshold: clampNumber(
      candidate.matchThreshold,
      OVERLAY_SETTINGS_LIMITS.matchThresholdMin,
      OVERLAY_SETTINGS_LIMITS.matchThresholdMax,
      DEFAULT_SCAN_SETTINGS.matchThreshold,
    ),
    ocrTimeoutMs: Math.floor(
      clampNumber(
        candidate.ocrTimeoutMs,
        OVERLAY_SETTINGS_LIMITS.ocrTimeoutMsMin,
        OVERLAY_SETTINGS_LIMITS.ocrTimeoutMsMax,
        DEFAULT_SCAN_SETTINGS.ocrTimeoutMs,
      ),
    ),
  };
}

export function setRelicItems(items: any[]): void {
  relicItems = Array.isArray(items) ? items : [];
  sortedItems = [...relicItems].sort((a, b) => b.name.length - a.name.length);
  log.log(`[RewardScanner] Item list updated: ${relicItems.length} items`);
}

export function setSettings(nextSettings: any): Record<string, any> {
  scanSettings = sanitizeSettings({ ...scanSettings, ...(nextSettings || {}) });
  return getSettings();
}

export function getSettings(): Record<string, any> {
  return { ...scanSettings };
}

// --- OCR runner setup -------------------------------------------------------

function getRequestedOcrEngine(): string {
  const envEngine = normalizeOcrEngine(OCR_ENGINE_ENV, OCR_ENGINE_AUTO);
  if (envEngine !== OCR_ENGINE_AUTO) return envEngine;
  return normalizeOcrEngine(scanSettings.ocrEngine, OCR_ENGINE_WINDOWS);
}

const { runOCR } = createRewardOcrRunner({
  log,
  getRequestedEngine: getRequestedOcrEngine,
  ocrScriptPath: OCR_SCRIPT,
  tesseractLanguage: TESSERACT_LANGUAGE,
  engineWindows: OCR_ENGINE_WINDOWS,
  engineTesseract: OCR_ENGINE_TESSERACT,
});

// --- Band helpers -----------------------------------------------------------

function getBandsForPasses(
  presetName: string,
  passes: number,
): Array<{ top: number; height: number }> {
  if (presetName === "custom") {
    const customTop = clampNumber(
      scanSettings.cropTopRatio,
      OVERLAY_SETTINGS_LIMITS.cropTopRatioMin,
      OVERLAY_SETTINGS_LIMITS.cropTopRatioMax,
      DEFAULT_SCAN_SETTINGS.cropTopRatio,
    );
    const customHeight = clampNumber(
      scanSettings.cropHeightRatio,
      OVERLAY_SETTINGS_LIMITS.cropHeightRatioMin,
      OVERLAY_SETTINGS_LIMITS.cropHeightRatioMax,
      DEFAULT_SCAN_SETTINGS.cropHeightRatio,
    );

    const bands: Array<{ top: number; height: number }> = [];
    const center = Math.floor(passes / 2);
    for (let i = 0; i < passes; i += 1) {
      const shift = (i - center) * 0.01;
      const shiftedTop = clampNumber(
        customTop + shift,
        0,
        Math.max(0, 1.0 - customHeight),
        customTop,
      );
      bands.push({ top: shiftedTop, height: customHeight });
    }
    return bands;
  }

  const preset = CROP_PRESETS[presetName] || CROP_PRESETS.balanced;
  const bands: Array<{ top: number; height: number }> = [];
  for (let i = 0; i < passes; i += 1) {
    bands.push(preset[i % preset.length]);
  }
  return bands;
}

function getPrimaryBand(): { top: number; height: number } {
  const [band] = getBandsForPasses(scanSettings.cropPreset, 1);
  if (band && Number.isFinite(band.top) && Number.isFinite(band.height)) {
    return band;
  }
  return {
    top: scanSettings.cropTopRatio,
    height: scanSettings.cropHeightRatio,
  };
}

// --- Scan meta builder ------------------------------------------------------

function buildScanMeta({
  screenshot,
  selectedPass,
  passCount,
  strategy,
  elapsedMs,
  hadOcrSuccess,
}: {
  screenshot: any;
  selectedPass: any;
  passCount: number;
  strategy: string;
  elapsedMs: number;
  hadOcrSuccess: boolean;
}): any {
  const captureSize = screenshot?.image?.getSize?.() || { width: 0, height: 0 };
  const band = selectedPass?.band || null;
  const top = band ? round4(band.top, 0) : null;
  const height = band ? round4(band.height, 0) : null;
  const bottom = top != null && height != null ? round4(top + height, null) : null;

  return {
    sourceType: screenshot?.sourceType || null,
    sourceName: screenshot?.sourceName || null,
    sourceId: screenshot?.sourceId || null,
    sourceDisplayId: screenshot?.sourceDisplayId || null,
    captureWidth: captureSize.width,
    captureHeight: captureSize.height,
    passIndex: selectedPass?.passIndex ?? null,
    passCount,
    score: Number.isFinite(selectedPass?.score) ? Number(selectedPass.score.toFixed(3)) : null,
    strategy: strategy || "none",
    hadOcrSuccess: !!hadOcrSuccess,
    bandTopRatio: top,
    bandHeightRatio: height,
    bandBottomRatio: bottom,
    elapsedMs: Math.max(0, Math.round(elapsedMs || 0)),
  };
}

function buildTempImagePath(basePath: string, label: string): string {
  const ext = path.extname(basePath) || ".png";
  const stem = ext ? basePath.slice(0, -ext.length) : basePath;
  const safeLabel = String(label || "scan").replace(/[^a-z0-9_-]+/gi, "-");
  return `${stem}-${safeLabel}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
}

function computeRewardScanBudgetMs(): number {
  const passes = Math.max(1, Math.floor(scanSettings.ocrPasses || 1));
  const perAttempt = Math.max(700, Math.min(Number(scanSettings.ocrTimeoutMs) || 0, 2500));
  return Math.max(
    REWARD_SCAN_BUDGET_MIN_MS,
    Math.min(REWARD_SCAN_BUDGET_MAX_MS, 1200 + passes * 700 + perAttempt),
  );
}

async function scanRewardSlotsFallback(
  screenshot: any,
  expectedCount: number,
  totalBudgetMs: number,
  startedAt: number,
): Promise<{
  items: any[];
  score: number;
  exactCount: number;
  slotCount: number;
  strategy: string;
  slotConfidence: number;
} | null> {
  const layout = detectRewardSlotLayout(screenshot?.image);
  if (!layout.count || layout.confidence < 0.38) return null;

  const slotLimit = Math.min(expectedCount || layout.count, layout.count, MAX_REWARD_SLOTS);
  const collected: any[] = [];
  let score = 0;
  let exactCount = 0;

  for (let i = 0; i < slotLimit; i += 1) {
    const slot = layout.slots[i];
    if (!slot) continue;

    const elapsed = Date.now() - startedAt;
    const remainingBudgetMs = totalBudgetMs - elapsed;
    if (remainingBudgetMs <= 0) break;

    let crop: any;
    try {
      crop = cropRect(screenshot.image, slot.titleRect);
    } catch {
      continue;
    }

    let best: any = null;
    const variants = buildOcrVariants(crop);
    for (const variant of variants) {
      let ocrText = "";
      try {
        const tempPath = buildTempImagePath(TEMP_IMAGE, `reward-slot-${i + 1}-${variant.id}`);
        fs.writeFileSync(tempPath, variant.image.toPNG());
        try {
          ocrText = await runOCR(
            tempPath,
            Math.max(500, Math.min(scanSettings.ocrTimeoutMs, remainingBudgetMs)),
          );
        } finally {
          try {
            fs.unlinkSync(tempPath);
          } catch {
            // best effort temp cleanup
          }
        }
      } catch {
        continue;
      }

      const matched = matchItemsDetailed(ocrText, scanSettings.matchThreshold, sortedItems);
      const candidate = {
        ...matched,
        text: ocrText,
        ocrVariant: variant.id,
      };
      best = chooseBetterOcrPass(best, candidate);
      if (matched.exactCount >= 1) break;
    }

    if (!best?.items?.length) continue;
    const item = best.items[0];
    if (!item) continue;
    collected.push(item);
    score += Number(best.score || 0);
    exactCount += Number(best.exactCount || 0) > 0 ? 1 : 0;
  }

  if (!collected.length) return null;

  return {
    items: collected.slice(0, slotLimit),
    score,
    exactCount,
    slotCount: slotLimit,
    strategy: "slot-fallback",
    slotConfidence: layout.confidence,
  };
}

// --- Relic era detection ----------------------------------------------------

export async function detectRelicSelectionEra(options: any = {}): Promise<{
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
}> {
  const timeoutMs = Math.floor(clampNumber(options.timeoutMs, 600, 12000, 4500));
  const startedAt = Date.now();

  let screenshot: any;
  try {
    screenshot = await captureScreen({
      preferredDisplayId: options.preferredDisplayId || null,
      preferScreenCapture: true,
    });
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
  let best: {
    era: string | null;
    confidence: number;
    textPreview: string;
    candidateId: string | null;
    bandTopRatio: number | null;
    bandHeightRatio: number | null;
    ocrVariant: string | null;
  } = {
    era: null,
    confidence: 0,
    textPreview: "",
    candidateId: null,
    bandTopRatio: null,
    bandHeightRatio: null,
    ocrVariant: null,
  };

  for (const rect of RELIC_ROW_TILE_LABEL_RECTS) {
    let cropped: any;
    try {
      cropped = cropRect(screenshot.image, rect);
    } catch {
      continue;
    }

    const variants = buildOcrVariants(cropped);
    for (const variant of variants) {
      if (Date.now() - startedAt >= timeoutMs) break;

      let ocrText = "";
      try {
        const tempPath = buildTempImagePath(TEMP_ERA_IMAGE, `era-${rect.id}-${variant.id}`);
        fs.writeFileSync(tempPath, variant.image.toPNG());
        try {
          ocrText = await runOCR(tempPath, perAttemptTimeoutMs);
        } finally {
          try {
            fs.unlinkSync(tempPath);
          } catch {
            // best effort temp cleanup
          }
        }
      } catch {
        continue;
      }

      const hit = detectRelicEraFromTileLabelText(ocrText);
      if (hit.confidence > best.confidence) {
        best = {
          era: hit.era,
          confidence: hit.confidence,
          textPreview: String(ocrText || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, OCR_TEXT_PREVIEW_MAX_CHARS),
          candidateId: `tile-${rect.id}`,
          bandTopRatio: round4(rect.y, null),
          bandHeightRatio: round4(rect.height, null),
          ocrVariant: variant.id,
        };
      }

      if (best.confidence >= 0.99) {
        break;
      }
    }

    if (best.confidence >= 0.99) {
      break;
    }
  }

  if (best.confidence < 0.9) {
    for (const band of RELIC_ERA_BANDS) {
      let cropped: any;
      try {
        cropped = cropBand(screenshot.image, band);
      } catch {
        continue;
      }

      const variants = buildOcrVariants(cropped);
      for (const variant of variants) {
        if (Date.now() - startedAt >= timeoutMs) break;

        let ocrText = "";
        try {
          const tempPath = buildTempImagePath(TEMP_ERA_IMAGE, `era-band-${variant.id}`);
          fs.writeFileSync(tempPath, variant.image.toPNG());
          try {
            ocrText = await runOCR(tempPath, perAttemptTimeoutMs);
          } finally {
            try {
              fs.unlinkSync(tempPath);
            } catch {
              // best effort temp cleanup
            }
          }
        } catch {
          continue;
        }

        const hit = detectRelicEraFromText(ocrText);
        if (hit.confidence > best.confidence) {
          best = {
            era: hit.era,
            confidence: hit.confidence,
            textPreview: String(ocrText || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, OCR_TEXT_PREVIEW_MAX_CHARS),
            candidateId: "header-band",
            bandTopRatio: round4(band.top, null),
            bandHeightRatio: round4(band.height, null),
            ocrVariant: variant.id,
          };
        }

        if (best.confidence >= 0.99) {
          break;
        }
      }

      if (best.confidence >= 0.99) {
        break;
      }
    }
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

// --- Main scan orchestrator -------------------------------------------------

export async function scanRewardsDetailed(): Promise<{
  items: any[];
  meta: any;
} | null> {
  if (sortedItems.length === 0) {
    log.warn("[RewardScanner] No relic items loaded - call setRelicItems() first");
    return null;
  }

  const scanStartedAt = Date.now();
  const totalBudgetMs = computeRewardScanBudgetMs();

  let screenshot: any;
  try {
    screenshot = await captureScreen();
  } catch (err) {
    log.error("[RewardScanner] captureScreen error:", normalizeErrorMessage(err));
    return null;
  }
  if (!screenshot) {
    log.warn("[RewardScanner] Could not capture screen");
    return null;
  }

  log.log(
    "[RewardScanner] Scan capture source -> " +
      `${screenshot.sourceType}: ${screenshot.sourceName || screenshot.sourceId || "unknown"} ` +
      `(display:${screenshot.sourceDisplayId || "n/a"})`,
  );

  const threshold = scanSettings.matchThreshold;
  const bands = getBandsForPasses(scanSettings.cropPreset, scanSettings.ocrPasses);
  const detectedLayout = detectRewardSlotLayout(screenshot.image);
  const expectedItemCount =
    detectedLayout.count >= 2 && detectedLayout.confidence >= 0.38
      ? Math.min(detectedLayout.count, MAX_REWARD_SLOTS)
      : MAX_REWARD_SLOTS;

  log.log(
    `[RewardScanner] Slot layout estimate: count=${detectedLayout.count} confidence=${detectedLayout.confidence.toFixed(3)} expected=${expectedItemCount}`,
  );

  let hadOcrSuccess = false;
  const passResults: any[] = [];
  let bestPass: any = null;

  for (let i = 0; i < bands.length; i += 1) {
    if (Date.now() - scanStartedAt >= totalBudgetMs) {
      log.log(`[RewardScanner] scan budget exhausted before pass ${i + 1}/${bands.length}`);
      break;
    }

    let cropped: any;
    try {
      cropped = cropRewardBand(screenshot.image, bands[i]);
    } catch (err) {
      log.error(`[RewardScanner] crop/write failed on pass ${i + 1}:`, normalizeErrorMessage(err));
      continue;
    }

    let passResult: any = null;
    const variants = buildOcrVariants(cropped);

    for (const variant of variants) {
      const elapsed = Date.now() - scanStartedAt;
      const remainingBudgetMs = totalBudgetMs - elapsed;
      if (remainingBudgetMs <= 0) {
        log.log(`[RewardScanner] scan budget exhausted before OCR on pass ${i + 1}`);
        break;
      }

      let ocrText: string;
      try {
        const tempPath = buildTempImagePath(TEMP_IMAGE, `reward-p${i + 1}-${variant.id}`);
        fs.writeFileSync(tempPath, variant.image.toPNG());
        try {
          ocrText = await runOCR(
            tempPath,
            Math.max(700, Math.min(scanSettings.ocrTimeoutMs, remainingBudgetMs)),
          );
        } finally {
          try {
            fs.unlinkSync(tempPath);
          } catch {
            // best effort temp cleanup
          }
        }
        hadOcrSuccess = true;
      } catch (err) {
        log.error(
          `[RewardScanner] OCR failed on pass ${i + 1} (${variant.id}):`,
          normalizeErrorMessage(err),
        );
        continue;
      }

      const matched = matchItemsDetailed(ocrText, threshold, sortedItems);
      const candidate = {
        ...matched,
        passIndex: i + 1,
        band: bands[i],
        text: ocrText,
        ocrVariant: variant.id,
      };

      passResult = chooseBetterOcrPass(passResult, candidate);

      if (matched.items.length >= expectedItemCount && matched.exactCount >= expectedItemCount) {
        break;
      }
    }

    if (!passResult) {
      continue;
    }

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

  if (!hadOcrSuccess) {
    return null;
  }

  const consensus = buildConsensusSelection(passResults);
  const selectedPass = consensus?.selectedPass || bestPass || passResults[0] || null;
  let items = (consensus?.items || selectedPass?.items || []).slice(0, expectedItemCount);
  let finalStrategy = consensus?.strategy || "best-pass";

  if (items.length < expectedItemCount) {
    const slotFallback = await scanRewardSlotsFallback(
      screenshot,
      expectedItemCount,
      totalBudgetMs,
      scanStartedAt,
    );
    if (slotFallback && slotFallback.items.length > items.length) {
      items = slotFallback.items;
      finalStrategy = slotFallback.strategy;
      log.log(
        `[RewardScanner] Slot fallback improved result: ${slotFallback.items.length}/${expectedItemCount} items ` +
          `(exact=${slotFallback.exactCount}, confidence=${slotFallback.slotConfidence.toFixed(3)})`,
      );
    }
  }

  if (items.length > 0) {
    log.log(
      `[RewardScanner] Detected (${finalStrategy} pass ${selectedPass?.passIndex ?? "?"}, ` +
        `score ${Number(selectedPass?.score || 0).toFixed(2)}, variant ${selectedPass?.ocrVariant || "raw"}):`,
      items.map((item: any) => item.name).join(" | "),
    );
  } else {
    const textPreview = selectedPass?.text
      ? selectedPass.text.slice(0, OCR_TEXT_PREVIEW_MAX_CHARS).replace(/\s+/g, " ")
      : "";
    if (textPreview) {
      log.log("[RewardScanner] No items matched OCR text:", textPreview);
    } else {
      log.log("[RewardScanner] No items matched OCR text");
    }
  }

  const meta = buildScanMeta({
    screenshot,
    selectedPass,
    passCount: bands.length,
    strategy: finalStrategy,
    elapsedMs: Date.now() - scanStartedAt,
    hadOcrSuccess,
  });

  return {
    items,
    meta,
  };
}

export async function scanRewards(): Promise<any[] | null> {
  const detailed = await scanRewardsDetailed();
  if (!detailed) return null;
  return detailed.items;
}

export function waitForRewardUiReady(options?: any): Promise<any> {
  return _waitForRewardUiReady(options, getPrimaryBand);
}
