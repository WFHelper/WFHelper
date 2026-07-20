import type { NativeImage } from "electron";

import {
  binarizeRewardRegion,
  cropRect,
  detectRewardSlotLayoutCandidates,
} from "./rewardScannerImage";
import { recognizeRewardStripOnnx, rewardOcrOnnxAvailable } from "./rewardOcrOnnx";
import {
  MAX_REWARD_SLOTS,
  rankRewardCandidatesDetailed,
  type SortedItem,
} from "./rewardScannerMatch";
import { hasConfidentSlotLayout } from "./rewardScannerSupport";
import { dumpRewardScanDebug, type ScanDebugSlot } from "./rewardScanDebug";
import { withScope } from "./logger";

const log = withScope("rewardScanner");

interface OcrLine {
  text?: string;
  box?: { top?: number; height?: number };
}

interface StructuredOcrResult {
  text?: string;
  lines?: OcrLine[];
}

interface SlotCandidate {
  item: SortedItem;
  confidence: number;
  score: number;
  mode: string;
}

interface SlotDebugInfo {
  index: number;
  stripPng: Buffer;
  windowsText: string;
  onnxText: string;
  diverged: boolean;
}

function toScanDebugSlots(
  slotResults: Array<{ index: number; candidates: SlotCandidate[]; debug: SlotDebugInfo } | null>,
): ScanDebugSlot[] {
  const out: ScanDebugSlot[] = [];
  for (const entry of slotResults) {
    if (!entry?.debug) continue;
    const matched = entry.candidates[0] || null;
    out.push({
      index: entry.debug.index,
      stripPng: entry.debug.stripPng,
      windowsText: entry.debug.windowsText,
      onnxText: entry.debug.onnxText,
      diverged: entry.debug.diverged,
      matchedName: matched ? matched.item.name : null,
      confidence: matched ? matched.confidence : null,
      mode: matched ? matched.mode : null,
    });
  }
  return out;
}

interface SlotScanResult {
  items: SortedItem[];
  score: number;
  exactCount: number;
  slotCount: number;
  strategy: string;
  slotConfidence: number;
  avgConfidence: number;
  matchedSlots: number;
  emptySlots: number;
}

interface SlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CollectedSlot {
  index: number;
  candidate: SlotCandidate;
}

interface LayoutRun {
  rects: SlotRect[];
  collected: CollectedSlot[];
  slotLimit: number;
  layoutCount: number;
  layoutConfidence: number;
}

function buildLayoutResult(
  run: LayoutRun,
  collected: CollectedSlot[],
  expectedCount: number,
  strategy: string,
): SlotScanResult {
  // slotIndex keeps the on-screen position so the overlay can leave gaps
  const items = collected.map((entry) => ({ ...entry.candidate.item, slotIndex: entry.index }));
  const exactCount = collected.reduce(
    (sum, entry) => sum + (entry.candidate.mode === "exact" ? 1 : 0),
    0,
  );
  const avgConfidence =
    collected.reduce((sum, entry) => sum + Number(entry.candidate.confidence || 0), 0) /
    Math.max(1, collected.length);
  const avgCandidateScore =
    collected.reduce((sum, entry) => sum + Number(entry.candidate.score || 0), 0) /
    Math.max(1, collected.length);
  const emptySlots = run.slotLimit - collected.length;
  const expectedFillBonus =
    expectedCount > 0 ? Math.min(collected.length, expectedCount) / expectedCount : 0;
  const score =
    avgCandidateScore +
    collected.length * 44 +
    exactCount * 35 +
    avgConfidence * 20 +
    run.layoutConfidence * 12 +
    expectedFillBonus * 18 -
    emptySlots * 30;
  return {
    items,
    score,
    exactCount,
    slotCount: run.layoutCount,
    strategy,
    slotConfidence: run.layoutConfidence,
    avgConfidence,
    matchedSlots: collected.length,
    emptySlots,
  };
}

function xOverlapFraction(a: SlotRect, b: SlotRect): number {
  const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  return overlap <= 0 ? 0 : overlap / Math.min(a.width, b.width);
}

/** Fill the winner's empty slots with hits other layouts found at the same x-position. */
function collectDonorSlots(best: LayoutRun, runs: LayoutRun[]): CollectedSlot[] {
  const filled = new Set(best.collected.map((entry) => entry.index));
  const donorsBySlot = new Map<number, SlotCandidate>();
  for (const run of runs) {
    if (run === best) continue;
    for (const entry of run.collected) {
      const rect = run.rects[entry.index];
      if (!rect) continue;
      // Assign each donor to the one winner slot it overlaps most, so a single
      // physical card can't fill two slots.
      let baseIndex = -1;
      let baseOverlap = 0;
      for (let i = 0; i < best.slotLimit; i++) {
        const overlap = best.rects[i] ? xOverlapFraction(rect, best.rects[i]) : 0;
        if (overlap > baseOverlap) {
          baseOverlap = overlap;
          baseIndex = i;
        }
      }
      if (baseIndex < 0 || baseOverlap < 0.5 || filled.has(baseIndex)) continue;
      const existing = donorsBySlot.get(baseIndex);
      if (!existing || entry.candidate.score > existing.score) {
        donorsBySlot.set(baseIndex, entry.candidate);
      }
    }
  }
  return [...donorsBySlot.entries()].map(([index, candidate]) => ({ index, candidate }));
}

export type StructuredOcrBufferRunner = (
  buffer: Buffer,
  timeoutMs: number,
) => Promise<StructuredOcrResult>;

/** Which OCR reader(s) feed slot candidates; "both" is production behavior. */
export type RewardReader = "windows" | "onnx" | "both";

function isUsableSlotCandidate(candidate: SlotCandidate): boolean {
  if (!candidate?.item?.name) return false;
  const normalizedName = String(candidate.item.name || "").trim();
  const nameWords = normalizedName.split(/\s+/).filter(Boolean);
  if (nameWords.length <= 1 && normalizedName.length < 5) {
    return candidate.mode === "exact" && candidate.confidence >= 0.99;
  }
  if (candidate.mode === "exact") return candidate.confidence >= 0.98;
  if (candidate.mode === "substring") return candidate.confidence >= 0.92;
  return candidate.confidence >= 0.86;
}

async function ocrRewardRegion(
  cropPng: Buffer,
  topFrac: number,
  heightFrac: number,
  options: { runOCRStructuredBuffer: StructuredOcrBufferRunner },
  timeoutMs: number,
): Promise<string> {
  try {
    const buf = await binarizeRewardRegion(cropPng, topFrac, heightFrac);
    if (!buf) return "";
    const structured = await options.runOCRStructuredBuffer(buf, timeoutMs);
    return String(structured?.text || "")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

/** Drop 1-char OCR noise tokens but keep "&" (for "Cobra & Crane Prime ..."). */
function cleanRewardOcrText(text: string): string {
  return String(text || "")
    .split(/\s+/)
    .filter((w) => w === "&" || w.replace(/[^a-z0-9]/gi, "").length > 1)
    .join(" ")
    .trim();
}

function joinRewardLines(top: string, bottom: string): string {
  return [cleanRewardOcrText(top), cleanRewardOcrText(bottom)]
    .filter((s) => s.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function scanRewardSlotsFallback(
  screenshot: {
    image: NativeImage;
    sourceType?: string | null;
    sourceName?: string | null;
    sourceId?: string | null;
    sourceDisplayId?: string | null;
  },
  expectedCount: number,
  totalBudgetMs: number,
  startedAt: number,
  options: {
    sortedItems: SortedItem[];
    ocrTimeoutMs: number;
    runOCRStructuredBuffer: StructuredOcrBufferRunner;
    reader?: RewardReader;
  },
): Promise<SlotScanResult | null> {
  const layouts = detectRewardSlotLayoutCandidates(screenshot?.image)
    .filter((layout) => hasConfidentSlotLayout(layout))
    .slice(0, 6);
  if (layouts.length === 0) return null;

  let bestResult: SlotScanResult | null = null;
  let bestRun: LayoutRun | null = null;
  let bestDebugSlots: ScanDebugSlot[] = [];
  let fallbackDebugSlots: ScanDebugSlot[] = [];
  const runs: LayoutRun[] = [];

  for (const layout of layouts) {
    const slotLimit = Math.min(layout.count, MAX_REWARD_SLOTS);
    const slotResults = await Promise.all(
      layout.slots.slice(0, slotLimit).map(async (slot, i) => {
        const elapsed = Date.now() - startedAt;
        const remainingBudgetMs = totalBudgetMs - elapsed;
        if (remainingBudgetMs <= 0) return null;

        let crop: NativeImage;
        try {
          crop = cropRect(screenshot.image, slot.titleRect);
        } catch {
          return null;
        }

        const cropPng: Buffer = crop.toPNG();
        const timeout = Math.max(500, Math.min(options.ocrTimeoutMs, remainingBudgetMs));
        const reader = options.reader || "both";

        // Names wrap to two lines in 3/4-player layouts: OCR overlapping bands plus
        // the whole crop; both readers feed one pool, the ranking arbitrates.
        const [regionTexts, onnxRead] = await Promise.all([
          reader !== "onnx"
            ? Promise.all([
                ocrRewardRegion(cropPng, 0, 0.58, options, timeout),
                ocrRewardRegion(cropPng, 0.42, 0.58, options, timeout),
                ocrRewardRegion(cropPng, 0, 1, options, timeout),
              ])
            : Promise.resolve(["", "", ""]),
          reader !== "windows" && rewardOcrOnnxAvailable()
            ? recognizeRewardStripOnnx(cropPng)
            : Promise.resolve(null),
        ]);
        const joined = joinRewardLines(regionTexts[0], regionTexts[1]);
        const wholeClean = cleanRewardOcrText(regionTexts[2]);
        const onnxClean = cleanRewardOcrText(onnxRead?.text || "");

        const candidateTexts = new Set<string>();
        if (joined) candidateTexts.add(joined);
        if (wholeClean) candidateTexts.add(wholeClean);
        if (onnxClean) candidateTexts.add(onnxClean);
        const diverged =
          !!onnxClean &&
          !!(joined || wholeClean) &&
          onnxClean !== joined &&
          onnxClean !== wholeClean;
        if (diverged) {
          log.info(
            `[RewardScanner] Slot ${i + 1} reads diverge: windows="${wholeClean || joined}" onnx="${onnxClean}"`,
          );
        }

        const rankedCandidates: SlotCandidate[] = [];
        let bestRejected: SlotCandidate | null = null;
        for (const candidateText of candidateTexts) {
          for (const candidate of rankRewardCandidatesDetailed(
            candidateText,
            options.sortedItems,
            4,
          )) {
            if (!candidate.item) continue;
            const slotCandidate: SlotCandidate = {
              item: candidate.item,
              confidence: candidate.confidence,
              score: candidate.score,
              mode: candidate.mode,
            };
            if (isUsableSlotCandidate(slotCandidate)) {
              rankedCandidates.push(slotCandidate);
            } else if (!bestRejected || slotCandidate.score > bestRejected.score) {
              bestRejected = slotCandidate;
            }
          }
        }

        const debug: SlotDebugInfo = {
          index: i,
          stripPng: cropPng,
          windowsText: wholeClean || joined,
          onnxText: onnxClean,
          diverged,
        };

        if (rankedCandidates.length === 0) {
          if (bestRejected) {
            log.info(
              `[RewardScanner] Slot ${i + 1} best candidate below gate: ` +
                `"${bestRejected.item.name}" (${bestRejected.mode} ${bestRejected.confidence.toFixed(3)})`,
            );
          }
          return { index: i, candidates: [] as SlotCandidate[], debug };
        }
        rankedCandidates.sort((a, b) => b.score - a.score || b.confidence - a.confidence);
        return {
          index: i,
          candidates: rankedCandidates,
          debug,
        };
      }),
    );

    const collected = slotResults
      .map((entry, index) => ({
        index,
        candidate: entry?.candidates?.[0] || null,
      }))
      .filter((entry): entry is CollectedSlot => !!entry.candidate);

    if (!collected.length) {
      // layouts are confidence-sorted - the first zero-hit one best shows a no-match scan
      if (fallbackDebugSlots.length === 0) fallbackDebugSlots = toScanDebugSlots(slotResults);
      continue;
    }

    const run: LayoutRun = {
      rects: layout.slots.slice(0, slotLimit).map((slot) => slot.titleRect),
      collected,
      slotLimit,
      layoutCount: layout.count,
      layoutConfidence: layout.confidence,
    };
    runs.push(run);
    const result = buildLayoutResult(run, collected, expectedCount, "slot-primary");

    log.info(
      `[RewardScanner] Slot layout candidate ${layout.count}: ` +
        `hits=${result.matchedSlots}/${slotLimit} exact=${result.exactCount} ` +
        `avg=${result.avgConfidence.toFixed(3)} score=${result.score.toFixed(2)} ` +
        `items=${result.items.map((item) => item.name).join(" | ")}`,
    );

    // Multi-card layouts outrank a lone pristine exact match - structure beats averages.
    const bestIsMulti = !!bestResult && bestResult.matchedSlots >= 2;
    const resultIsMulti = result.matchedSlots >= 2;
    if (
      !bestResult ||
      (resultIsMulti && !bestIsMulti) ||
      (resultIsMulti === bestIsMulti &&
        (result.score > bestResult.score ||
          (Math.abs(result.score - bestResult.score) < 12 &&
            result.items.length === bestResult.items.length &&
            result.emptySlots < bestResult.emptySlots) ||
          (result.score === bestResult.score && result.items.length > bestResult.items.length)))
    ) {
      bestResult = result;
      bestRun = run;
      bestDebugSlots = toScanDebugSlots(slotResults);
    }

    // All slots exact - smaller layouts can't beat this, skip their OCR (~650ms).
    if (
      result.matchedSlots >= 2 &&
      result.matchedSlots === slotLimit &&
      result.exactCount === result.matchedSlots &&
      result.emptySlots === 0
    ) {
      log.info(
        `[RewardScanner] Slot layout ${layout.count} is a clean sweep - skipping smaller layouts`,
      );
      break;
    }
  }

  // A losing layout may have matched exactly the cards the winner missed
  // (seen on 21:9). Fill the winner's empty slots from those hits.
  if (bestResult && bestRun && bestResult.emptySlots > 0 && runs.length > 1) {
    const donors = collectDonorSlots(bestRun, runs);
    if (donors.length > 0) {
      const merged = [...bestRun.collected, ...donors].sort((a, b) => a.index - b.index);
      bestResult = buildLayoutResult(bestRun, merged, expectedCount, "slot-merged");
      log.info(
        `[RewardScanner] Slot merge: +${donors.length} from losing layouts: ` +
          donors.map((entry) => `${entry.index + 1}:${entry.candidate.item.name}`).join(" | "),
      );
    }
  }

  if (bestResult) {
    const anyDiverge = bestDebugSlots.some((slot) => slot.diverged);
    if (bestResult.emptySlots > 0 || anyDiverge) {
      dumpRewardScanDebug(
        bestResult.emptySlots > 0 ? "empty-slots" : "reader-diverge",
        bestDebugSlots,
        {
          reader: options.reader || "both",
          layoutCount: bestResult.slotCount,
          matchedSlots: bestResult.matchedSlots,
          items: bestResult.items.map((item) => item.name),
        },
      );
    }
  } else if (fallbackDebugSlots.length > 0) {
    dumpRewardScanDebug("no-layout-hits", fallbackDebugSlots, {
      reader: options.reader || "both",
      layoutCount: layouts[0]?.count ?? 0,
    });
  }

  return bestResult;
}
