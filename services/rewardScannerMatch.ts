import { levenshteinDistance } from "./rewardScannerUtils";
import { normalizeOcrPhrase } from "../config/shared/ocrPhrase";
import { hasQuantityPrefix, stripQuantityPrefix } from "../config/shared/quantityPrefix";
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

// The card prints the bonus count as "2 X" while the pool name is "2X Forma
// Blueprint", so the spacing is collapsed before anything compares the two.
const QUANTITY_PREFIX_SPACING = /^(\d+)\s+x(?=\s|$)/;

function normalizeRewardText(text: string): string {
  return String(text || "")
    .split(/\s+/)
    .map((word) => normalizeRewardWord(word))
    .filter(Boolean)
    .join(" ")
    .trim()
    .replace(QUANTITY_PREFIX_SPACING, "$1x");
}

// High-resolution captures merge glyph pairs and print digit lookalikes:
// "Blueprint" comes back as "81ueprint", or with the "B" read as an accented
// letter that word normalization drops, welding "lueprint" onto the word
// before it. Folding those back and dropping spacing recovers the name.
const OCR_CONFUSIONS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/8/g, "b"],
  [/0/g, "o"],
  [/1/g, "l"],
  [/5/g, "s"],
]);

function foldOcrConfusions(value: string): string {
  let folded = String(value || "").toLowerCase();
  for (const [pattern, replacement] of OCR_CONFUSIONS) {
    folded = folded.replace(pattern, replacement);
  }
  return folded.replace(/[^a-z0-9]/g, "");
}

// Every ranked read re-normalizes the whole item pool, so keep the per-name work.
const MAX_CACHED_NAMES = 8000;
const normalizedNameCache = new Map<string, string>();
const foldedNameCache = new Map<string, string>();

function cachedName(cache: Map<string, string>, name: string, build: () => string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  if (cache.size >= MAX_CACHED_NAMES) cache.clear();
  const value = build();
  cache.set(name, value);
  return value;
}

function normalizedItemName(name: string): string {
  return cachedName(normalizedNameCache, name, () => normalizeRewardText(name));
}

function foldedItemName(name: string): string {
  return cachedName(foldedNameCache, name, () => foldOcrConfusions(normalizedItemName(name)));
}

// "2X Forma Blueprint" and "Forma Blueprint" are both real rewards. A pair that
// differs only by the leading count follows the read, so a text with no count
// cannot be handed the counted name. A counted name with no bare sibling in the
// pool is the only spelling there is, so it stays reachable either way.
function dropQuantityPrefixMismatches(
  ranked: SingleItemMatchResult[],
  text: string,
): SingleItemMatchResult[] {
  const entryBare = new Map<SingleItemMatchResult, { bareName: string; counted: boolean }>();
  const bareSeen = new Set<string>();
  const countedSeen = new Set<string>();
  for (const entry of ranked) {
    if (!entry.item) continue;
    const name = normalizedItemName(entry.item.name);
    const bareName = stripQuantityPrefix(name);
    if (!bareName) continue;
    const counted = bareName !== name;
    entryBare.set(entry, { bareName, counted });
    (counted ? countedSeen : bareSeen).add(bareName);
  }
  if (countedSeen.size === 0) return ranked;

  const textHasQuantity = hasQuantityPrefix(text);
  return ranked.filter((entry) => {
    const info = entryBare.get(entry);
    if (!info) return true;
    if (!bareSeen.has(info.bareName) || !countedSeen.has(info.bareName)) return true;
    return textHasQuantity === info.counted;
  });
}

// Lift a partial structural match only when it uniquely identifies one item.
const UNIQUE_STRUCTURAL_CONFIDENCE = 0.93;
// Shortest a fuzzy candidate may be relative to the read it claims to be.
const MIN_FUZZY_NAME_LENGTH_RATIO = 0.45;
// Fewest of a name's words a fuzzy candidate may match to stay in the ranking.
const MIN_FUZZY_WORD_RATIO = 0.45;
// How much of a name a subsequence read must carry before it may win its tier.
const MIN_SUBSEQUENCE_WORD_RATIO = 0.6;
// Shortest read word that carries evidence; below this it is OCR noise.
const MIN_MEANINGFUL_READ_WORD_LENGTH = 3;
// Every containment match is clamped up to this, so its score is not a measurement.
export const SUBSTRING_SCORE_FLOOR = 0.88;
// A confusion-folded hit is an equality, but not of the printed spelling.
const FOLDED_EXACT_CONFIDENCE = 0.99;
// Sibling part names sit near 0.7 folded, so this gate has room; the length
// floor keeps short mod names out, where one edit is most of the word.
const FOLDED_NEAR_MIN_SIMILARITY = 0.94;
const FOLDED_NEAR_MIN_LENGTH = 12;

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

  // Key by name so duplicate pool entries cannot fake ambiguity.
  const prefixHits = new Map<string, SingleItemMatchResult>();
  const containsHits = new Map<string, SingleItemMatchResult>();
  const subsequenceHits = new Map<string, SingleItemMatchResult>();
  const thinSubsequence = new Set<string>();
  for (const entry of ranked) {
    if (!entry.item) continue;
    const normalizedName = normalizedItemName(entry.item.name);
    if (entry.mode === "substring" && normalizedName.startsWith(`${text} `)) {
      prefixHits.set(normalizedName, entry);
    } else if (entry.mode === "substring" && containsRewardPhrase(text, normalizedName)) {
      containsHits.set(normalizedName, entry);
    } else {
      const nameWords = normalizedName.split(" ").filter((word) => word.length > 1);
      if (nameWords.length <= textWords.length) continue;
      if (!isOrderedWordSubsequence(textWords, nameWords)) continue;
      // Thin evidence bars a name from winning, never from competing: culling it
      // here would leave a rival alone in the tier and make it look unique.
      subsequenceHits.set(normalizedName, entry);
      if (textWords.length / nameWords.length < MIN_SUBSEQUENCE_WORD_RATIO) {
        thinSubsequence.add(normalizedName);
      }
    }
  }

  // Strongest available signal decides; a tier holding more than one name is
  // ambiguous and blocks the boost.
  const tier = [prefixHits, containsHits, subsequenceHits].find((hits) => hits.size > 0);
  if (!tier || tier.size !== 1) return;

  const [name, target] = tier.entries().next().value as [string, SingleItemMatchResult];
  if (!target.item || thinSubsequence.has(name)) return;
  if (target.confidence >= UNIQUE_STRUCTURAL_CONFIDENCE) return;
  target.confidence = UNIQUE_STRUCTURAL_CONFIDENCE;
  target.item.confidence = target.confidence;
  target.score = 400 + target.confidence * 92 + Math.min(8, name.length / 4);
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
  const foldedText = foldOcrConfusions(text);
  const textHasQuantity = hasQuantityPrefix(text);
  const ranked: SingleItemMatchResult[] = [];

  for (const item of sortedItems) {
    const normalizedName = normalizedItemName(item.name);
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

    const foldedName = foldedItemName(item.name);
    if (foldedText && foldedText === foldedName) {
      // Scored just under a literal hit so the untouched spelling still wins.
      ranked.push({
        item: { ...item, confidence: FOLDED_EXACT_CONFIDENCE },
        confidence: FOLDED_EXACT_CONFIDENCE,
        score: 990,
        mode: "exact",
      });
      continue;
    }

    if (
      containsRewardPhrase(text, normalizedName) ||
      (isUsefulPartialRewardText(text) && containsRewardPhrase(normalizedName, text))
    ) {
      const confidence = Math.max(SUBSTRING_SCORE_FLOOR, similarityScore(text, normalizedName));
      ranked.push({
        item: { ...item, confidence: Number(confidence.toFixed(3)) },
        confidence,
        score: 400 + confidence * 92 + Math.min(8, normalizedName.length / 4),
        mode: "substring",
      });
      continue;
    }

    // A merged word breaks the per-word fuzzy pass even when the whole read is
    // one edit off the name, so compare the folded spellings as well. Long names
    // only, at a gate no sibling part name reaches, and never across a leading
    // count - "2X" and "5X" names differ by the one character folding blurs.
    if (
      !textHasQuantity &&
      !hasQuantityPrefix(normalizedName) &&
      foldedText.length >= FOLDED_NEAR_MIN_LENGTH &&
      foldedName.length >= FOLDED_NEAR_MIN_LENGTH
    ) {
      const folded = similarityScore(foldedText, foldedName);
      if (folded >= FOLDED_NEAR_MIN_SIMILARITY) {
        ranked.push({
          item: { ...item, confidence: Number(folded.toFixed(3)) },
          confidence: folded,
          score: 400 + folded * 92 + Math.min(8, normalizedName.length / 4),
          mode: "substring",
        });
        continue;
      }
    }

    // The fuzzy band scores per word, so a name much shorter than the read can
    // ride one good word over the gate. Ratio, not an absolute floor: short
    // rewards exist and a short read must still reach them. Exact and substring
    // already prove fit.
    if (normalizedName.length < text.length * MIN_FUZZY_NAME_LENGTH_RATIO) continue;

    const itemWords = normalizedName.split(" ").filter((word) => word.length > 1);
    if (itemWords.length === 0) continue;

    let matchedWords = 0;
    const explainedTextWords = new Array<boolean>(textWords.length).fill(false);
    for (const itemWord of itemWords) {
      let wordMatched = false;
      for (let index = 0; index < textWords.length; index += 1) {
        if (!wordsEquivalent(textWords[index], itemWord)) continue;
        wordMatched = true;
        explainedTextWords[index] = true;
      }
      if (wordMatched) matchedWords += 1;
    }

    const wordRatio = matchedWords / itemWords.length;
    if (wordRatio < MIN_FUZZY_WORD_RATIO) continue;

    // Take the weaker direction: scoring only the name's own words would pay a
    // candidate for the read words it ignores, so a corrupted component word
    // could hand the card to a shorter name. A one or two character token is
    // OCR noise, not a word, and counts for neither side.
    const explained = explainedTextWords.filter(Boolean).length;
    const unexplained = textWords.filter(
      (word, index) => !explainedTextWords[index] && word.length >= MIN_MEANINGFUL_READ_WORD_LENGTH,
    ).length;
    // The word-ratio gate above needed a matched word, so explained is never 0.
    const readRatio = explained / (explained + unexplained);
    const coverage = Math.min(wordRatio, readRatio);

    let bestSpanScore = similarityScore(text, normalizedName);
    if (textWords.length >= itemWords.length) {
      for (let start = 0; start <= textWords.length - itemWords.length; start += 1) {
        const span = textWords.slice(start, start + itemWords.length).join(" ");
        bestSpanScore = Math.max(bestSpanScore, similarityScore(span, normalizedName));
      }
    }

    const confidence = Math.min(0.97, coverage * 0.6 + bestSpanScore * 0.4);
    ranked.push({
      item: { ...item, confidence: Number(confidence.toFixed(3)) },
      confidence,
      score: confidence * 100 + matchedWords * 2,
      mode: "fuzzy",
    });
  }

  const survivors = dropQuantityPrefixMismatches(ranked, text);
  boostUniqueStructuralCandidate(survivors, text, textWords);

  survivors.sort(
    (a, b) =>
      b.score - a.score ||
      b.confidence - a.confidence ||
      (b.item?.name.length || 0) - (a.item?.name.length || 0),
  );
  return survivors.slice(0, Math.max(1, limit));
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

/** The one acceptance rule for an era word: exact, either-way prefix, or one
 *  edit. The detector and the ambiguity guard must share it, or an era the
 *  detector reads through a misread ("LITK") stays invisible to the guard. */
function matchEraToken(word: string): { token: string; confidence: number } | null {
  for (const era of RELIC_ERA_TOKENS) {
    if (word === era.text) return { token: era.token, confidence: 1 };
  }
  if (word.length < 3) return null;
  for (const era of RELIC_ERA_TOKENS) {
    if (era.text.startsWith(word) || word.startsWith(era.text)) {
      return { token: era.token, confidence: 0.82 };
    }
  }
  for (const era of RELIC_ERA_TOKENS) {
    if (levenshteinDistance(word, era.text) <= 1) {
      return { token: era.token, confidence: 0.76 };
    }
  }
  return null;
}

/** Era words mentioned as whole words, so a screen listing several fissures
 *  reads as ambiguous instead of as whichever era happens to come first. */
function distinctEraMentions(normalized: string): Set<string> {
  const found = new Set<string>();
  for (const raw of normalized.split(" ")) {
    const word = normalizeForOcr(raw);
    if (word === "OMNIA") {
      found.add("omnia");
      continue;
    }
    const hit = matchEraToken(word);
    if (hit) found.add(hit.token);
  }
  return found;
}

function detectRelicEraFromText(text: string): { era: string | null; confidence: number } {
  const normalized = normalizeOcrPhrase(text);

  if (!normalized) {
    return { era: null, confidence: 0 };
  }

  const words = normalized
    .split(" ")
    .map((word) => normalizeForOcr(word))
    .filter((word) => word.length >= 2);

  let best: { era: string | null; confidence: number } = { era: null, confidence: 0 };

  for (const word of words) {
    const hit = matchEraToken(word);
    if (!hit) continue;
    if (hit.confidence >= 1) return { era: hit.token, confidence: 1 };
    if (hit.confidence > best.confidence) best = { era: hit.token, confidence: hit.confidence };
  }

  return best;
}

// Filter-tab label above the relic grid. Fold I->L after normalizeForOcr so
// "ALL" misreads (AII, A11, ALI) still hit without lev-1 false positives (AXL).
export function detectRelicEraFromFilterLabelText(text: string): {
  era: string | null;
  confidence: number;
} {
  const normalized = normalizeOcrPhrase(text);

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

/** Header band above the relic grid. Shares the tile guard: the band is wide
 *  enough to catch a fissure list or a neighbouring panel. */
export function detectRelicEraFromBandText(text: string): {
  era: string | null;
  confidence: number;
} {
  const normalized = normalizeOcrPhrase(text);

  if (!normalized) return { era: null, confidence: 0 };
  if (distinctEraMentions(normalized).size > 1) return { era: null, confidence: 0 };
  return detectRelicEraFromText(normalized);
}

export function detectRelicEraFromTileLabelText(text: string): {
  era: string | null;
  confidence: number;
} {
  const normalized = normalizeOcrPhrase(text);

  if (!normalized) {
    return { era: null, confidence: 0 };
  }

  // The star chart lists every active fissure, so a tile crop that catches the
  // navigation panel sees several eras at once; the first one is not the pick.
  if (distinctEraMentions(normalized).size > 1) {
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
