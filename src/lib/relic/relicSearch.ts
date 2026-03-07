import type { RelicDatabase, RelicGroup } from "../../types/relics.js";

function normalizeRelicSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
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

export function relicGroupMatchesSearch(group: RelicGroup, query: string): boolean {
  const normalizedQuery = normalizeRelicSearchText(query);
  if (!normalizedQuery) return true;

  const compactQuery = compactRelicSearchText(query);
  const queryTokens = tokenizeRelicSearchText(query);
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
