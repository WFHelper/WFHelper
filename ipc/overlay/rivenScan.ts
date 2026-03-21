"use strict";

/**
 * OCR scanning for the riven rolling screen.
 *
 * Scanning strategy:
 *  1. Session opens -> scanInitialCard() - OCR the centered single card
 *  2. Roll confirmed -> scanNewRoll() - OCR only the RIGHT panel (new roll)
 *
 * The left panel (current/old stats) is never scanned - we already know those
 * stats from step 1 or from the previous roll cycle.
 */

import path from "node:path";
import { withScope } from "../../services/logger";
import { captureScreenFast } from "../../services/rewardScannerCapture";
import { cropRect } from "../../services/rewardScannerImage";
import { createRewardOcrRunner } from "../../services/rewardScannerOcr";
import { getTesseractWorker, tesseractWorkerAvailable } from "../../services/ocrServer";
import { sleep } from "../../services/rewardScannerUtils";
import {
  abortRivenScanWaits,
  computeRivenFrameHash,
  cropAbsolute,
  deriveRivenRegions,
  enhanceForRivenOcr,
  refineRivenTextCrop,
  resetRivenScanWaits,
  waitForRivenUiReady,
  type EnhanceMode,
} from "./rivenScanImage";
import {
  extractSignAndValue,
  parseRivenStats,
  preprocessOcrText,
  sanitiseValue,
  scoreStatsCandidate,
  splitRivenStructuredText,
  type RivenStat,
} from "./rivenScanText";

export { parseRivenStats };
export type { RivenStat } from "./rivenScanText";

const log = withScope("rivenScan");

// __dirname at runtime is .electron-build/ipc/overlay/ - three levels up to reach project root
const OCR_SCRIPT = path.join(__dirname, "..", "..", "..", "scripts", "ocr.ps1");
const OCR_TIMEOUT_MS = 8000;
const MIN_ACCEPTABLE_RIVEN_STATS = 2;

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

const ocrRunner = createRewardOcrRunner({
  log,
  ocrScriptPath: OCR_SCRIPT,
  getRequestedEngine: () => "native",
});

// Secondary Tesseract-based OCR runner used for cross-engine value injection.
// Only invoked when the native engine leaves null-value slots in the best
// candidate — adds ~400-800ms but recovers values WinRT cannot read (e.g.
// x-multiplier decimals, coloured element text on animated backgrounds).
const tesseractOcrRunner = createRewardOcrRunner({
  log,
  ocrScriptPath: OCR_SCRIPT,
  getRequestedEngine: () => "tesseract",
  tesseractContext: "riven",
});

const ENHANCE_STRATEGIES: readonly EnhanceMode[] = Object.freeze([
  { kind: "original" },
  { kind: "bright", threshold: 150, dilate: true },
  { kind: "bright", threshold: 120, dilate: true },
]);

// Tesseract strategy order: original first (best text accuracy for early-accept
// on high-contrast cards), then bright-120 (recovers coloured text on animated
// backgrounds that original misses). Skips bright-150 — redundant with bright-120
// for Tesseract and saves ~600ms per fallback invocation.
const TESSERACT_STRATEGIES: readonly EnhanceMode[] = Object.freeze([
  { kind: "original" },
  { kind: "bright", threshold: 120, dilate: true },
]);

// Initial / choice scan: single centred card covers x 0.22–0.78.
const SINGLE_CARD_CROP = { x: 0.22, y: 0.43, width: 0.56, height: 0.45 };

// Roll scan: crop around the new-roll card (RIGHT card in the two-panel roll view).
// Brightness analysis of corpus images confirms the new card sits at x≈819–1104 (43–57%).
// The old left card stat text extends to approximately x=780 (40.6%).  The crop MUST
// start past that to avoid reading left-card stats.
// x=0.42 (806 px @1920) gives a safe margin past the left text and a small gutter
// before the right card edge (819 px).  Width 0.20 covers 806–1190, fully
// encompassing the right card text area plus margin.
const ROLL_CARD_CROP = { x: 0.42, y: 0.35, width: 0.20, height: 0.45 };

export interface RollPanelResult {
  left: RivenStat[];
  right: RivenStat[];
}

export interface InitialScanResult {
  stats: RivenStat[];
  rawText: string;
  titleText: string;
  footerText: string;
}

interface CandidateResult {
  text: string;
  titleText: string;
  footerText: string;
  stats: RivenStat[];
  score: number;
  cropId: string;
  refined: boolean;
  valueCount: number;
  modeLabel: string;
}

function buildOrderedCandidates(
  hasRefinedCrop: boolean,
): Array<{ cropId: "rough" | "refined"; mode: EnhanceMode }> {
  const ordered: Array<{ cropId: "rough" | "refined"; mode: EnhanceMode }> = [];
  // All rough passes first: Tesseract starts in parallel after rough:original
  // (the first iteration), and an early-accept on any rough pass skips all
  // refined passes entirely — avoiding wasted OCR calls on a small refined crop.
  for (const mode of ENHANCE_STRATEGIES) {
    ordered.push({ cropId: "rough", mode });
  }
  if (hasRefinedCrop) {
    for (const mode of ENHANCE_STRATEGIES) {
      ordered.push({ cropId: "refined", mode });
    }
  }
  return ordered;
}

function isConfidentEnough(result: CandidateResult): boolean {
  if (result.score < 0) return false;
  if (result.stats.length >= 4 && result.valueCount >= 3 && result.score >= 75) return true;
  if (result.stats.length >= 3 && result.valueCount >= 3 && result.score >= 85) return true;
  if (result.stats.length === 2 && result.valueCount === 2 && result.score >= 55) return true;
  return false;
}

/**
 * Run all Tesseract strategies on the given crop variants.
 * Extracted as a standalone async function so it can be started in parallel
 * with the native strategy loop rather than sequentially after it.
 * Returns the list of scored candidates (best-first if early-accepted).
 */
async function runTesseractCandidates(
  cropVariants: Array<{ id: string; image: any; refined: boolean; metrics: any }>,
  expectedWeaponName = "",
  label = "",
  myGeneration = -1,
  enhanceCache?: Map<string, Buffer>,
): Promise<CandidateResult[]> {
  const candidates: CandidateResult[] = [];
  const hasRefined = cropVariants.some((v) => v.id === "refined");
  // Rough passes first; refined appended after.  A guard inside the loop skips
  // the entire refined section when rough already produced usable stats.
  const plans: Array<{ cropId: "rough" | "refined"; mode: EnhanceMode }> = [
    ...TESSERACT_STRATEGIES.map((mode) => ({ cropId: "rough" as const, mode })),
    ...(hasRefined ? TESSERACT_STRATEGIES.map((mode) => ({ cropId: "refined" as const, mode })) : []),
  ];
  for (const plan of plans) {
    if (_ocrAborted || (myGeneration >= 0 && _scanGeneration !== myGeneration)) break;
    // Skip all remaining refined passes if any rough pass already found stats.
    if (plan.cropId === "refined" && candidates.some((c) => c.stats.length >= MIN_ACCEPTABLE_RIVEN_STATS)) break;
    const cropVariant = cropVariants.find((v) => v.id === plan.cropId);
    if (!cropVariant) continue;
    const modeLabel =
      plan.mode.kind === "original"
        ? `${cropVariant.id}:original`
        : `${cropVariant.id}:bright-${plan.mode.threshold}${plan.mode.dilate ? "+dilate" : ""}`;
    try {
      const cacheKey = modeLabel;
      let enhancedPng = enhanceCache?.get(cacheKey);
      if (!enhancedPng) {
        enhancedPng = await enhanceForRivenOcr(cropVariant.image, plan.mode);
        enhanceCache?.set(cacheKey, enhancedPng);
      }
      const structured = await tesseractOcrRunner.runOCRStructuredBuffer(
        enhancedPng,
        OCR_TIMEOUT_MS,
      );
      const split = splitRivenStructuredText(structured);
      const stats = parseRivenStats(split.statsText || structured.text || "");
      const valueCount = stats.filter((s) => s.value !== null).length;
      const score = scoreStatsCandidate(stats, split.mergedText || "", expectedWeaponName);
      if (label) {
        const preview = (split.mergedText || "").replace(/\r?\n/g, " | ").slice(0, 130);
        log.log(
          `[RivenScan] Tesseract ${label} ${modeLabel}: ${stats.length} stats (score=${score}) "${preview}"`,
        );
      }
      candidates.push({
        text: split.mergedText || structured.text || "",
        titleText: split.titleText || "",
        footerText: split.footerText || "",
        stats,
        score,
        cropId: cropVariant.id,
        refined: cropVariant.refined,
        valueCount,
        modeLabel: `tesseract:${modeLabel}`,
      });
      // Early-exit if Tesseract alone gives a confident standalone result
      const last = candidates[candidates.length - 1];
      if (isConfidentEnough(last)) break;
    } catch {
      // Non-fatal — Tesseract failure on one variant is acceptable
    }
  }
  return candidates;
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

async function runStructuredRegion(
  imageRegion: any,
  mode: EnhanceMode,
): Promise<{
  text: string;
  titleText: string;
  footerText: string;
  statsText: string;
}> {
  const enhanced = await enhanceForRivenOcr(imageRegion, mode);
  const structured = await ocrRunner.runOCRStructuredBuffer(enhanced, OCR_TIMEOUT_MS);
  const split = splitRivenStructuredText(structured);
  return {
    text: split.mergedText || structured.text || "",
    titleText: split.titleText || "",
    footerText: split.footerText || "",
    statsText: split.statsText || structured.text || "",
  };
}

async function ocrCropMultiStrategy(
  image: any,
  rect: { x: number; y: number; width: number; height: number },
  label = "",
  expectedWeaponName = "",
  statsOnly = false,
): Promise<{ text: string; titleText: string; footerText: string; stats: RivenStat[] }> {
  const myGeneration = _scanGeneration; // snapshot; stale if a new scan started
  const roughCrop = cropRect(image, rect);
  const refined = refineRivenTextCrop(roughCrop);
  const cropVariants = [{ id: "rough", image: roughCrop, refined: false, metrics: refined.metrics }];
  // Skip refined when it is too small to upscale usefully. The enhance pipeline
  // caps the upscale multiplier at 3× (lanczos3), so any refined crop narrower
  // than MIN_OCR_WIDTH/3 ≈ 600 px cannot reach MIN_OCR_WIDTH and will be OCR'd
  // at lower resolution than the rough crop — guaranteed 0 stats.
  const roughW = (roughCrop as any).getSize?.()?.width ?? 0;
  const refinedW = (refined.image as any)?.getSize?.()?.width ?? 0;
  if (refined.refined && refined.metrics.coverage < 0.25 && refinedW >= roughW / 2) {
    cropVariants.push({
      id: "refined",
      image: refined.image,
      refined: true,
      metrics: refined.metrics,
    });
  }

  if (label) {
    for (const variant of cropVariants) {
      const size = variant.image.getSize?.() ?? { width: 0, height: 0 };
      log.log(
        `[RivenScan] ${label} crop ${variant.id}: score=${variant.metrics.score.toFixed(3)} ` +
          `coverage=${variant.metrics.coverage.toFixed(4)} rows=${variant.metrics.activeRows} cols=${variant.metrics.activeCols} ` +
          `size=${size.width}x${size.height}`,
      );
    }
  }

  const orderedCandidates = buildOrderedCandidates(
    cropVariants.some((variant) => variant.id === "refined"),
  );
  const results: CandidateResult[] = [];

  // Per-scan enhance cache: avoids re-running enhanceForRivenOcr on the same
  // crop+mode pair across native and Tesseract loops.  Strategies overlap on
  // "original" and "bright-120+dilate", so this saves 30-80ms per overlap.
  const enhanceCache = new Map<string, Buffer>();

  // 2750 ms hard scan budget: mirrors AlecaFrame's per-scan cap.  If the native
  // loop or the Tesseract wait exceed this, we break early and return what we have.
  const SCAN_BUDGET_MS = 2750;
  const scanStart = Date.now();
  let tessEagerPromise: Promise<CandidateResult[]> | null = null;

  for (const plan of orderedCandidates) {
    if (_ocrAborted || _scanGeneration !== myGeneration) break;
    const cropVariant = cropVariants.find((variant) => variant.id === plan.cropId);
    if (!cropVariant) continue;

    const modeLabel =
      plan.mode.kind === "original"
        ? `${cropVariant.id}:original`
        : `${cropVariant.id}:bright-${plan.mode.threshold}${plan.mode.dilate ? "+dilate" : ""}`;

    let result: CandidateResult;
    try {
      const cacheKey = modeLabel;
      let enhancedPng = enhanceCache.get(cacheKey);
      if (!enhancedPng) {
        enhancedPng = await enhanceForRivenOcr(cropVariant.image, plan.mode);
        enhanceCache.set(cacheKey, enhancedPng);
      }
      const structured = await ocrRunner.runOCRStructuredBuffer(enhancedPng, OCR_TIMEOUT_MS);
      const split = splitRivenStructuredText(structured);

      const mergedText = split.mergedText || structured.text || "";
      const titleText = statsOnly ? "" : (split.titleText || "");
      const footerText = statsOnly ? "" : (split.footerText || "");
      const stats = parseRivenStats(split.statsText || structured.text || "");

      result = {
        text: mergedText,
        titleText,
        footerText,
        stats,
        score: scoreStatsCandidate(stats, mergedText, expectedWeaponName, titleText),
        cropId: cropVariant.id,
        refined: cropVariant.refined,
        valueCount: stats.filter((stat) => stat.value !== null).length,
        modeLabel,
      };
    } catch {
      result = {
        text: "",
        titleText: "",
        footerText: "",
        stats: [],
        score: -1,
        cropId: cropVariant.id,
        refined: cropVariant.refined,
        valueCount: 0,
        modeLabel,
      };
    }

    if (label) {
      const preview = result.text.replace(/\r?\n/g, " | ").slice(0, 150);
      log.log(
        `[RivenScan] OCR ${label} ${result.modeLabel}: ${result.stats.length} stats (score=${result.score}) "${preview}"`,
      );
    }

    results.push(result);

    // Always launch Tesseract after rough:original so it runs in parallel with
    // the remaining native strategies (bright-150, bright-120).
    if (
      tessEagerPromise === null &&
      tesseractWorkerAvailable &&
      !_ocrAborted &&
      plan.cropId === "rough" &&
      plan.mode.kind === "original"
    ) {
      tessEagerPromise = runTesseractCandidates(
        cropVariants, expectedWeaponName, label, myGeneration, enhanceCache,
      ).catch(() => []);
    }

    // Hard budget: stop running native strategies once the scan budget is exhausted.
    if (Date.now() - scanStart >= SCAN_BUDGET_MS) break;

    if (isConfidentEnough(result)) {
      if (label) {
        log.log(
          `[RivenScan] early-accept ${label} candidate crop=${result.cropId} refined=${result.refined} ` +
            `score=${result.score} stats=${result.stats.length} values=${result.valueCount}`,
        );
      }
      return {
        text: result.text,
        titleText: result.titleText,
        footerText: result.footerText,
        stats: result.stats,
      };
    }
  }

  let best: CandidateResult | null = null;
  for (const result of results) {
    if (!best) {
      best = result;
      continue;
    }
    if (result.score > best.score) {
      best = result;
      continue;
    }
    if (result.score < best.score) continue;
    if (result.stats.length > best.stats.length) {
      best = result;
      continue;
    }
    if (result.stats.length < best.stats.length) continue;
    if (result.valueCount > best.valueCount) {
      best = result;
      continue;
    }
    if (result.valueCount < best.valueCount) continue;
    if (result.refined && !best.refined) {
      best = result;
      continue;
    }
    if (!result.refined && best.refined) continue;
    if (result.text.length > best.text.length) {
      best = result;
    }
  }

  let chosen =
    best ?? {
      text: "",
      titleText: "",
      footerText: "",
      stats: [],
      score: -1,
      cropId: "",
      refined: false,
      valueCount: 0,
      modeLabel: "",
    };

  if (label) {
    log.log(
      `[RivenScan] chose ${label} candidate crop=${chosen.cropId || "unknown"} refined=${chosen.refined} ` +
        `score=${chosen.score} stats=${chosen.stats.length} values=${chosen.valueCount}`,
    );
  }

  // Deferred region OCR: run once on the best candidate when it has sparse stats or
  // missing title.  Previous code ran this inside EVERY native candidate iteration
  // (up to 3 extra WinRT calls per candidate × 3-6 candidates = 9-18 calls).
  // Now it runs at most 3 calls total, only when needed.
  // In statsOnly mode, skip title/footer region scans entirely.
  if (chosen.stats.length < 2 || (!statsOnly && !chosen.titleText)) {
    const bestCropVariant = cropVariants.find((v) => v.id === chosen.cropId);
    const bestMode = (() => {
      const ml = chosen.modeLabel;
      if (ml.includes("original")) return ENHANCE_STRATEGIES[0];
      if (ml.includes("bright-150")) return ENHANCE_STRATEGIES[1];
      if (ml.includes("bright-120")) return ENHANCE_STRATEGIES[2];
      return ENHANCE_STRATEGIES[0];
    })();
    if (bestCropVariant?.metrics.bounds) {
      try {
        const regions = deriveRivenRegions(bestCropVariant.image, bestCropVariant.metrics.bounds);
        const statsRegion = await runStructuredRegion(
          cropAbsolute(bestCropVariant.image, regions.stats),
          bestMode,
        );
        const titleRegion = statsOnly || chosen.titleText
          ? null
          : await runStructuredRegion(cropAbsolute(bestCropVariant.image, regions.title), bestMode);
        const footerRegion = statsOnly || chosen.footerText
          ? null
          : await runStructuredRegion(cropAbsolute(bestCropVariant.image, regions.footer), bestMode);
        const regionTitle = chosen.titleText || titleRegion?.text || "";
        const regionFooter = chosen.footerText || footerRegion?.text || "";
        const regionStats = parseRivenStats(statsRegion.statsText || statsRegion.text || "");
        if (regionStats.length > chosen.stats.length) {
          const mergedText = [regionTitle || chosen.titleText, statsRegion.text, regionFooter || chosen.footerText]
            .filter(Boolean)
            .join("\n");
          chosen = {
            ...chosen,
            stats: regionStats,
            titleText: regionTitle || chosen.titleText,
            footerText: regionFooter || chosen.footerText,
            text: mergedText,
            valueCount: regionStats.filter((s) => s.value !== null).length,
            score: scoreStatsCandidate(regionStats, mergedText, expectedWeaponName, regionTitle || chosen.titleText),
          };
        }
        if (!chosen.titleText && regionTitle) {
          chosen = { ...chosen, titleText: regionTitle };
        }
        if (!chosen.footerText && regionFooter) {
          chosen = { ...chosen, footerText: regionFooter };
        }
      } catch {
        // Region OCR is an optional refinement path.
      }
    }
  }

  // Cross-strategy value injection: if the best candidate has stats with null values
  // (e.g. WinRT couldn't read a colored element value like green Toxin text over the
  // Kuva portal background), try to recover them from orphan percent values found in
  // OTHER candidates' raw texts.  The bright+dilate strategy often reads the numeric
  // value when the element text is below the 150-brightness threshold for the name.
  let nullSlots = chosen.stats
    .map((s, i) => (s.value === null ? i : -1))
    .filter((i) => i >= 0);
  if (nullSlots.length > 0) {
    const assignedValues = new Set(
      chosen.stats.filter((s) => s.value !== null).map((s) => s.value as number),
    );
    const orphanValues: Array<{ value: number; positive: boolean }> = [];
    for (const candidate of results) {
      if (candidate === chosen) continue;
      const cleaned = preprocessOcrText(candidate.text || "");
      for (const match of cleaned.matchAll(/([+\-])\s*(\d+\.?\d*)\s*%/g)) {
        const v = parseFloat(match[2]);
        if (!Number.isFinite(v) || v <= 0) continue;
        if (assignedValues.has(v)) continue;
        if (orphanValues.some((o) => Math.abs(o.value - v) < 0.5)) continue;
        orphanValues.push({ value: v, positive: match[1] !== "-" });
      }
    }
    if (orphanValues.length > 0) {
      const injected = chosen.stats.slice();
      let orphanIdx = 0;
      for (const nullIdx of nullSlots) {
        if (orphanIdx >= orphanValues.length) break;
        injected[nullIdx] = {
          ...injected[nullIdx],
          value: orphanValues[orphanIdx].value,
          positive: orphanValues[orphanIdx].positive,
        };
        orphanIdx++;
      }
      if (label && orphanIdx > 0) {
        log.log(
          `[RivenScan] injected ${orphanIdx} orphan value(s) into null-value stat(s) from alternate strategy`,
        );
      }
      chosen = {
        ...chosen,
        stats: injected,
      };
    }
  }

  // Cross-engine Tesseract: await the eagerly-started parallel promise when native
  // still has null values or too few stats.  Because Tesseract launches in parallel
  // with the native loop, the wait here is (tessMs – nativeMs) or ~0 ms if it
  // already finished.  The hard budget caps the total wait.
  // When native was sufficient, tessEagerPromise is simply ignored.
  const remainingNulls = chosen.stats.filter((s) => s.value === null).length;
  const statsTooFew = chosen.stats.length < MIN_ACCEPTABLE_RIVEN_STATS;
  if ((remainingNulls > 0 || statsTooFew) && tessEagerPromise && !_ocrAborted && _scanGeneration === myGeneration) {
    if (label) {
      log.log(
        `[RivenScan] ${label} native result has ${remainingNulls} null value(s) / ${chosen.stats.length} stats — awaiting parallel Tesseract`,
      );
    }
    const budgetRemainingMs = SCAN_BUDGET_MS - (Date.now() - scanStart);
    try {
      const tesseractCandidates = budgetRemainingMs > 0
        ? await Promise.race([
            tessEagerPromise,
            sleep(budgetRemainingMs).then(() => [] as CandidateResult[]),
          ])
        : [];

      // Pick best Tesseract candidate (first confident one wins, else highest score)
      let bestTess: CandidateResult | null = null;
      for (const tc of tesseractCandidates) {
        if (!bestTess || tc.score > bestTess.score) bestTess = tc;
      }

      if (bestTess && bestTess.stats.length >= MIN_ACCEPTABLE_RIVEN_STATS) {
        // If Tesseract alone gives a confident result better than native, use it outright
        if (isConfidentEnough(bestTess) && bestTess.score > chosen.score) {
          if (label) {
            log.log(
              `[RivenScan] Tesseract early-accept ${label}: score=${bestTess.score} > native=${chosen.score}`,
            );
          }
          return {
            text: bestTess.text,
            titleText: bestTess.titleText,
            footerText: bestTess.footerText,
            stats: bestTess.stats,
          };
        }

        // If Tesseract found a strictly better result by score+values, use it outright
        const tessValues = bestTess.stats.filter((s) => s.value !== null).length;
        const nativeValues = chosen.stats.filter((s) => s.value !== null).length;
        if (bestTess.score > chosen.score && tessValues > nativeValues) {
          if (label) {
            log.log(
              `[RivenScan] Tesseract ${label} outright better: score=${bestTess.score} values=${tessValues} vs native score=${chosen.score} values=${nativeValues}`,
            );
          }
          return {
            text: bestTess.text,
            titleText: bestTess.titleText || chosen.titleText,
            footerText: bestTess.footerText || chosen.footerText,
            stats: bestTess.stats,
          };
        }

        // Cross-engine injection: fill null slots from Tesseract values
        nullSlots = chosen.stats
          .map((s, i) => (s.value === null ? i : -1))
          .filter((i) => i >= 0);
        if (nullSlots.length > 0) {
          const assignedValues = new Set(
            chosen.stats.filter((s) => s.value !== null).map((s) => s.value as number),
          );
          // Match by stat name first — most reliable
          const injected = chosen.stats.slice();
          let injectedCount = 0;
          for (const nullIdx of nullSlots) {
            const statName = injected[nullIdx].name.toLowerCase();
            const tessMatch = bestTess.stats.find(
              (ts) => ts.name.toLowerCase() === statName && ts.value !== null,
            );
            if (tessMatch && !assignedValues.has(tessMatch.value!)) {
              injected[nullIdx] = {
                ...injected[nullIdx],
                value: tessMatch.value,
                positive: tessMatch.positive,
                ...(tessMatch.multiplier && { multiplier: true }),
              };
              assignedValues.add(tessMatch.value!);
              injectedCount++;
            }
          }

          // Fall back to orphan % values from Tesseract text for any remaining nulls
          if (injectedCount < nullSlots.length) {
            const orphanValues: Array<{ value: number; positive: boolean; multiplier?: boolean }> = [];
            for (const tc of tesseractCandidates) {
              const cleaned = preprocessOcrText(tc.text || "");
              for (const match of cleaned.matchAll(/x\s*(\d+\.?\d*)/gi)) {
                const v = parseFloat(match[1]);
                if (!Number.isFinite(v) || v <= 0) continue;
                if (assignedValues.has(v)) continue;
                if (orphanValues.some((o) => Math.abs(o.value - v) < 0.05)) continue;
                orphanValues.push({ value: v, positive: v >= 1, multiplier: true });
              }
              for (const match of cleaned.matchAll(/([+\-])\s*(\d+\.?\d*)\s*%/g)) {
                const v = parseFloat(match[2]);
                if (!Number.isFinite(v) || v <= 0) continue;
                if (assignedValues.has(v)) continue;
                if (orphanValues.some((o) => Math.abs(o.value - v) < 0.5)) continue;
                orphanValues.push({ value: v, positive: match[1] !== "-" });
              }
            }
            let orphanIdx = 0;
            const remainingNullIdxs = nullSlots.filter((i) => injected[i].value === null);
            for (const nullIdx of remainingNullIdxs) {
              if (orphanIdx >= orphanValues.length) break;
              injected[nullIdx] = {
                ...injected[nullIdx],
                value: orphanValues[orphanIdx].value,
                positive: orphanValues[orphanIdx].positive,
                ...(orphanValues[orphanIdx].multiplier && { multiplier: true }),
              };
              assignedValues.add(orphanValues[orphanIdx].value);
              orphanIdx++;
              injectedCount++;
            }
          }

          if (label && injectedCount > 0) {
            log.log(
              `[RivenScan] cross-engine injected ${injectedCount} value(s) from Tesseract into native result`,
            );
          }
          if (injectedCount > 0) {
            return {
              text: chosen.text,
              titleText: chosen.titleText,
              footerText: chosen.footerText,
              stats: injected,
            };
          }
        }
      }
    } catch (tessErr) {
      // Tesseract fallback is optional — never block on failure
      if (label) {
        log.log(`[RivenScan] Tesseract await failed: ${String(tessErr)}`);
      }
    }
  }

  return {
    text: chosen.text,
    titleText: chosen.titleText,
    footerText: chosen.footerText,
    stats: chosen.stats,
  };
}

export function abortRivenScans(): void {
  _ocrAborted = true;
  abortRivenScanWaits();
}

export function resetRivenScanAbort(): void {
  _ocrAborted = false;
  resetRivenScanWaits();
  // Kick off the persistent Tesseract WASM worker so it is ready before the
  // first native scan finishes and potentially needs the cross-engine fallback.
  // getTesseractWorker() is idempotent — this is a no-op when startup already
  // completed the init; it only pays off if the app just started or the worker
  // was never successfully initialised.
  if (tesseractWorkerAvailable) {
    getTesseractWorker(); // fire-and-forget; errors are swallowed inside _initTesseractWorker
  }
}

export async function scanInitialCard(expectedWeaponName = ""): Promise<InitialScanResult> {
  const myGeneration = ++_scanGeneration;
  const ready = await waitForRivenUiReady(SINGLE_CARD_CROP, "initial");
  if (!ready.ready) {
    log.log(
      `[RivenScan] initial UI gate timed out after ${ready.elapsedMs}ms (${ready.attempts} samples, best=${ready.bestScore.toFixed(3)})`,
    );
  }

  const capture = ready.screenshot || (await captureScreenFast());
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

export async function scanNewRoll(expectedWeaponName = "", skipGate = false): Promise<RollPanelResult> {
  const myGeneration = ++_scanGeneration;
  const startAt = Date.now();
  let capture: Awaited<ReturnType<typeof captureScreenFast>>;
  let frameHash = "";
  if (skipGate) {
    // Diorama-triggered path: both cards are confirmed loaded, skip stability
    // polling and capture directly.  Matches AlecaFrame’s immediate-screenshot
    // behaviour on OmegaRerollSelection.lua: Diorama setup.
    capture = await captureScreenFast(_rivenDisplayId);
    if (!capture) {
      log.warn("[RivenScan] scanNewRoll: captureScreen returned null");
      return { left: [], right: [] };
    }
  } else {
    const ready = await waitForRivenUiReady(ROLL_CARD_CROP, "roll", _rivenDisplayId);
    if (!ready.ready) {
      log.log(
        `[RivenScan] roll UI gate timed out after ${ready.elapsedMs}ms (${ready.attempts} samples, best=${ready.bestScore.toFixed(3)})`,
      );
    }
    capture = ready.screenshot || (await captureScreenFast(_rivenDisplayId));
    if (!capture) {
      log.warn("[RivenScan] scanNewRoll: captureScreen returned null");
      return { left: [], right: [] };
    }
    frameHash = ready.frameHash;
  }
  if (!frameHash) {
    try {
      frameHash = computeRivenFrameHash(cropRect(capture.image, ROLL_CARD_CROP));
    } catch {
      frameHash = "";
    }
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
      true,
    );
    log.log(
      `[RivenScan] roll scan: right=${rightResult.stats.length} stats, elapsed=${Date.now() - startAt}ms`,
    );

    if (rightResult.stats.length < MIN_ACCEPTABLE_RIVEN_STATS) {
      await sleep(800);
      const retryCapture = await captureScreenFast(_rivenDisplayId);
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
          true,
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
  const ready = await waitForRivenUiReady(SINGLE_CARD_CROP, "choice", _rivenDisplayId);
  if (!ready.ready) {
    log.log(
      `[RivenScan] choice UI gate timed out after ${ready.elapsedMs}ms (${ready.attempts} samples, best=${ready.bestScore.toFixed(3)})`,
    );
  }

  const capture = ready.screenshot || (await captureScreenFast(_rivenDisplayId));
  if (!capture) {
    log.warn("[RivenScan] scanChoiceRescan: captureScreen returned null");
    return [];
  }

  let frameHash = ready.frameHash;
  if (!frameHash) {
    try {
      frameHash = computeRivenFrameHash(cropRect(capture.image, SINGLE_CARD_CROP));
    } catch {
      frameHash = "";
    }
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
        const retryCapture = await captureScreenFast(_rivenDisplayId);
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
