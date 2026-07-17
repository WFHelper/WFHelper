/**
 * OCR text -> item matching helpers for reward scanning.
 */

import { levenshteinDistance } from "./rewardScannerUtils";
import { normalizeForOcr, normalizeForSearch } from "../config/shared/textNormalize";

export const MAX_REWARD_SLOTS = 4;
const EXACT_MATCH_SKIP_OVERLAP_COUNT = 3;
const MIN_MATCHED_WORDS_FOR_OVERLAP = 2;
const OVERLAP_CONFIDENCE_FLOOR = 0.86;

const RELIC_ERA_TOKENS: ReadonlyArray<{ token: string; text: string }> = Object.freeze([
  { token: "lith", text: "LITH" },
  { token: "meso", text: "MESO" },
  { token: "neo", text: "NEO" },
  { token: "axi", text: "AXI" },
  { token: "requiem", text: "REQUIEM" },
]);

function buildWordSet(text: string): Set<string> {
  return new Set(
    text
      .split(" ")
      .map((w) => w.trim())
      .filter((w) => w.length > 2),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findRewardPhrasePosition(text: string, phrase: string): number {
  if (!text || !phrase) return -1;
  const match = new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase)}(?=$|[^a-z0-9])`).exec(text);
  if (!match) return -1;
  return match.index + (match[1]?.length || 0);
}

function containsRewardPhrase(text: string, phrase: string): boolean {
  return findRewardPhrasePosition(text, phrase) >= 0;
}

function isUsefulPartialRewardText(text: string): boolean {
  const words = text.split(" ").filter((word) => word.length > 1);
  return words.length >= 2 || text.length >= 5;
}

export interface SortedItem {
  name: string;
  [key: string]: unknown;
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
  const text = normalizeForSearch(ocrText);
  if (!text) {
    return { items: [], score: 0, matches: [], exactCount: 0 };
  }

  const words = buildWordSet(text);
  const found: MatchEntry[] = [];
  const usedNames = new Set<string>();
  const overlapThreshold = Math.max(Number(threshold) || 0, OVERLAP_CONFIDENCE_FLOOR);

  for (const item of sortedItems) {
    if (found.length >= MAX_REWARD_SLOTS) break;
    const normalizedName = normalizeForSearch(item.name);
    if (!normalizedName || usedNames.has(normalizedName)) continue;

    const idx = findRewardPhrasePosition(text, normalizedName);
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
      const normalizedName = normalizeForSearch(item.name);
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
  const normalized = normalizeForSearch(word).replace(/[^a-z0-9]/g, "");
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

// Partial reads (wrapped first line, quantity prefix noise, glare-eaten word)
// rank below the slot gate. When a read structurally identifies exactly ONE
// item - name prefix, contained full name, or ordered word-subsequence with
// decent coverage - lift it over the gate; ambiguity leaves the gate in force.
const UNIQUE_STRUCTURAL_CONFIDENCE = 0.93;

// Word-level tolerance mirrors the fuzzy pass: OCR corruptions the alias table
// doesn't know ("lueorint" for "Blueprint") must not break structural matching.
function wordsEquivalent(textWord: string, nameWord: string): boolean {
  if (textWord === nameWord) return true;
  return similarityScore(textWord, nameWord) >= (nameWord.length >= 7 ? 0.7 : 0.78);
}

function isOrderedWordSubsequence(textWords: string[], nameWords: string[]): boolean {
  let nameIndex = 0;
  for (const word of textWords) {
    while (nameIndex < nameWords.length && !wordsEquivalent(word, nameWords[nameIndex])) {
      nameIndex += 1;
    }
    if (nameIndex >= nameWords.length) return false;
    nameIndex += 1;
  }
  return true;
}

function boostUniqueStructuralCandidate(
  ranked: SingleItemMatchResult[],
  text: string,
  textWords: string[],
): void {
  if (textWords.length < 2) return;
  if (ranked.some((entry) => entry.mode === "exact")) return;

  // Competitors are always present in `ranked`: containment implies a substring
  // entry, and subsequence coverage >= 0.6 clears the fuzzy word-ratio floor.
  // Keyed by name so duplicate pool entries don't fake ambiguity.
  const prefixHits = new Map<string, SingleItemMatchResult>();
  const containsHits = new Map<string, SingleItemMatchResult>();
  const subsequenceHits = new Map<string, SingleItemMatchResult>();
  for (const entry of ranked) {
    if (!entry.item) continue;
    const normalizedName = normalizeRewardText(entry.item.name);
    if (entry.mode === "substring" && normalizedName.startsWith(`${text} `)) {
      prefixHits.set(normalizedName, entry);
    } else if (entry.mode === "substring" && containsRewardPhrase(text, normalizedName)) {
      containsHits.set(normalizedName, entry);
    } else {
      const nameWords = normalizedName.split(" ").filter((word) => word.length > 1);
      if (
        nameWords.length > textWords.length &&
        textWords.length / nameWords.length >= 0.6 &&
        isOrderedWordSubsequence(textWords, nameWords)
      ) {
        subsequenceHits.set(normalizedName, entry);
      }
    }
  }

  // Strongest available signal decides; an ambiguous tier blocks the boost.
  const tier = [prefixHits, containsHits, subsequenceHits].find((hits) => hits.size > 0);
  if (!tier || tier.size !== 1) return;

  const entry = tier.values().next().value as SingleItemMatchResult;
  if (!entry.item || entry.confidence >= UNIQUE_STRUCTURAL_CONFIDENCE) return;
  entry.confidence = UNIQUE_STRUCTURAL_CONFIDENCE;
  entry.item.confidence = UNIQUE_STRUCTURAL_CONFIDENCE;
  const normalizedName = normalizeRewardText(entry.item.name);
  entry.score = 400 + UNIQUE_STRUCTURAL_CONFIDENCE * 92 + Math.min(8, normalizedName.length / 4);
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

    // Disjoint score bands: exact > substring > fuzzy, so a fuzzy near-miss on a
    // longer name can't outrank a perfect hit (e.g. Burston vs Braton Prime Stock).
    if (text === normalizedName) {
      ranked.push({
        item: { ...item, confidence: 1 },
        confidence: 1,
        score: 1000,
        mode: "exact",
      });
      continue;
    }

    if (
      containsRewardPhrase(text, normalizedName) ||
      (isUsefulPartialRewardText(text) && containsRewardPhrase(normalizedName, text))
    ) {
      const confidence = Math.max(0.88, similarityScore(text, normalizedName));
      ranked.push({
        item: { ...item, confidence: Number(confidence.toFixed(3)) },
        confidence,
        score: 400 + confidence * 92 + Math.min(8, normalizedName.length / 4),
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

  boostUniqueStructuralCandidate(ranked, text, textWords);

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
    .map((word) => normalizeForOcr(word))
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

// Filter-tab label above the relic grid. Fold I->L after normalizeForOcr so
// "ALL" misreads (AII, A11, ALI) still hit without lev-1 false positives (AXL).
export function detectRelicEraFromFilterLabelText(text: string): {
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

  let best: { era: string | null; confidence: number } = { era: null, confidence: 0 };
  for (const rawWord of normalized.split(" ")) {
    const word = normalizeForOcr(rawWord);
    if (word === "ALL" || word === "OMNIA") {
      return { era: "omnia", confidence: 1 };
    }
    if (word.length === 3 && word.replace(/I/g, "L") === "ALL" && best.confidence < 0.95) {
      best = { era: "omnia", confidence: 0.95 };
    }
  }

  const eraHit = detectRelicEraFromText(normalized);
  return eraHit.confidence > best.confidence ? eraHit : best;
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
