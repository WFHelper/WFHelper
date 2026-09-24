import { asRecord } from "./objectValidation";

export type RelicQuality = "intact" | "exceptional" | "flawless" | "radiant";
export type RelicQualityMode = "owned" | RelicQuality;
export type RelicSortMode = "tier" | "name" | "ev" | "ducat" | "ducatonator" | "owned";
export type RelicVaultedMode = "all" | "vaulted" | "unvaulted";
export type RelicSortDirection = "asc" | "desc";

export const RELIC_QUALITY_MODES: readonly RelicQuality[] = Object.freeze([
  "intact",
  "exceptional",
  "flawless",
  "radiant",
] as const);

const RELIC_TIER_ORDER: Record<string, number> = {
  Lith: 0,
  Meso: 1,
  Neo: 2,
  Axi: 3,
  Requiem: 4,
};

const SORT_MODES: readonly RelicSortMode[] = [
  "tier",
  "name",
  "ev",
  "ducat",
  "ducatonator",
  "owned",
];
const SORT_DIRECTIONS: readonly RelicSortDirection[] = ["asc", "desc"];
const VAULTED_MODES: readonly RelicVaultedMode[] = ["all", "vaulted", "unvaulted"];
const QUALITY_MODES: readonly RelicQualityMode[] = ["owned", ...RELIC_QUALITY_MODES];

/** Copy thresholds the "more than N" filter offers; 0 keeps every relic. */
export const RELIC_OWNED_ABOVE_STEPS: readonly number[] = Object.freeze([2, 4, 6, 8, 10]);
const OWNED_ABOVE_VALUES: readonly number[] = Object.freeze([0, ...RELIC_OWNED_ABOVE_STEPS]);

const MAX_SEARCH_LENGTH = 200;
const MIN_SQUAD_SIZE = 1;
const MAX_SQUAD_SIZE = 4;
const MAX_NEEDED_REWARD_KEYS = 4000;
const MAX_GROUP_KEY_LENGTH = 64;

/** Everything the planner's relic list is filtered and ordered by. The tier tab
 *  and the ownership toggle are not here: the overlay takes its era from the
 *  game and never lists unowned relics. */
export interface RelicPlannerFilters {
  squadSize: number;
  search: string;
  containsNeededReward: boolean;
  vaultedMode: RelicVaultedMode;
  qualityMode: RelicQualityMode;
  /** Hides relics whose total copies are at or below this; 0 is off. */
  ownedAbove: number;
  sortMode: RelicSortMode;
  sortDirection: RelicSortDirection;
}

export const DEFAULT_RELIC_PLANNER_FILTERS: RelicPlannerFilters = {
  squadSize: 1,
  search: "",
  containsNeededReward: false,
  vaultedMode: "all",
  qualityMode: "owned",
  ownedAbove: 0,
  sortMode: "tier",
  sortDirection: "asc",
};

/** A relic reduced to what ordering reads. Each side fills the metrics from its
 *  own price source, so `null` means "that source has no value", not zero. */
export interface RelicPlannerRow {
  name: string;
  tier: string;
  vaulted: boolean;
  ownedCount: number;
  /** Copies across every grade. The copies filter reads this instead of
   *  ownedCount so the quality select cannot change what it hides. */
  ownedTotal: number;
  plat: number | null;
  ducat: number | null;
  ratio: number | null;
}

/** The two predicates whose data lives on only one side: the search index and
 *  the needed-reward engine. */
interface RelicPlannerRowHooks<T> {
  matchesSearch: (row: T) => boolean;
  hasNeededReward: (row: T) => boolean;
}

type RelicOwnedCounts = Partial<Record<RelicQuality, number>> | null | undefined;

/** Highest owned grade, scanning best-first. Null when none owned. */
export function highestOwnedQuality(
  qualities: readonly RelicQuality[],
  ownedCount: (quality: RelicQuality) => number,
): RelicQuality | null {
  for (let i = qualities.length - 1; i >= 0; i--) {
    if (ownedCount(qualities[i]) > 0) return qualities[i];
  }
  return null;
}

/** Copies the quality mode counts: every grade in "owned" mode, one otherwise. */
export function relicOwnedCountForMode(
  owned: RelicOwnedCounts,
  qualityMode: RelicQualityMode,
): number {
  if (qualityMode !== "owned") return owned?.[qualityMode] ?? 0;
  return RELIC_QUALITY_MODES.reduce((sum, quality) => sum + (owned?.[quality] ?? 0), 0);
}

/** The grade whose expected value the mode shows. "owned" prefers the grade the
 *  user pinned on the card and otherwise the highest owned one. */
export function relicQualityForMode(
  qualityMode: RelicQualityMode,
  owned: RelicOwnedCounts,
  preferred?: RelicQuality | null,
): RelicQuality | null {
  if (qualityMode !== "owned") return qualityMode;
  if (preferred && (owned?.[preferred] ?? 0) > 0) return preferred;
  return highestOwnedQuality(RELIC_QUALITY_MODES, (quality) => owned?.[quality] ?? 0);
}

export function relicDucatonator(plat: number | null, ducat: number | null): number | null {
  if (ducat == null || plat == null || plat <= 0) return null;
  return ducat / plat;
}

export function compareRelicTierThenName(
  a: Pick<RelicPlannerRow, "name" | "tier">,
  b: Pick<RelicPlannerRow, "name" | "tier">,
): number {
  const tierA = RELIC_TIER_ORDER[a.tier] ?? 99;
  const tierB = RELIC_TIER_ORDER[b.tier] ?? 99;
  return tierA !== tierB ? tierA - tierB : a.name.localeCompare(b.name);
}

function compareNullableRelicMetric(
  a: RelicPlannerRow,
  b: RelicPlannerRow,
  direction: number,
  getMetric: (row: RelicPlannerRow) => number | null,
): number {
  const aValue = getMetric(a);
  const bValue = getMetric(b);

  if ((aValue == null) !== (bValue == null)) return aValue == null ? 1 : -1;
  if (aValue != null && bValue != null && aValue !== bValue) {
    return direction * (aValue - bValue);
  }

  return compareRelicTierThenName(a, b);
}

function compareRelicPlannerRows(
  a: RelicPlannerRow,
  b: RelicPlannerRow,
  sortMode: RelicSortMode,
  sortDirection: RelicSortDirection,
): number {
  const direction = sortDirection === "desc" ? -1 : 1;

  if (sortMode === "name") return direction * a.name.localeCompare(b.name);
  if (sortMode === "tier") return direction * compareRelicTierThenName(a, b);
  if (sortMode === "owned") {
    return compareNullableRelicMetric(a, b, direction, (row) => row.ownedCount);
  }

  const metricKey = sortMode === "ducatonator" ? "ratio" : sortMode === "ducat" ? "ducat" : "plat";
  return compareNullableRelicMetric(a, b, direction, (row) => row[metricKey]);
}

export function sortRelicPlannerRows<T extends RelicPlannerRow>(
  rows: readonly T[],
  sortMode: RelicSortMode,
  sortDirection: RelicSortDirection,
): T[] {
  return [...rows].sort((a, b) => compareRelicPlannerRows(a, b, sortMode, sortDirection));
}

export function selectRelicPlannerRows<T extends RelicPlannerRow>(
  rows: readonly T[],
  filters: RelicPlannerFilters,
  hooks: RelicPlannerRowHooks<T>,
): T[] {
  const { vaultedMode } = filters;
  const kept = rows.filter((row) => {
    if (vaultedMode !== "all" && row.vaulted !== (vaultedMode === "vaulted")) return false;
    if (filters.ownedAbove > 0 && row.ownedTotal <= filters.ownedAbove) return false;
    if (filters.search && !hooks.matchesSearch(row)) return false;
    if (filters.containsNeededReward && !hooks.hasNeededReward(row)) return false;
    return true;
  });
  return sortRelicPlannerRows(kept, filters.sortMode, filters.sortDirection);
}

/** What the planner's "Push to Overlay" button sends. */
export interface RelicOverlayFilterPush extends RelicPlannerFilters {
  /** Era hint only; the era detected in the game still wins. */
  tierFilter: string | null;
  /** Relic group keys the planner's needed-reward engine kept, null when that
   *  filter is off. Main cannot run that engine itself. */
  neededRewardKeys: string[] | null;
  /** Group key -> the grade pinned on that planner card, which owned mode reads
   *  instead of the highest owned one. */
  pinnedQualities: Record<string, RelicQuality> | null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function squadSizeOr(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return value >= MIN_SQUAD_SIZE && value <= MAX_SQUAD_SIZE ? value : fallback;
}

function ownedAboveOr(value: unknown, fallback: number): number {
  return typeof value === "number" && OWNED_ABOVE_VALUES.includes(value) ? value : fallback;
}

/** Untrusted IPC payload -> filters, every field falling back to the state the
 *  overlay already runs on. */
export function normalizeRelicPlannerFilters(
  raw: unknown,
  fallback: RelicPlannerFilters = DEFAULT_RELIC_PLANNER_FILTERS,
): RelicPlannerFilters {
  const record = asRecord(raw);
  if (!record) return { ...fallback };

  const search = typeof record.search === "string" ? record.search : fallback.search;
  return {
    squadSize: squadSizeOr(record.squadSize, fallback.squadSize),
    search: search.length > MAX_SEARCH_LENGTH ? search.slice(0, MAX_SEARCH_LENGTH) : search,
    containsNeededReward:
      typeof record.containsNeededReward === "boolean"
        ? record.containsNeededReward
        : fallback.containsNeededReward,
    vaultedMode: oneOf(record.vaultedMode, VAULTED_MODES, fallback.vaultedMode),
    qualityMode: oneOf(record.qualityMode, QUALITY_MODES, fallback.qualityMode),
    ownedAbove: ownedAboveOr(record.ownedAbove, fallback.ownedAbove),
    sortMode: oneOf(record.sortMode, SORT_MODES, fallback.sortMode),
    sortDirection: oneOf(record.sortDirection, SORT_DIRECTIONS, fallback.sortDirection),
  };
}

function relicGroupKeys(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const keys: string[] = [];
  for (const entry of value.slice(0, MAX_NEEDED_REWARD_KEYS)) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed && trimmed.length <= MAX_GROUP_KEY_LENGTH) keys.push(trimmed);
  }
  return keys;
}

function isRelicQuality(value: unknown): value is RelicQuality {
  return typeof value === "string" && (RELIC_QUALITY_MODES as readonly string[]).includes(value);
}

function pinnedQualities(value: unknown): Record<string, RelicQuality> | null {
  const record = asRecord(value);
  if (!record) return null;
  const pinned: Record<string, RelicQuality> = {};
  for (const [key, quality] of Object.entries(record).slice(0, MAX_NEEDED_REWARD_KEYS)) {
    const groupKey = key.trim();
    if (!groupKey || groupKey.length > MAX_GROUP_KEY_LENGTH) continue;
    // A literal target turns a "__proto__" key into a prototype write.
    if (groupKey === "__proto__") continue;
    if (!isRelicQuality(quality)) continue;
    pinned[groupKey] = quality;
  }
  return pinned;
}

export function normalizeRelicOverlayFilterPush(
  raw: unknown,
  fallback: RelicPlannerFilters = DEFAULT_RELIC_PLANNER_FILTERS,
): RelicOverlayFilterPush {
  const record = asRecord(raw);
  return {
    ...normalizeRelicPlannerFilters(raw, fallback),
    tierFilter: typeof record?.tierFilter === "string" ? record.tierFilter : null,
    neededRewardKeys: relicGroupKeys(record?.neededRewardKeys),
    pinnedQualities: pinnedQualities(record?.pinnedQualities),
  };
}
