import type { NativeImage } from "electron";

import { buildOcrVariants, cropRect, detectRewardSlotLayoutCandidates } from "./rewardScannerImage";
import {
  MAX_REWARD_SLOTS,
  rankRewardCandidatesDetailed,
  type SortedItem,
} from "./rewardScannerMatch";
import { hasConfidentSlotLayout } from "./rewardScannerSupport";

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

function chooseUniqueRewardAssignments(
  slotCandidates: Array<Array<SlotCandidate>>,
): Array<SlotCandidate | null> {
  let bestScore = -Infinity;
  let best: Array<SlotCandidate | null> = new Array(slotCandidates.length).fill(null);

  function visit(
    index: number,
    usedNames: Set<string>,
    current: Array<SlotCandidate | null>,
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

function isUsableSlotCandidate(candidate: SlotCandidate): boolean {
  if (!candidate?.item?.name) return false;
  if (candidate.mode === "exact") return candidate.confidence >= 0.98;
  if (candidate.mode === "substring") return candidate.confidence >= 0.9;
  return candidate.confidence >= 0.82;
}

function baseRewardName(name: string): string {
  return name
    .replace(/\s+(Blueprint|Systems|Chassis|Neuroptics|Harness|Carapace|Cerebrum|Barrel|Receiver|Stock|Handle|Blade|String|Grip|Link|Pouch|Stars|Disc|Upper Limb|Lower Limb)$/i, "")
    .trim()
    .toLowerCase();
}

function duplicateBasePenalty(items: SortedItem[]): number {
  const counts = new Map<string, number>();
  for (const item of items) {
    const base = baseRewardName(item.name);
    if (!base) continue;
    counts.set(base, (counts.get(base) || 0) + 1);
  }

  let penalty = 0;
  for (const count of counts.values()) {
    if (count > 1) penalty += (count - 1) * 45;
  }
  return penalty;
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
    .slice(0, 3);
  if (layouts.length === 0) return null;

  let bestResult: SlotScanResult | null = null;

  for (const layout of layouts) {
    const slotLimit = Math.min(expectedCount || layout.count, layout.count, MAX_REWARD_SLOTS);
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

    const orderedCandidates = slotResults
      .filter(
        (
          entry,
        ): entry is {
          index: number;
          candidates: SlotCandidate[];
        } => !!entry,
      )
      .sort((a, b) => a.index - b.index);

    const assigned = chooseUniqueRewardAssignments(
      orderedCandidates.map((entry) => entry.candidates),
    );
    const collected = orderedCandidates
      .map((entry, idx) => ({
        index: entry.index,
        candidate: assigned[idx] || null,
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
    const score =
      avgCandidateScore +
      collected.length * 12 +
      exactCount * 35 +
      avgConfidence * 20 -
      duplicateBasePenalty(items);

    const result: SlotScanResult = {
      items,
      score,
      exactCount,
      slotCount: layout.count,
      strategy: "slot-fallback",
      slotConfidence: layout.confidence,
      avgConfidence,
    };

    if (
      !bestResult ||
      result.score > bestResult.score ||
      (result.score === bestResult.score && result.items.length > bestResult.items.length)
    ) {
      bestResult = result;
    }
  }

  return bestResult;
}
