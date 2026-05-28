import type { NativeImage } from "electron";

import { buildOcrVariants, cropRect, detectRewardSlotLayoutCandidates } from "./rewardScannerImage";
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

export function extractRewardTitleTexts(structured: StructuredOcrResult | null): string[] {
  const lines: OcrLine[] = Array.isArray(structured?.lines) ? structured!.lines! : [];
  const text = String(structured?.text || "").trim();
  if (lines.length === 0) return text ? [text] : [];

  const bottoms = lines.map((line) => Number(line?.box?.top || 0) + Number(line?.box?.height || 0));
  const maxBottom = Math.max(...bottoms, 1);
  const bottomLines = lines
    .filter((line) => Number(line?.box?.top || 0) >= maxBottom * 0.45)
    .map((line) => String(line?.text || "").trim())
    .filter(Boolean);
  const lastTwo = lines
    .slice(-2)
    .map((line) => String(line?.text || "").trim())
    .filter(Boolean);
  const candidates = new Set<string>();
  if (bottomLines.length) candidates.add(bottomLines.join(" "));
  if (lastTwo.length) candidates.add(lastTwo.join(" "));
  if (text) candidates.add(text);
  return [...candidates].filter((candidate) => candidate.length > 0);
}

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

        const rankedCandidates: SlotCandidate[] = [];
        const variants = buildOcrVariants(crop);
        for (const variant of variants) {
          try {
            const pngBuffer: Buffer = variant.image.toPNG();
            const structured = await options.runOCRStructuredBuffer(
              pngBuffer,
              Math.max(500, Math.min(options.ocrTimeoutMs, remainingBudgetMs)),
            );
            const candidateTexts = extractRewardTitleTexts(structured);
            for (const candidateText of candidateTexts) {
              const ranked = rankRewardCandidatesDetailed(candidateText, options.sortedItems, 4)
                .filter(
                  (
                    candidate,
                  ): candidate is typeof candidate & { item: NonNullable<typeof candidate.item> } =>
                    !!candidate.item,
                )
                .map((candidate) => ({
                  item: candidate.item!,
                  confidence: candidate.confidence,
                  score: candidate.score + (variant.id === "raw" ? 2 : 0),
                  mode: candidate.mode,
                }))
                .filter(isUsableSlotCandidate);
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

    const items = collected.map((entry) => entry.candidate.item).slice(0, slotLimit);
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
