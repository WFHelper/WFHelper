import type { NativeImage } from "electron";

import { binarizeRewardRegion, cropRect, detectRewardSlotLayoutCandidates } from "./rewardScannerImage";
import { recognizeRewardStripOnnx, rewardOcrOnnxAvailable } from "./rewardOcrOnnx";
import {
  MAX_REWARD_SLOTS,
  rankRewardCandidatesDetailed,
  type SortedItem,
} from "./rewardScannerMatch";
import { hasConfidentSlotLayout } from "./rewardScannerSupport";
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
    return String(structured?.text || "").replace(/\s+/g, " ").trim();
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

        // Names wrap to two lines in 3/4-player layouts: OCR each band plus the whole
        // crop, bands overlap so the wrap point doesn't cut a glyph.
        let joined = "";
        let wholeClean = "";
        if (reader !== "onnx") {
          const topText = await ocrRewardRegion(cropPng, 0, 0.58, options, timeout);
          const bottomText = await ocrRewardRegion(cropPng, 0.42, 0.58, options, timeout);
          const wholeText = await ocrRewardRegion(cropPng, 0, 1, options, timeout);
          joined = joinRewardLines(topText, bottomText);
          wholeClean = cleanRewardOcrText(wholeText);
        }

        // Second independent read of the same strip; both readers feed one
        // candidate pool and the match ranking arbitrates.
        let onnxClean = "";
        if (reader !== "windows" && rewardOcrOnnxAvailable()) {
          const onnxRead = await recognizeRewardStripOnnx(cropPng);
          onnxClean = cleanRewardOcrText(onnxRead?.text || "");
        }

        const candidateTexts = new Set<string>();
        if (joined) candidateTexts.add(joined);
        if (wholeClean) candidateTexts.add(wholeClean);
        if (onnxClean) candidateTexts.add(onnxClean);
        if (onnxClean && (joined || wholeClean) && onnxClean !== joined && onnxClean !== wholeClean) {
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

        if (rankedCandidates.length === 0) {
          if (bestRejected) {
            log.info(
              `[RewardScanner] Slot ${i + 1} best candidate below gate: ` +
                `"${bestRejected.item.name}" (${bestRejected.mode} ${bestRejected.confidence.toFixed(3)})`,
            );
          }
          return null;
        }
        rankedCandidates.sort((a, b) => b.score - a.score || b.confidence - a.confidence);
        return {
          index: i,
          candidates: rankedCandidates,
        };
      }),
    );

    const collected = slotResults
      .map((entry, index) => ({
        index,
        candidate: entry?.candidates?.[0] || null,
      }))
      .filter(
        (
          entry,
        ): entry is {
          index: number;
          candidate: SlotCandidate;
        } => !!entry.candidate,
      );

    if (!collected.length) continue;

    // slotIndex keeps the on-screen position so the overlay can leave gaps
    const items = collected
      .map((entry) => ({ ...entry.candidate.item, slotIndex: entry.index }))
      .slice(0, slotLimit);
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
    const emptySlots = slotLimit - collected.length;
    const expectedFillBonus =
      expectedCount > 0 ? Math.min(collected.length, expectedCount) / expectedCount : 0;
    const score =
      avgCandidateScore +
      collected.length * 44 +
      exactCount * 35 +
      avgConfidence * 20 +
      layout.confidence * 12 +
      expectedFillBonus * 18 -
      emptySlots * 30;

    const result: SlotScanResult = {
      items,
      score,
      exactCount,
      slotCount: layout.count,
      strategy: "slot-primary",
      slotConfidence: layout.confidence,
      avgConfidence,
      matchedSlots: collected.length,
      emptySlots,
    };

    log.info(
      `[RewardScanner] Slot layout candidate ${layout.count}: ` +
        `hits=${collected.length}/${slotLimit} exact=${exactCount} ` +
        `avg=${avgConfidence.toFixed(3)} score=${score.toFixed(2)} ` +
        `items=${items.map((item) => item.name).join(" | ")}`,
    );

    if (
      !bestResult ||
      result.score > bestResult.score ||
      (Math.abs(result.score - bestResult.score) < 12 &&
        result.items.length === bestResult.items.length &&
        result.emptySlots < bestResult.emptySlots) ||
      (result.score === bestResult.score && result.items.length > bestResult.items.length)
    ) {
      bestResult = result;
    }
  }

  return bestResult;
}
