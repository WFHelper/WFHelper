import { normalizeWfmSlug } from "./backendLite.js";
import numericShared from "../../../config/shared/numeric.cjs";

const { normalizeRankFilter } = numericShared as {
  normalizeRankFilter: (value: unknown) => number | null;
};

const HOTSET_SCHEMA_VERSION = 1;
const HOTSET_MAX_ENTRIES = 64;

export interface RankedHotsetEntry {
  slug: string;
  maxRank: number;
  lastSeenAt: number;
}

export interface PersistedRankedHotset {
  version: number;
  entries: RankedHotsetEntry[];
}

const hotsetBySlug = new Map<string, RankedHotsetEntry>();

function sortEntries(entries: RankedHotsetEntry[]): RankedHotsetEntry[] {
  return [...entries].sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.slug.localeCompare(b.slug));
}

function pruneHotset(): void {
  const sorted = sortEntries([...hotsetBySlug.values()]).slice(0, HOTSET_MAX_ENTRIES);
  hotsetBySlug.clear();
  for (const entry of sorted) {
    hotsetBySlug.set(entry.slug, entry);
  }
}

export function recordRankedHotsetEntry(
  slugInput: string | null | undefined,
  maxRankInput: number | null | undefined,
): void {
  const slug = normalizeWfmSlug(slugInput);
  const maxRank = normalizeRankFilter(maxRankInput);
  if (!slug || maxRank == null || maxRank <= 0) return;

  hotsetBySlug.set(slug, {
    slug,
    maxRank,
    lastSeenAt: Date.now(),
  });
  pruneHotset();
}

export function getRankedHotsetEntries(): RankedHotsetEntry[] {
  pruneHotset();
  return sortEntries([...hotsetBySlug.values()]);
}

export function getRankedHotsetSeenAt(slugInput: string | null | undefined): number {
  const slug = normalizeWfmSlug(slugInput);
  if (!slug) return 0;
  return hotsetBySlug.get(slug)?.lastSeenAt ?? 0;
}

export function exportRankedHotset(): PersistedRankedHotset {
  return {
    version: HOTSET_SCHEMA_VERSION,
    entries: getRankedHotsetEntries(),
  };
}

export function importRankedHotset(data: Record<string, unknown>): number {
  const version = Number(data.version || 0);
  if (version !== HOTSET_SCHEMA_VERSION) return 0;

  const rawEntries = Array.isArray(data.entries) ? data.entries : [];
  let imported = 0;

  for (const entry of rawEntries) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const slug = normalizeWfmSlug(typeof row.slug === "string" ? row.slug : null);
    const maxRank = normalizeRankFilter(row.maxRank);
    const lastSeenAt = Number(row.lastSeenAt || 0);
    if (!slug || maxRank == null || maxRank <= 0) continue;
    if (!Number.isFinite(lastSeenAt) || lastSeenAt <= 0) continue;

    const existing = hotsetBySlug.get(slug);
    if (existing && existing.lastSeenAt >= lastSeenAt) continue;

    hotsetBySlug.set(slug, {
      slug,
      maxRank,
      lastSeenAt: Math.round(lastSeenAt),
    });
    imported += 1;
  }

  pruneHotset();
  return imported;
}

export function clearRankedHotset(): void {
  hotsetBySlug.clear();
}
