import type { RelicDatabase, RelicGroup, RelicQuality, RelicReward } from "../../types/relics.js";

const RELIC_QUALITIES: RelicQuality[] = ["intact", "exceptional", "flawless", "radiant"];

interface RelicSearchOptions {
  /** Localised quality labels so "Strahlend" splits out like "Radiant" does. */
  qualityLabels?: Partial<Record<RelicQuality, string>>;
  /** Owned copies per quality for this group; `undefined` means no inventory, so
   *  quality words are ignored rather than hiding everything. */
  ownedCounts?: Partial<Record<RelicQuality, number>> | null | undefined;
}

// Unicode letters, not [a-z]: an ASCII-only class tokenizes a Chinese quality
// label to nothing, and the refinement filter then keeps every group.
function normalizeRelicSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function compactRelicSearchText(value: string): string {
  return normalizeRelicSearchText(value).replace(/\s+/g, "");
}

function tokenizeRelicSearchText(value: string): string[] {
  const normalized = normalizeRelicSearchText(value);
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean);
}

function stripPrimeBlueprintWords(value: string): string {
  const normalized = normalizeRelicSearchText(value);
  if (!normalized) return "";
  return normalized
    .replace(/\b(prime|blueprint)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectRelicSearchTerms(group: RelicGroup): string[] {
  const terms = new Set<string>();

  const addTerm = (value: string | null | undefined): void => {
    if (!value || typeof value !== "string") return;

    const normalized = normalizeRelicSearchText(value);
    if (!normalized) return;
    terms.add(normalized);

    const stripped = stripPrimeBlueprintWords(value);
    if (stripped) terms.add(stripped);
  };

  addTerm(group.name);
  addTerm(`${group.tier} ${group.code}`);

  for (const qualityData of Object.values(group.qualities || {})) {
    if (!qualityData) continue;
    for (const reward of qualityData.rewards || []) {
      addTerm(reward.name);
      if (reward.urlName) {
        addTerm(reward.urlName.replace(/_/g, " "));
      }
    }
  }

  return [...terms];
}

/** Pulls refinement words ("radiant", or the localised label) out of a query so
 *  they act as a filter instead of a text term no relic would ever match. */
function splitQualityTokens(
  query: string,
  labels: Partial<Record<RelicQuality, string>> | undefined,
): { qualities: RelicQuality[]; rest: string } {
  let tokens = tokenizeRelicSearchText(query);
  const qualities: RelicQuality[] = [];
  for (const quality of RELIC_QUALITIES) {
    const variants = [quality, labels?.[quality] ?? ""]
      .map((label) => tokenizeRelicSearchText(label))
      .filter((variant) => variant.length > 0);
    for (const variant of variants) {
      const at = tokens.findIndex((_, i) => variant.every((word, j) => tokens[i + j] === word));
      if (at < 0) continue;
      tokens = [...tokens.slice(0, at), ...tokens.slice(at + variant.length)];
      if (!qualities.includes(quality)) qualities.push(quality);
    }
  }
  return { qualities, rest: tokens.join(" ") };
}

export function relicGroupMatchesSearch(
  group: RelicGroup,
  query: string,
  options?: RelicSearchOptions,
): boolean {
  const split = splitQualityTokens(query, options?.qualityLabels);
  if (split.qualities.length > 0 && options && options.ownedCounts !== undefined) {
    const owned = options.ownedCounts;
    if (!split.qualities.some((quality) => (owned?.[quality] ?? 0) > 0)) return false;
  }
  const effectiveQuery = split.qualities.length > 0 ? split.rest : query;

  const normalizedQuery = normalizeRelicSearchText(effectiveQuery);
  if (!normalizedQuery) return true;

  const compactQuery = compactRelicSearchText(effectiveQuery);
  const queryTokens = tokenizeRelicSearchText(effectiveQuery);
  const terms = collectRelicSearchTerms(group);

  for (const term of terms) {
    if (term.includes(normalizedQuery)) return true;
    if (compactQuery && compactRelicSearchText(term).includes(compactQuery)) return true;

    if (queryTokens.length > 1) {
      const termTokenSet = new Set(tokenizeRelicSearchText(term));
      if (queryTokens.every((token) => termTokenSet.has(token))) {
        return true;
      }
    }
  }

  return false;
}

export function relicGroupHasMatchingReward(
  group: RelicGroup,
  predicate: (reward: RelicReward) => boolean,
): boolean {
  const seen = new Set<string>();
  for (const qualityData of Object.values(group.qualities || {})) {
    for (const reward of qualityData?.rewards || []) {
      const key = reward.uniqueName || reward.urlName || reward.name;
      if (seen.has(key)) continue;
      seen.add(key);
      if (predicate(reward)) return true;
    }
  }
  return false;
}

export function buildRelicSearchKeywordIndex(
  relicDb: RelicDatabase | null | undefined,
): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  if (!relicDb) return index;

  for (const group of Object.values(relicDb.groups || {})) {
    const terms = collectRelicSearchTerms(group);
    if (terms.length === 0) continue;

    for (const qualityData of Object.values(group.qualities || {})) {
      const uniqueName = qualityData?.uniqueName;
      if (!uniqueName) continue;

      const merged = new Set<string>(index[uniqueName] || []);
      for (const term of terms) merged.add(term);
      index[uniqueName] = [...merged];
    }
  }

  return index;
}
