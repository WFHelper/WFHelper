"use strict";

/**
 * Reward scanner orchestrator.
 *
 * State management, settings, OCR runner setup, and high-level scan orchestration.
 * Implementation details are split across:
 *   - rewardScannerUtils.js      (pure math/string utilities)
 *   - rewardScannerCapture.js    (Electron screen capture)
 *   - rewardScannerImage.js      (image cropping / enhancement)
 *   - rewardScannerMatch.js      (OCR text → item matching)
 *   - rewardScannerReadiness.js  (UI readiness detection)
 */

const log = require("./logger").withScope("rewardScanner");
const { normalizeErrorMessage } = require("../config/shared/errors.cjs");

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRewardOcrRunner } = require("./rewardScannerOcr");
const {
  OVERLAY_SETTINGS_DEFAULTS,
  OVERLAY_SETTINGS_LIMITS,
} = require("../config/runtime/overlaySettings");

const { clampNumber, round4 } = require("./rewardScannerUtils");
const { captureScreen, captureDebugFrame, captureSourceMeta } = require("./rewardScannerCapture");
const { cropRewardBand, cropBand, cropRect, buildOcrVariants } = require("./rewardScannerImage");
const {
  matchItemsDetailed,
  chooseBetterOcrPass,
  detectRelicEraFromText,
  detectRelicEraFromTileLabelText,
  buildConsensusSelection,
  MAX_REWARD_SLOTS,
} = require("./rewardScannerMatch");
const { waitForRewardUiReady } = require("./rewardScannerReadiness");

// --- Paths ------------------------------------------------------------------

const OCR_SCRIPT = path.join(__dirname, "..", "scripts", "ocr.ps1");
const TEMP_IMAGE = path.join(os.tmpdir(), "wf-companion-reward-ocr.png");
const TEMP_ERA_IMAGE = path.join(os.tmpdir(), "wf-companion-era-ocr.png");

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

const RELIC_ERA_BANDS = Object.freeze([
  { top: 0.12, height: 0.12 },
  { top: 0.16, height: 0.13 },
  { top: 0.2, height: 0.14 },
]);

const RELIC_ROW_TILE_LABEL_RECTS = Object.freeze([
  { id: "slot-1", x: 0.02, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-2", x: 0.2, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-3", x: 0.38, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-4", x: 0.56, y: 0.5, width: 0.18, height: 0.42 },
  { id: "slot-5", x: 0.74, y: 0.5, width: 0.18, height: 0.42 },
]);

const OCR_TEXT_PREVIEW_MAX_CHARS = 240;

// --- Crop presets -----------------------------------------------------------

const CROP_PRESETS = {
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

const DEFAULT_SCAN_SETTINGS = OVERLAY_SETTINGS_DEFAULTS;

let relicItems = [];
let sortedItems = [];
let scanSettings = sanitizeSettings(DEFAULT_SCAN_SETTINGS);

// --- Settings helpers -------------------------------------------------------

function normalizeOcrEngine(value, fallback = OCR_ENGINE_WINDOWS) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  if (v === OCR_ENGINE_WINDOWS || v === OCR_ENGINE_POWERSHELL) return OCR_ENGINE_WINDOWS;
  if (v === OCR_ENGINE_TESSERACT) return OCR_ENGINE_TESSERACT;
  if (v === OCR_ENGINE_AUTO) return OCR_ENGINE_AUTO;
  return fallback;
}

function sanitizeSettings(raw) {
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

function setRelicItems(items) {
  relicItems = Array.isArray(items) ? items : [];
  sortedItems = [...relicItems].sort((a, b) => b.name.length - a.name.length);
  log.log(`[RewardScanner] Item list updated: ${relicItems.length} items`);
}

function setSettings(nextSettings) {
  scanSettings = sanitizeSettings({ ...scanSettings, ...(nextSettings || {}) });
  return getSettings();
}

function getSettings() {
  return { ...scanSettings };
}

// --- OCR runner setup -------------------------------------------------------

function getRequestedOcrEngine() {
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

function getBandsForPasses(presetName, passes) {
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

    const bands = [];
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
  const bands = [];
  for (let i = 0; i < passes; i += 1) {
    bands.push(preset[i % preset.length]);
  }
  return bands;
}

function getPrimaryBand() {
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
}) {
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

// --- Relic era detection ----------------------------------------------------

async function detectRelicSelectionEra(options = {}) {
  const timeoutMs = Math.floor(clampNumber(options.timeoutMs, 600, 12000, 4500));
  const startedAt = Date.now();

  let screenshot;
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
  let best = {
    era: null,
    confidence: 0,
    textPreview: "",
    candidateId: null,
    bandTopRatio: null,
    bandHeightRatio: null,
    ocrVariant: null,
  };

  for (const rect of RELIC_ROW_TILE_LABEL_RECTS) {
    let cropped;
    try {
      cropped = cropRect(screenshot.image, rect);
    } catch {
      continue;
    }

    const variants = buildOcrVariants(cropped);
    for (const variant of variants) {
      if (Date.now() - startedAt >= timeoutMs) break;

      try {
        fs.writeFileSync(TEMP_ERA_IMAGE, variant.image.toPNG());
      } catch {
        continue;
      }

      let ocrText;
      try {
        ocrText = await runOCR(TEMP_ERA_IMAGE, perAttemptTimeoutMs);
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
      let cropped;
      try {
        cropped = cropBand(screenshot.image, band);
      } catch {
        continue;
      }

      const variants = buildOcrVariants(cropped);
      for (const variant of variants) {
        if (Date.now() - startedAt >= timeoutMs) break;

        try {
          fs.writeFileSync(TEMP_ERA_IMAGE, variant.image.toPNG());
        } catch {
          continue;
        }

        let ocrText;
        try {
          ocrText = await runOCR(TEMP_ERA_IMAGE, perAttemptTimeoutMs);
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

async function scanRewardsDetailed() {
  if (sortedItems.length === 0) {
    log.warn("[RewardScanner] No relic items loaded - call setRelicItems() first");
    return null;
  }

  const scanStartedAt = Date.now();

  let screenshot;
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

  let hadOcrSuccess = false;
  const passResults = [];
  let bestPass = null;

  for (let i = 0; i < bands.length; i += 1) {
    let cropped;
    try {
      cropped = cropRewardBand(screenshot.image, bands[i]);
    } catch (err) {
      log.error(`[RewardScanner] crop/write failed on pass ${i + 1}:`, normalizeErrorMessage(err));
      continue;
    }

    let passResult = null;
    const variants = buildOcrVariants(cropped);

    for (const variant of variants) {
      let ocrText;
      try {
        fs.writeFileSync(TEMP_IMAGE, variant.image.toPNG());
        ocrText = await runOCR(TEMP_IMAGE, scanSettings.ocrTimeoutMs);
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

      if (matched.items.length === MAX_REWARD_SLOTS && matched.exactCount === MAX_REWARD_SLOTS) {
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
      passResult.items.length === MAX_REWARD_SLOTS &&
      passResult.exactCount === MAX_REWARD_SLOTS
    ) {
      break;
    }
  }

  if (!hadOcrSuccess) {
    return null;
  }

  const consensus = buildConsensusSelection(passResults);
  const selectedPass = consensus?.selectedPass || bestPass || passResults[0] || null;
  const items = (consensus?.items || selectedPass?.items || []).slice(0, MAX_REWARD_SLOTS);

  if (items.length > 0) {
    log.log(
      `[RewardScanner] Detected (${consensus?.strategy || "best-pass"} pass ${selectedPass?.passIndex ?? "?"}, ` +
        `score ${Number(selectedPass?.score || 0).toFixed(2)}, variant ${selectedPass?.ocrVariant || "raw"}):`,
      items.map((item) => item.name).join(" | "),
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
    strategy: consensus?.strategy || "best-pass",
    elapsedMs: Date.now() - scanStartedAt,
    hadOcrSuccess,
  });

  return {
    items,
    meta,
  };
}

async function scanRewards() {
  const detailed = await scanRewardsDetailed();
  if (!detailed) return null;
  return detailed.items;
}

module.exports = {
  DEFAULT_SCAN_SETTINGS,
  setRelicItems,
  setSettings,
  getSettings,
  captureDebugFrame,
  captureSourceMeta,
  detectRelicSelectionEra,
  scanRewards,
  scanRewardsDetailed,
  waitForRewardUiReady: (options) => waitForRewardUiReady(options, getPrimaryBand),
};
