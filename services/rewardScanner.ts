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
import crypto from "node:crypto";
import os from "os";
import path from "path";
import { createRewardOcrRunner } from "./rewardScannerOcr";
const { OVERLAY_SETTINGS_DEFAULTS, OVERLAY_SETTINGS_LIMITS } =
  require("../config/runtime/overlaySettings") as {
    OVERLAY_SETTINGS_DEFAULTS: Record<string, any>;
    OVERLAY_SETTINGS_LIMITS: Record<string, any>;
  };

import { clampNumber, round4, luminanceFromBgr } from "./rewardScannerUtils";
import { captureScreenFast, captureDebugFrame, captureSourceMeta } from "./rewardScannerCapture";
import {
  cropRewardBand,
  cropBand,
  cropRect,
  buildOcrVariants,
  detectRewardSlotLayout,
  detectConsoleOpen,
} from "./rewardScannerImage";
import {
  matchItemsDetailed,
  rankRewardCandidatesDetailed,
  chooseBetterOcrPass,
  detectRelicEraFromText,
  detectRelicEraFromTileLabelText,
  buildConsensusSelection,
  MAX_REWARD_SLOTS,
} from "./rewardScannerMatch";
import { waitForRewardUiReady as _waitForRewardUiReady } from "./rewardScannerReadiness";

export { captureDebugFrame, captureSourceMeta };

const log = withScope("rewardScanner");

// --- Per-scan instrumentation (F4) -----------------------------------------

export interface TriggerStats {
  captureCount: number;
  captureMs: number;
  ocrCallCount: number;
  ocrTotalMs: number;
  slotDetectMs: number;
  strategy: string;
  failureReason: string | null;
}

let _lastTriggerStats: TriggerStats | null = null;

export function getLastTriggerStats(): TriggerStats | null {
  return _lastTriggerStats ? { ..._lastTriggerStats } : null;
}

// --- Temporal result smoother (F6) -----------------------------------------

const TEMPORAL_WINDOW_MS = 12_000;
const TEMPORAL_MAX_RESULTS = 5;

interface TemporalEntry {
  items: any[];
  expectedCount: number;
  ts: number;
}

const _recentScanEntries: TemporalEntry[] = [];

function recordTemporalEntry(items: any[], expectedCount: number): void {
  _recentScanEntries.push({ items: items.slice(), expectedCount, ts: Date.now() });
  while (_recentScanEntries.length > TEMPORAL_MAX_RESULTS) _recentScanEntries.shift();
}

function findTemporalFallback(items: any[], expectedCount: number): any[] | null {
  if (items.length >= expectedCount) return null;
  const now = Date.now();
  const recent = _recentScanEntries.filter(
    (e) => now - e.ts < TEMPORAL_WINDOW_MS && e.items.length >= expectedCount,
  );
  if (recent.length < 2) return null;
  return recent[recent.length - 1].items;
}

// --- Low-information crop filter (F7) --------------------------------------

function hasSufficientTextureForOcr(nativeImage: any): boolean {
  try {
    const { width, height } = nativeImage.getSize();
    const bitmap: Buffer = nativeImage.toBitmap();
    const step = Math.max(1, Math.floor(Math.max(width, height) / 40));
    let minLum = 255;
    let maxLum = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const idx = (y * width + x) * 4;
        const lum = luminanceFromBgr(bitmap[idx], bitmap[idx + 1], bitmap[idx + 2]);
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
        if (maxLum - minLum >= 18) return true;
      }
    }
    return maxLum - minLum >= 18;
  } catch {
    return true;
  }
}

// --- Frame dedup state (Step 3) --------------------------------------------

let _lastFrameHash: string | null = null;
let _lastFrameResult: { items: any[]; meta: any } | null = null;
const FRAME_DEDUP_TTL_MS = 5_000;
let _lastFrameHashTs = 0;

function computeFrameHash(nativeImage: any): string | null {
  try {
    const bitmap: Buffer = nativeImage.toBitmap();
    // Sample every 256th byte for speed — still unique enough for dedup
    const sample = Buffer.alloc(Math.ceil(bitmap.length / 256));
    for (let i = 0; i < sample.length; i++) {
      sample[i] = bitmap[i * 256];
    }
    return crypto.createHash("sha1").update(sample).digest("hex");
  } catch {
    return null;
  }
}

export function resetFrameDedup(): void {
  _lastFrameHash = null;
  _lastFrameResult = null;
  _lastFrameHashTs = 0;
}

// --- Adaptive strategy tracker (Step 8) ------------------------------------
// Remembers which band index and OCR variant produced the best results, and
// tries them first on subsequent scans to reduce average OCR calls.

interface StrategyWin {
  bandIndex: number;
  variantId: string;
  score: number;
  timestamp: number;
}

const STRATEGY_HISTORY_MAX = 10;
const STRATEGY_HISTORY_TTL_MS = 300_000; // 5 minutes
const _strategyHistory: StrategyWin[] = [];

function recordStrategyWin(bandIndex: number, variantId: string, score: number): void {
  _strategyHistory.push({ bandIndex, variantId, score, timestamp: Date.now() });
  if (_strategyHistory.length > STRATEGY_HISTORY_MAX) {
    _strategyHistory.shift();
  }
}

/** Returns the preferred band index and variant to try first, or null. */
export function getAdaptiveStrategyHint(): { bandIndex: number; variantId: string } | null {
  const now = Date.now();
  const recent = _strategyHistory.filter((w) => now - w.timestamp < STRATEGY_HISTORY_TTL_MS);
  if (recent.length < 2) return null;

  // Count wins per band index
  const bandCounts = new Map<number, number>();
  const variantCounts = new Map<string, number>();
  for (const win of recent) {
    bandCounts.set(win.bandIndex, (bandCounts.get(win.bandIndex) || 0) + 1);
    variantCounts.set(win.variantId, (variantCounts.get(win.variantId) || 0) + 1);
  }

  let bestBand = -1;
  let bestBandCount = 0;
  for (const [band, count] of bandCounts) {
    if (count > bestBandCount) {
      bestBand = band;
      bestBandCount = count;
    }
  }

  let bestVariant = "raw";
  let bestVariantCount = 0;
  for (const [variant, count] of variantCounts) {
    if (count > bestVariantCount) {
      bestVariant = variant;
      bestVariantCount = count;
    }
  }

  return bestBand >= 0 ? { bandIndex: bestBand, variantId: bestVariant } : null;
}

// --- Paths ------------------------------------------------------------------

const OCR_SCRIPT = path.join(__dirname, "..", "scripts", "ocr.ps1");
const TEMP_IMAGE = path.join(os.tmpdir(), "wf-companion-reward-ocr.png");
const REWARD_SCAN_BUDGET_MIN_MS = 1800;
const REWARD_SCAN_BUDGET_MAX_MS = 5000;

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

  return {
    cropPreset: "balanced",
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
  const prev = scanSettings;
  scanSettings = sanitizeSettings({ ...scanSettings, ...(nextSettings || {}) });

  // Invalidate frame dedup when user changes OCR engine or matching threshold,
  // so a cached result from the old settings doesn't persist.
  if (
    prev.ocrEngine !== scanSettings.ocrEngine ||
    prev.matchThreshold !== scanSettings.matchThreshold
  ) {
    resetFrameDedup();
  }

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

const { runOCR, runOCRBuffer, runOCRStructuredBuffer } = createRewardOcrRunner({
  log,
  getRequestedEngine: getRequestedOcrEngine,
  ocrScriptPath: OCR_SCRIPT,
  tesseractLanguage: TESSERACT_LANGUAGE,
  engineWindows: OCR_ENGINE_WINDOWS,
  engineTesseract: OCR_ENGINE_TESSERACT,
  tesseractContext: "reward",
});

// --- Band helpers -----------------------------------------------------------

function getBandsForPasses(
  presetName: string,
  passes: number,
): Array<{ top: number; height: number }> {
  const preset = CROP_PRESETS[presetName] || CROP_PRESETS.balanced;
  const bands: Array<{ top: number; height: number }> = [];
  for (let i = 0; i < passes; i += 1) {
    bands.push(preset[i % preset.length]);
  }
  return bands;
}

function getPrimaryBand(): { top: number; height: number } {
  return getBandsForPasses(scanSettings.cropPreset, 1)[0];
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
    exactCount: typeof selectedPass?.exactCount === "number" ? selectedPass.exactCount : null,
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
  const perAttempt = Math.max(500, Math.min(Number(scanSettings.ocrTimeoutMs) || 0, 2000));
  return Math.max(
    REWARD_SCAN_BUDGET_MIN_MS,
    Math.min(REWARD_SCAN_BUDGET_MAX_MS, 800 + passes * 500 + perAttempt),
  );
}

async function runVariantOcr(variantImage: any, timeoutMs: number, label: string): Promise<string> {
  const pngBuffer: Buffer = variantImage.toPNG();
  try {
    return await runOCRBuffer(pngBuffer, timeoutMs);
  } catch {
    const tempPath = buildTempImagePath(TEMP_IMAGE, label);
    fs.writeFileSync(tempPath, pngBuffer);
    try {
      return await runOCR(tempPath, timeoutMs);
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // best effort temp cleanup
      }
    }
  }
}

function extractRewardTitleTexts(structured: any): string[] {
  const lines = Array.isArray(structured?.lines) ? structured.lines : [];
  const text = String(structured?.text || "").trim();
  if (lines.length === 0) return text ? [text] : [];

  const bottoms = lines.map(
    (line: any) => Number(line?.box?.top || 0) + Number(line?.box?.height || 0),
  );
  const maxBottom = Math.max(...bottoms, 1);
  const bottomLines = lines
    .filter((line: any) => Number(line?.box?.top || 0) >= maxBottom * 0.45)
    .map((line: any) => String(line?.text || "").trim())
    .filter(Boolean);
  const lastTwo = lines
    .slice(-2)
    .map((line: any) => String(line?.text || "").trim())
    .filter(Boolean);
  const candidates = new Set<string>();
  if (bottomLines.length) candidates.add(bottomLines.join(" "));
  if (lastTwo.length) candidates.add(lastTwo.join(" "));
  if (text) candidates.add(text);
  return [...candidates].filter((candidate) => candidate.length > 0);
}

function chooseUniqueRewardAssignments(
  slotCandidates: Array<Array<{ item: any; confidence: number; score: number; mode: string }>>,
): Array<{ item: any; confidence: number; score: number; mode: string } | null> {
  let bestScore = -Infinity;
  let best: Array<{ item: any; confidence: number; score: number; mode: string } | null> =
    new Array(slotCandidates.length).fill(null);

  function visit(
    index: number,
    usedNames: Set<string>,
    current: Array<{ item: any; confidence: number; score: number; mode: string } | null>,
    score: number,
  ): void {
    if (index >= slotCandidates.length) {
      if (score > bestScore) {
        bestScore = score;
        best = current.slice();
      }
      return;
    }

    const candidates = slotCandidates[index] || [];
    let visited = false;
    for (const candidate of candidates.slice(0, 5)) {
      const name = candidate.item?.name;
      if (!name || usedNames.has(name)) continue;
      visited = true;
      usedNames.add(name);
      current[index] = candidate;
      visit(index + 1, usedNames, current, score + Number(candidate.score || 0));
      usedNames.delete(name);
      current[index] = null;
    }

    if (!visited) {
      current[index] = null;
      visit(index + 1, usedNames, current, score - 25);
    }
  }

  visit(0, new Set<string>(), new Array(slotCandidates.length).fill(null), 0);
  return best;
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
  const slotResults = await Promise.all(
    layout.slots.slice(0, slotLimit).map(async (slot, i) => {
      const elapsed = Date.now() - startedAt;
      const remainingBudgetMs = totalBudgetMs - elapsed;
      if (remainingBudgetMs <= 0) return null;

      let crop: any;
      try {
        crop = cropRect(screenshot.image, slot.titleRect);
      } catch {
        return null;
      }

      const rankedCandidates: Array<{
        item: any;
        confidence: number;
        score: number;
        mode: string;
      }> = [];
      const variants = buildOcrVariants(crop);
      for (const variant of variants) {
        try {
          const pngBuffer: Buffer = variant.image.toPNG();
          const structured = await runOCRStructuredBuffer(
            pngBuffer,
            Math.max(500, Math.min(scanSettings.ocrTimeoutMs, remainingBudgetMs)),
          );
          const candidateTexts = extractRewardTitleTexts(structured);
          for (const candidateText of candidateTexts) {
            const ranked = rankRewardCandidatesDetailed(candidateText, sortedItems, 4)
              .filter((candidate) => !!candidate.item)
              .map((candidate) => ({
                item: candidate.item,
                confidence: candidate.confidence,
                score: candidate.score + (variant.id === "raw" ? 2 : 0),
                mode: candidate.mode,
              }));
            rankedCandidates.push(...ranked);
          }
        } catch {
          continue;
        }
      }

      if (rankedCandidates.length === 0) return null;
      rankedCandidates.sort((a, b) => b.score - a.score || b.confidence - a.confidence);
      return {
        index: i,
        candidates: rankedCandidates,
      };
    }),
  );

  const orderedCandidates = slotResults
    .filter(
      (
        entry,
      ): entry is {
        index: number;
        candidates: Array<{ item: any; confidence: number; score: number; mode: string }>;
      } => !!entry,
    )
    .sort((a, b) => a.index - b.index);

  const assigned = chooseUniqueRewardAssignments(
    orderedCandidates.map((entry) => entry.candidates),
  );
  const collected = orderedCandidates
    .map((entry, idx) => ({
      index: entry.index,
      candidate: assigned[idx] || entry.candidates[0] || null,
    }))
    .filter(
      (
        entry,
      ): entry is {
        index: number;
        candidate: { item: any; confidence: number; score: number; mode: string };
      } => !!entry.candidate,
    );

  const score = collected.reduce((sum, entry) => sum + Number(entry.candidate.score || 0), 0);
  const exactCount = collected.reduce(
    (sum, entry) => sum + (entry.candidate.mode === "exact" ? 1 : 0),
    0,
  );

  if (!collected.length) return null;

  return {
    items: collected.map((entry) => entry.candidate.item).slice(0, slotLimit),
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

      let ocrText: string;
      try {
        ocrText = await runVariantOcr(
          variant.image,
          perAttemptTimeoutMs,
          `era-${rect.id}-${variant.id}`,
        );
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

        let ocrText: string;
        try {
          ocrText = await runVariantOcr(
            variant.image,
            perAttemptTimeoutMs,
            `era-band-${variant.id}`,
          );
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

/** Accepted pre-captured screenshot shape — same as CaptureResult from rewardScannerCapture. */
export interface PreCaptureResult {
  image: any;
  sourceType: string | null;
  sourceName: string | null;
  sourceId: string | null;
  sourceDisplayId: string | null;
}

export async function scanRewardsDetailed(
  preCapture?: PreCaptureResult | null,
): Promise<{
  items: any[];
  meta: any;
} | null> {
  if (sortedItems.length === 0) {
    log.warn("[RewardScanner] No relic items loaded - call setRelicItems() first");
    return null;
  }

  const scanStartedAt = Date.now();
  const totalBudgetMs = computeRewardScanBudgetMs();

  // F4 instrumentation counters
  let captureCountStat = 0;
  let captureMs = 0;
  let ocrCallCount = 0;
  let ocrTotalMs = 0;

  let screenshot: any;
  if (preCapture?.image) {
    // F2: caller supplied pre-captured screenshot — skip capture entirely
    screenshot = preCapture;
    log.log(
      "[RewardScanner] Using pre-captured screenshot" +
        ` (${preCapture.sourceType || "file"}:${preCapture.sourceName || preCapture.sourceId || "injected"})`,
    );
  } else {
    const captureStart = Date.now();
    captureCountStat = 1;
    try {
      screenshot = await captureScreenFast();
    } catch (err) {
      log.error("[RewardScanner] captureScreen error:", normalizeErrorMessage(err));
      _lastTriggerStats = { captureCount: captureCountStat, captureMs: Date.now() - captureStart, ocrCallCount: 0, ocrTotalMs: 0, slotDetectMs: 0, strategy: "failed", failureReason: "capture-error" };
      return null;
    }
    captureMs = Date.now() - captureStart;
    if (!screenshot) {
      log.warn("[RewardScanner] Could not capture screen");
      _lastTriggerStats = { captureCount: captureCountStat, captureMs, ocrCallCount: 0, ocrTotalMs: 0, slotDetectMs: 0, strategy: "failed", failureReason: "capture-null" };
      return null;
    }
    log.log(
      "[RewardScanner] Scan capture source -> " +
        `${screenshot.sourceType}: ${screenshot.sourceName || screenshot.sourceId || "unknown"} ` +
        `(display:${screenshot.sourceDisplayId || "n/a"})`,
    );
  }

  if (detectConsoleOpen(screenshot.image)) {
    log.log("[RewardScanner] Chat console detected — skipping scan");
    return null;
  }

  // Frame dedup: skip OCR if the captured frame is identical to the previous one
  const frameHash = computeFrameHash(screenshot.image);
  if (
    frameHash &&
    frameHash === _lastFrameHash &&
    _lastFrameResult &&
    Date.now() - _lastFrameHashTs < FRAME_DEDUP_TTL_MS
  ) {
    log.log("[RewardScanner] Frame unchanged — returning cached result");
    return _lastFrameResult;
  }

  const threshold = scanSettings.matchThreshold;
  const bands = getBandsForPasses(scanSettings.cropPreset, scanSettings.ocrPasses);

  // Adaptive strategy: reorder bands so the historically-winning band is tried first
  const adaptiveHint = getAdaptiveStrategyHint();
  if (adaptiveHint && adaptiveHint.bandIndex > 0 && adaptiveHint.bandIndex < bands.length) {
    const hintBand = bands[adaptiveHint.bandIndex];
    bands.splice(adaptiveHint.bandIndex, 1);
    bands.unshift(hintBand);
  }

  const slotDetectStart = Date.now();
  const detectedLayout = detectRewardSlotLayout(screenshot.image);
  const slotDetectMs = Date.now() - slotDetectStart;
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
  let slotFirstResult: Awaited<ReturnType<typeof scanRewardSlotsFallback>> | null = null;

  if (detectedLayout.count >= 2 && detectedLayout.confidence >= 0.38) {
    slotFirstResult = await scanRewardSlotsFallback(
      screenshot,
      expectedItemCount,
      totalBudgetMs,
      scanStartedAt,
    );
    const slotFirst = slotFirstResult;
    if (
      slotFirst &&
      slotFirst.items.length >= expectedItemCount
    ) {
      // F1: accept slot-primary hit when all expected slots are filled.
      // exactCount is intentionally NOT required here — fuzzy word-overlap matches
      // for Prime item names are reliable enough and slot geometry already validated.
      log.log(
        `[RewardScanner] Early slot-primary hit: ${slotFirst.items.length}/${expectedItemCount} items ` +
          `(exact=${slotFirst.exactCount}, confidence=${slotFirst.slotConfidence.toFixed(3)})`,
      );
      const meta = buildScanMeta({
        screenshot,
        selectedPass: {
          passIndex: 0,
          score: slotFirst.score,
          ocrVariant: "slot-primary",
          band: null,
          exactCount: slotFirst.exactCount,
        },
        passCount: bands.length,
        strategy: slotFirst.strategy,
        elapsedMs: Date.now() - scanStartedAt,
        hadOcrSuccess: true,
      });

      const result = { items: slotFirst.items, meta };
      if (frameHash) {
        _lastFrameHash = frameHash;
        _lastFrameResult = result;
        _lastFrameHashTs = Date.now();
      }
      recordTemporalEntry(slotFirst.items, expectedItemCount);
      _lastTriggerStats = { captureCount: captureCountStat, captureMs, ocrCallCount, ocrTotalMs, slotDetectMs, strategy: slotFirst.strategy, failureReason: null };
      return result;
    }

    // Partial slot-first success: only skip band-OCR when we matched ≥75% of
    // expected items AND we're already deep into the time budget (>70% elapsed) OR
    // when we have 100% fill but with only fuzzy/low-confidence matches.
    // This prevents prematurely skipping a Prime item in the last slot.
    const elapsedRatio = (Date.now() - scanStartedAt) / totalBudgetMs;
    if (
      slotFirst &&
      slotFirst.items.length >= Math.ceil(expectedItemCount * 0.75) &&
      (elapsedRatio >= 0.7 || slotFirst.items.length === expectedItemCount)
    ) {
      log.log(
        `[RewardScanner] Partial slot-primary hit: ${slotFirst.items.length}/${expectedItemCount} items ` +
          `(exact=${slotFirst.exactCount}, confidence=${slotFirst.slotConfidence.toFixed(3)}) — skipping band OCR`,
      );
      const meta = buildScanMeta({
        screenshot,
        selectedPass: {
          passIndex: 0,
          score: slotFirst.score,
          ocrVariant: "slot-primary-partial",
          band: null,
          exactCount: slotFirst.exactCount,
        },
        passCount: bands.length,
        strategy: "slot-partial",
        elapsedMs: Date.now() - scanStartedAt,
        hadOcrSuccess: true,
      });

      const result = { items: slotFirst.items, meta };
      if (frameHash) {
        _lastFrameHash = frameHash;
        _lastFrameResult = result;
        _lastFrameHashTs = Date.now();
      }
      return result;
    }
  }

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

        // F7: skip near-empty crops before spending an OCR call
      if (!hasSufficientTextureForOcr(variant.image)) {
        log.log(`[RewardScanner] Skipping low-texture crop (pass ${i + 1} ${variant.id})`);
        continue;
      }

      // F5: use structured OCR to separate title lines geometrically
      let matched: ReturnType<typeof matchItemsDetailed> | null = null;
      let ocrTextForLog: string;
      try {
        const pngBuf = variant.image.toPNG();
        const ocrStart = Date.now();
        const structured = await runOCRStructuredBuffer(
          pngBuf,
          Math.max(700, Math.min(scanSettings.ocrTimeoutMs, remainingBudgetMs)),
        );
        ocrTotalMs += Date.now() - ocrStart;
        ocrCallCount++;
        hadOcrSuccess = true;
        const candidateTexts = extractRewardTitleTexts(structured);
        ocrTextForLog = structured.text || "";
        for (const ctext of candidateTexts) {
          const m = matchItemsDetailed(ctext, threshold, sortedItems);
          if (!matched || m.score > matched.score) matched = m;
        }
        if (!matched) matched = matchItemsDetailed(structured.text || "", threshold, sortedItems);
      } catch (err) {
        log.error(
          `[RewardScanner] OCR failed on pass ${i + 1} (${variant.id}):`,
          normalizeErrorMessage(err),
        );
        continue;
      }

      const candidate = {
        ...matched,
        passIndex: i + 1,
        band: bands[i],
        text: ocrTextForLog,
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

  if (
    slotFirstResult &&
    (slotFirstResult.items.length > items.length ||
      (slotFirstResult.items.length === items.length && slotFirstResult.exactCount > 0))
  ) {
    items = slotFirstResult.items.slice(0, expectedItemCount);
    finalStrategy = slotFirstResult.strategy;
  }

  if (items.length < expectedItemCount) {
    // F3: reuse the already-computed slotFirstResult if available; avoids a second
    // scanRewardSlotsFallback call which would duplicate all the OCR work.
    const slotFallback =
      slotFirstResult && slotFirstResult.items.length > 0
        ? slotFirstResult
        : await scanRewardSlotsFallback(screenshot, expectedItemCount, totalBudgetMs, scanStartedAt);
    if (slotFallback && slotFallback.items.length > items.length) {
      items = slotFallback.items;
      finalStrategy = slotFallback.strategy;
      log.log(
        `[RewardScanner] Slot fallback improved result: ${slotFallback.items.length}/${expectedItemCount} items ` +
          `(exact=${slotFallback.exactCount}, confidence=${slotFallback.slotConfidence.toFixed(3)})`,
      );
    }
  }

  // F6: temporal consistency — if current result is sparse but recent full results
  // confirm there should be more items, use the last confirmed full result instead
  // of showing a partially-detected overlay.
  const temporalFallback = findTemporalFallback(items, expectedItemCount);
  if (temporalFallback) {
    log.log(
      `[RewardScanner] Temporal consistency: sparse result (${items.length}/${expectedItemCount}), ` +
        `using recent full result (${temporalFallback.length} items)`,
    );
    items = temporalFallback;
    finalStrategy = "temporal-consensus";
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

  // F6: record result for temporal smoothing
  recordTemporalEntry(items, expectedItemCount);

  // F4: record instrumentation stats
  // slotDetectMs is captured at layout detection above
  _lastTriggerStats = {
    captureCount: captureCountStat,
    captureMs,
    ocrCallCount,
    ocrTotalMs,
    slotDetectMs,
    strategy: finalStrategy,
    failureReason: items.length === 0 ? "no-items" : null,
  };
  log.log(
    `[RewardScanner] Stats: captures=${captureCountStat} captureMs=${captureMs} ` +
      `ocrCalls=${ocrCallCount} ocrMs=${ocrTotalMs} strategy=${finalStrategy}`,
  );

  const meta = buildScanMeta({
    screenshot,
    selectedPass,
    passCount: bands.length,
    strategy: finalStrategy,
    elapsedMs: Date.now() - scanStartedAt,
    hadOcrSuccess,
  });

  const result = { items, meta };

  // Record winning strategy for adaptive reordering
  if (selectedPass && items.length > 0) {
    recordStrategyWin(
      selectedPass.passIndex != null ? selectedPass.passIndex - 1 : 0,
      selectedPass.ocrVariant || "raw",
      selectedPass.score || 0,
    );
  }

  // Cache frame hash for dedup on next retry
  if (frameHash) {
    _lastFrameHash = frameHash;
    _lastFrameResult = result;
    _lastFrameHashTs = Date.now();
  }

  return result;
}

export async function scanRewards(): Promise<any[] | null> {
  const detailed = await scanRewardsDetailed();
  if (!detailed) return null;
  return detailed.items;
}

export function waitForRewardUiReady(options?: any): Promise<any> {
  return _waitForRewardUiReady(options, getPrimaryBand);
}
