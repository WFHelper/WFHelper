/**
 * OCR text → item matching helpers for reward scanning.
 * All functions are pure (except `matchItemsDetailed` which reads a `sortedItems` array parameter).
 */

import { levenshteinDistance } from "./rewardScannerUtils";

export const MAX_REWARD_SLOTS = 4;
const EXACT_MATCH_SKIP_OVERLAP_COUNT = 3;
const MIN_MATCHED_WORDS_FOR_OVERLAP = 2;
const OVERLAP_CONFIDENCE_FLOOR = 0.86;

export const RELIC_ERA_TOKENS: ReadonlyArray<{ token: string; text: string }> = Object.freeze([
  { token: "lith", text: "LITH" },
  { token: "meso", text: "MESO" },
  { token: "neo", text: "NEO" },
  { token: "axi", text: "AXI" },
  { token: "requiem", text: "REQUIEM" },
]);

export const CONSENSUS_TUNING: Readonly<{
  minScoreWeight: number;
  minConfidenceWeight: number;
  confidenceDecimals: number;
}> = Object.freeze({
  minScoreWeight: 0.1,
  minConfidenceWeight: 0.1,
  confidenceDecimals: 3,
});

export function normalizeOcrToken(token: any): string {
  return String(token || "")
    .toUpperCase()
    .replace(/[1|!]/g, "I")
    .replace(/0/g, "O")
    .replace(/5/g, "S")
    .replace(/[^A-Z]/g, "")
    .trim();
}

export function norm(text: any): string {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function buildWordSet(text: string): Set<string> {
  return new Set(
    text
      .split(" ")
      .map((w) => w.trim())
      .filter((w) => w.length > 2),
  );
}

interface SortedItem {
  name: string;
  [key: string]: any;
}

interface MatchEntry {
  item: SortedItem;
  pos: number;
  confidence: number;
  mode: "exact" | "overlap";
}

interface MatchResult {
  items: Array<SortedItem & { confidence: number }>;
  score: number;
  matches: MatchEntry[];
  exactCount: number;
}

interface SingleItemMatchResult {
  item: (SortedItem & { confidence: number }) | null;
  confidence: number;
  score: number;
  mode: "exact" | "substring" | "fuzzy" | "none";
}

const REWARD_TOKEN_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // Blueprint variants
  bluedrint: "blueprint",
  blueorint: "blueprint",
  blueprlnt: "blueprint",
  blueprini: "blueprint",
  bluepnnt: "blueprint",
  blueprint: "blueprint",
  bIueprint: "blueprint",
  biueprint: "blueprint",
  lueprint: "blueprint",
  //  Systems variants
  svst: "systems",
  svstems: "systems",
  systerns: "systems",
  syst: "systems",
  syslems: "systems",
  // Neuroptics variants
  neurootics: "neuroptics",
  neurotics: "neuroptics",
  neuroptlcs: "neuroptics",
  neurcptics: "neuroptics",
  neuropiics: "neuroptics",
  neuraptics: "neuroptics",
  eurobtic: "neuroptics",
  europtics: "neuroptics",
  // Chassis variants
  chassls: "chassis",
  chassi: "chassis",
  chassl: "chassis",
  chassi5: "chassis",
  hassis: "chassis",
  // Receiver variants
  recelver: "receiver",
  recelvar: "receiver",
  recei: "receiver",
  rece1ver: "receiver",
  // Common Warframe name misreads
  wukon: "wukong",
  rhln: "rhino",
  rhin: "rhino",
  sarv: "saryn",
  nek: "nekros",
  nekr: "nekros",
  obero: "oberon",
  obenon: "oberon",
  trinlty: "trinity",
  trini: "trinity",
  trinit: "trinity",
  bans: "banshee",
  bansh: "banshee",
  equlnox: "equinox",
  equln: "equinox",
  voIt: "volt",
  hy: "hydroid",
  hyd: "hydroid",
  ivar: "ivara",
  llmbo: "limbo",
  Iimbo: "limbo",
  // Weapon / part name misreads
  prlme: "prime",
  pnme: "prime",
  prix: "prime",
  priime: "prime",
  barre: "barrel",
  banel: "barrel",
  bIade: "blade",
  bilade: "blade",
  stoc: "stock",
  slock: "stock",
  grlp: "grip",
  forrna: "forma",
  forna: "forma",
});

export function matchItemsDetailed(
  ocrText: string,
  threshold: number,
  sortedItems: SortedItem[],
): MatchResult {
  const text = norm(ocrText);
  if (!text) {
    return { items: [], score: 0, matches: [], exactCount: 0 };
  }

  const words = buildWordSet(text);
  const found: MatchEntry[] = [];
  const usedNames = new Set<string>();
  const overlapThreshold = Math.max(Number(threshold) || 0, OVERLAP_CONFIDENCE_FLOOR);

  for (const item of sortedItems) {
    if (found.length >= MAX_REWARD_SLOTS) break;
    const normalizedName = norm(item.name);
    if (!normalizedName || usedNames.has(normalizedName)) continue;

    const idx = text.indexOf(normalizedName);
    if (idx >= 0) {
      found.push({ item, pos: idx, confidence: 1, mode: "exact" });
      usedNames.add(normalizedName);
    }
  }

  const exactCount = found.length;
  const shouldRunOverlapPass =
    exactCount < EXACT_MATCH_SKIP_OVERLAP_COUNT && found.length < MAX_REWARD_SLOTS;

  if (shouldRunOverlapPass) {
    for (const item of sortedItems) {
      if (found.length >= MAX_REWARD_SLOTS) break;
      const normalizedName = norm(item.name);
      if (!normalizedName || usedNames.has(normalizedName)) continue;

      const itemWords = normalizedName.split(" ").filter((w) => w.length > 2);
      if (itemWords.length === 0) continue;

      const matchedWords = itemWords.filter((w) => words.has(w)).length;
      if (matchedWords < MIN_MATCHED_WORDS_FOR_OVERLAP) continue;

      const ratio = matchedWords / itemWords.length;
      if (ratio < overlapThreshold) continue;

      const firstWord = itemWords.find((w) => words.has(w)) || "";
      const pos = firstWord ? text.indexOf(firstWord) : text.length;

      found.push({ item, pos, confidence: ratio, mode: "overlap" });
      usedNames.add(normalizedName);
    }
  }

  found.sort((a, b) => a.pos - b.pos);

  const exactMatches = found.filter((m) => m.mode === "exact").length;
  const confidenceSum = found.reduce((sum, m) => sum + m.confidence, 0);
  const coverageBoost = Math.min(MAX_REWARD_SLOTS, found.length) * 0.6;
  const exactBoost = exactMatches * 0.35;

  return {
    items: found.map((m) => ({ ...m.item, confidence: Number(m.confidence.toFixed(3)) })),
    score: confidenceSum + coverageBoost + exactBoost,
    matches: found,
    exactCount,
  };
}

function similarityScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const distance = levenshteinDistance(a, b);
  return Math.max(0, 1 - distance / Math.max(a.length, b.length, 1));
}

function normalizeRewardWord(word: string): string {
  const normalized = norm(word).replace(/[^a-z0-9]/g, "");
  if (!normalized) return "";
  return REWARD_TOKEN_ALIASES[normalized] || normalized;
}

function normalizeRewardText(text: string): string {
  return String(text || "")
    .split(/\s+/)
    .map((word) => normalizeRewardWord(word))
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function rankRewardCandidatesDetailed(
  ocrText: string,
  sortedItems: SortedItem[],
  limit = 5,
): SingleItemMatchResult[] {
  const text = normalizeRewardText(ocrText);
  if (!text) {
    return [{ item: null, confidence: 0, score: 0, mode: "none" }];
  }

  const textWords = text.split(" ").filter((word) => word.length > 1);
  const ranked: SingleItemMatchResult[] = [];

  for (const item of sortedItems) {
    const normalizedName = normalizeRewardText(item.name);
    if (!normalizedName) continue;

    if (text === normalizedName) {
      ranked.push({
        item: { ...item, confidence: 1 },
        confidence: 1,
        score: 100,
        mode: "exact",
      });
      continue;
    }

    if (text.includes(normalizedName) || normalizedName.includes(text)) {
      const confidence = Math.max(0.88, similarityScore(text, normalizedName));
      ranked.push({
        item: { ...item, confidence: Number(confidence.toFixed(3)) },
        confidence,
        score: confidence * 92 + Math.min(8, normalizedName.length / 4),
        mode: "substring",
      });
      continue;
    }

    const itemWords = normalizedName.split(" ").filter((word) => word.length > 1);
    if (itemWords.length === 0) continue;

    let matchedWords = 0;
    for (const itemWord of itemWords) {
      let wordMatched = false;
      for (const textWord of textWords) {
        if (
          textWord === itemWord ||
          similarityScore(textWord, itemWord) >= (itemWord.length >= 7 ? 0.7 : 0.78)
        ) {
          wordMatched = true;
          break;
        }
      }
      if (wordMatched) matchedWords += 1;
    }

    const wordRatio = matchedWords / itemWords.length;
    if (wordRatio < 0.45) continue;

    let bestSpanScore = similarityScore(text, normalizedName);
    if (textWords.length >= itemWords.length) {
      for (let start = 0; start <= textWords.length - itemWords.length; start += 1) {
        const span = textWords.slice(start, start + itemWords.length).join(" ");
        bestSpanScore = Math.max(bestSpanScore, similarityScore(span, normalizedName));
      }
    }

    const confidence = Math.min(0.97, wordRatio * 0.6 + bestSpanScore * 0.4);
    ranked.push({
      item: { ...item, confidence: Number(confidence.toFixed(3)) },
      confidence,
      score: confidence * 100 + matchedWords * 2,
      mode: "fuzzy",
    });
  }

  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.confidence - a.confidence ||
      (b.item?.name.length || 0) - (a.item?.name.length || 0),
  );
  return ranked.slice(0, Math.max(1, limit));
}

export function matchSingleRewardTextDetailed(
  ocrText: string,
  sortedItems: SortedItem[],
): SingleItemMatchResult {
  return (
    rankRewardCandidatesDetailed(ocrText, sortedItems, 1)[0] || {
      item: null,
      confidence: 0,
      score: 0,
      mode: "none",
    }
  );
}

export function chooseBetterOcrPass(
  currentBest: MatchResult | null,
  candidate: MatchResult | null,
): MatchResult | null {
  if (!candidate) return currentBest;
  if (!currentBest) return candidate;

  const currentItemCount = Array.isArray(currentBest.items) ? currentBest.items.length : 0;
  const candidateItemCount = Array.isArray(candidate.items) ? candidate.items.length : 0;
  if (candidateItemCount !== currentItemCount) {
    return candidateItemCount > currentItemCount ? candidate : currentBest;
  }

  const currentExact = Number(currentBest.exactCount || 0);
  const candidateExact = Number(candidate.exactCount || 0);
  if (candidateExact !== currentExact) {
    return candidateExact > currentExact ? candidate : currentBest;
  }

  return Number(candidate.score || 0) > Number(currentBest.score || 0) ? candidate : currentBest;
}

export function detectRelicEraFromText(text: string): { era: string | null; confidence: number } {
  const normalized = String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return { era: null, confidence: 0 };
  }

  const words = normalized
    .split(" ")
    .map((word) => normalizeOcrToken(word))
    .filter((word) => word.length >= 2);

  let best: { era: string | null; confidence: number } = { era: null, confidence: 0 };

  for (const word of words) {
    for (const era of RELIC_ERA_TOKENS) {
      const target = era.text;
      if (word === target) {
        return { era: era.token, confidence: 1 };
      }

      if (word.length >= 3 && (target.startsWith(word) || word.startsWith(target))) {
        best = best.confidence < 0.82 ? { era: era.token, confidence: 0.82 } : best;
      }

      if (word.length >= 3) {
        const distance = levenshteinDistance(word, target);
        if (distance <= 1) {
          best = best.confidence < 0.76 ? { era: era.token, confidence: 0.76 } : best;
        }
      }
    }
  }

  return best;
}

export function detectRelicEraFromTileLabelText(text: string): {
  era: string | null;
  confidence: number;
} {
  const normalized = String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return { era: null, confidence: 0 };
  }

  const base = detectRelicEraFromText(normalized);
  if (!base.era || base.confidence <= 0) {
    return base;
  }

  let confidence = base.confidence;
  const startsWithEra =
    normalized.startsWith("LITH ") ||
    normalized.startsWith("MESO ") ||
    normalized.startsWith("NEO ") ||
    normalized.startsWith("AXI ") ||
    normalized.startsWith("REQUIEM ");
  if (startsWithEra) {
    confidence += 0.08;
  }

  if (normalized.includes(" RELIC")) {
    confidence += 0.06;
  }

  return {
    era: base.era,
    confidence: Math.min(1, confidence),
  };
}

interface PassResult {
  items: Array<SortedItem & { confidence: number }>;
  score: number;
  matches: MatchEntry[];
  exactCount: number;
  [key: string]: any;
}

interface ConsensusResult {
  items: Array<SortedItem & { confidence: number }>;
  selectedPass: PassResult;
  strategy: string;
  targetCount: number;
}

export function buildConsensusSelection(passResults: PassResult[]): ConsensusResult | null {
  const { medianNumber } = require("./rewardScannerUtils") as {
    medianNumber: (arr: number[], fallback: number) => number;
  };

  const successful = passResults.filter((result) => result.items.length > 0);
  if (successful.length === 0) return null;

  if (successful.length === 1) {
    return {
      items: successful[0].items.slice(0, MAX_REWARD_SLOTS),
      selectedPass: successful[0],
      strategy: "single-pass",
      targetCount: successful[0].items.length,
    };
  }

  const estimatedCount = Math.max(
    1,
    Math.min(
      MAX_REWARD_SLOTS,
      Math.round(
        medianNumber(
          successful.map((result) => result.items.length),
          successful[0].items.length,
        ),
      ),
    ),
  );

  interface VoteEntry {
    item: SortedItem & { confidence: number };
    hits: number;
    weightedScore: number;
    bestConfidence: number;
    avgPosAccumulator: number;
    avgPosCount: number;
  }

  const votes = new Map<string, VoteEntry>();

  for (const result of successful) {
    const scoreWeight = Math.max(CONSENSUS_TUNING.minScoreWeight, result.score);
    for (const match of result.matches) {
      const key = match.item.name;
      const existing = votes.get(key) || {
        item: match.item as SortedItem & { confidence: number },
        hits: 0,
        weightedScore: 0,
        bestConfidence: 0,
        avgPosAccumulator: 0,
        avgPosCount: 0,
      };

      existing.hits += 1;
      existing.weightedScore +=
        scoreWeight * Math.max(CONSENSUS_TUNING.minConfidenceWeight, Number(match.confidence) || 0);
      existing.bestConfidence = Math.max(existing.bestConfidence, Number(match.confidence) || 0);

      if (Number.isFinite(match.pos) && match.pos >= 0) {
        existing.avgPosAccumulator += match.pos;
        existing.avgPosCount += 1;
      }

      votes.set(key, existing);
    }
  }

  const ranked = [...votes.values()].sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    if (b.weightedScore !== a.weightedScore) return b.weightedScore - a.weightedScore;
    if (b.bestConfidence !== a.bestConfidence) return b.bestConfidence - a.bestConfidence;
    return a.item.name.localeCompare(b.item.name);
  });

  const selectedWithPos = ranked
    .slice(0, estimatedCount)
    .map((entry) => {
      const avgPos =
        entry.avgPosCount > 0
          ? entry.avgPosAccumulator / entry.avgPosCount
          : Number.MAX_SAFE_INTEGER;
      return {
        avgPos,
        item: {
          ...entry.item,
          confidence: Number(entry.bestConfidence.toFixed(CONSENSUS_TUNING.confidenceDecimals)),
        },
      };
    })
    .sort((a, b) => a.avgPos - b.avgPos);

  const chosenItems = selectedWithPos.map((entry) => entry.item);

  const selectedPass = [...successful].sort((a, b) => {
    const aDelta = Math.abs(a.items.length - estimatedCount);
    const bDelta = Math.abs(b.items.length - estimatedCount);
    if (aDelta !== bDelta) return aDelta - bDelta;
    return b.score - a.score;
  })[0];

  return {
    items: chosenItems,
    selectedPass,
    strategy: "consensus",
    targetCount: estimatedCount,
  };
}
