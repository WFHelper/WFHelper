import { fallbackNameFromUniqueName } from "../../config/shared/displayName.js";
import type {
  MissionRewardsFailure,
  MissionRewardsStatus,
} from "../../config/shared/missionRewardsTypes.js";
import { MISSION_TYPE_LABELS } from "../../config/shared/missionTypes.js";
import { sanitizeWfmSlug, titleCase } from "../../config/shared/textNormalize.js";
import { rendererPriceCacheKey } from "../../config/shared/wfmCacheKeys.js";
import type { MessageKey, Translator } from "./i18n.js";
import { getLookupByGameRef, getLookupByName } from "./inventoryMarket.js";
import { relicGroupForUniqueName } from "./relic.js";
import type { ItemDbEntry } from "../types/inventory.js";
import type { MissionRewardItem, MissionRewardSummaryView, WfmItemsLookup } from "../types/ipc.js";
import type { RelicDatabase } from "../types/relics.js";

export interface RewardRow {
  uniqueName: string;
  name: string;
  imageUrl: string | null;
  count: number;
  vaulted: boolean;
  platinum: number | null;
  ducats: number | null;
  unpriced: boolean;
  openable: boolean;
}

interface RewardRowTotals {
  platinum: number;
  ducats: number;
  unpriced: number;
}

export interface RewardRowSources {
  db: Record<string, ItemDbEntry>;
  lookup: WfmItemsLookup;
  relics: RelicDatabase | null;
  /** Median for a renderer price cache key, from the price snapshot store. */
  priceOf: (cacheKey: string) => number | null;
}

function marketSlug(uniqueName: string, name: string, lookup: WfmItemsLookup): string | null {
  const entry = getLookupByGameRef(uniqueName, lookup) ?? getLookupByName(name, lookup);
  return entry ? sanitizeWfmSlug(entry.url_name) : null;
}

// Rewards arrive unranked, so a rank-0 price wins over the bare slug, which
// tracks whichever rank sold last.
function cachedPlatinum(slug: string, priceOf: RewardRowSources["priceOf"]): number | null {
  return priceOf(rendererPriceCacheKey(slug, 0)) ?? priceOf(rendererPriceCacheKey(slug, null));
}

function buildRow(item: MissionRewardItem, sources: RewardRowSources): RewardRow {
  const entry: ItemDbEntry | undefined = sources.db[item.uniqueName];
  const englishName = entry?.name || fallbackNameFromUniqueName(item.uniqueName);
  const slug =
    entry?.tradable === true ? marketSlug(item.uniqueName, englishName, sources.lookup) : null;
  const each = slug ? cachedPlatinum(slug, sources.priceOf) : null;
  const ducats = typeof entry?.ducats === "number" && entry.ducats > 0 ? entry.ducats : null;
  return {
    uniqueName: item.uniqueName,
    name: entry?.displayName || englishName,
    imageUrl: entry?.imageUrl ?? null,
    count: item.count,
    vaulted: entry?.vaulted === true,
    platinum: each === null ? null : each * item.count,
    ducats: ducats === null ? null : ducats * item.count,
    unpriced: entry?.tradable === true && each === null,
    openable: Boolean(entry) || relicGroupForUniqueName(sources.relics, item.uniqueName) !== null,
  };
}

/** Most valuable first: platinum, then ducats, then name. */
export function buildRewardRows(
  items: readonly MissionRewardItem[],
  sources: RewardRowSources,
): RewardRow[] {
  return items
    .map((item) => buildRow(item, sources))
    .sort(
      (a, b) =>
        (b.platinum ?? -1) - (a.platinum ?? -1) ||
        (b.ducats ?? -1) - (a.ducats ?? -1) ||
        a.name.localeCompare(b.name),
    );
}

export function rewardRowTotals(rows: readonly RewardRow[]): RewardRowTotals {
  let platinum = 0;
  let ducats = 0;
  let unpriced = 0;
  for (const row of rows) {
    platinum += row.platinum ?? 0;
    ducats += row.ducats ?? 0;
    if (row.unpriced) unpriced += 1;
  }
  return { platinum, ducats, unpriced };
}

export function missionTypeLabel(missionType: string | undefined): string | null {
  if (!missionType) return null;
  return MISSION_TYPE_LABELS[missionType] ?? titleCase(missionType.slice(3).replace(/_/g, " "));
}

export function missionName(summary: MissionRewardSummaryView, unknown: string): string {
  return summary.nodeLabel ?? missionTypeLabel(summary.missionType) ?? unknown;
}

const FAILURE_DETAIL_KEYS: Partial<Record<MissionRewardsFailure, MessageKey>> = {
  "access-denied": "titlebar.tooltip.accessDenied",
  "game-not-running": "titlebar.tooltip.gameNotRunning",
  "no-fresh-copy": "dashboard.lastMission.noFreshCopy",
};

/** Tracking off, then a read in progress, then the last failed read. */
export function missionStatusKey(status: MissionRewardsStatus | null): MessageKey | null {
  if (!status) return null;
  if (status.blocked === "tracking-off") return "dashboard.lastMission.trackingOff";
  if (status.phase !== "idle") return "dashboard.lastMission.reading";
  if (status.lastFailure) return "dashboard.lastMission.readFailed";
  return null;
}

/** The status line, with the cause of a failed read when it has a sentence. */
export function missionStatusText(
  status: MissionRewardsStatus | null,
  t: Translator,
): string | null {
  const key = missionStatusKey(status);
  if (!key) return null;
  const detail =
    key === "dashboard.lastMission.readFailed" && status?.lastFailure
      ? FAILURE_DETAIL_KEYS[status.lastFailure]
      : undefined;
  return detail ? `${t(key)} ${t(detail)}` : t(key);
}

export const MISSION_PERIODS = ["today", "7d", "30d", "all"] as const;
export type MissionPeriod = (typeof MISSION_PERIODS)[number];

const DAY_MS = 86_400_000;

/** Earliest endedAt a period covers, in local time; null for all time. */
export function missionPeriodStart(period: MissionPeriod, now: number): number | null {
  if (period === "all") return null;
  if (period === "today") {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight.getTime();
  }
  return now - (period === "7d" ? 7 : 30) * DAY_MS;
}

export function endedAtLabel(endedAt: number, code: string): string {
  return new Date(endedAt).toLocaleString(code, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A later page after the loaded rows; a mission recorded since the last request shifts
 *  the offsets, so the page can repeat rows already loaded. */
export function appendPage<T extends { id: string }>(
  loaded: readonly T[],
  next: readonly T[],
): T[] {
  const ids = new Set(loaded.map((entry) => entry.id));
  return [...loaded, ...next.filter((entry) => !ids.has(entry.id))];
}

/** Lays a fresh first page over a longer loaded list, keeping every row already loaded;
 *  starts over only when the two no longer overlap. */
export function mergeFirstPage<T extends { id: string }>(
  loaded: readonly T[],
  first: readonly T[],
  matched: number,
): T[] {
  const firstIds = new Set(first.map((entry) => entry.id));
  const overlaps = first.length >= matched || loaded.some((entry) => firstIds.has(entry.id));
  if (!overlaps) return [...first];
  const merged = [...first, ...loaded.filter((entry) => !firstIds.has(entry.id))];
  return merged.slice(0, matched);
}

export type PageLoadMode = "replace" | "append" | "merge";

interface LoadedPage<T> {
  summaries: readonly T[];
  matched: number;
}

interface PageLoaderTarget<T, P> {
  rows: () => readonly T[];
  show: (rows: T[], page: P | null) => void;
  /** `rowsOutdated`: the rows shown were loaded under an earlier filter. */
  fail: (error: unknown, rowsOutdated: boolean) => void;
}

/** Orders a paged list's loads: a filter change drops every older answer, a first page drops
 *  those older than the one shown, and rows loaded under an earlier filter are replaced,
 *  never merged into or appended to. */
export function createPageLoader<T extends { id: string }, P extends LoadedPage<T>>(
  target: PageLoaderTarget<T, P>,
): (mode: PageLoadMode, load: () => Promise<P | null>) => Promise<void> {
  let filterSeq = 0;
  let firstSent = 0;
  let firstShown = 0;
  let rowsFilter = 0;
  return async (mode, load) => {
    if (mode === "replace") filterSeq += 1;
    const filters = filterSeq;
    const first = mode === "append" ? firstSent : ++firstSent;
    const base = rowsFilter;
    const stale = (): boolean =>
      filters !== filterSeq || (mode === "append" ? base !== filters : first <= firstShown);
    try {
      const next = await load();
      if (stale()) return;
      if (!next) throw new Error("mission page query rejected");
      let rows: T[];
      if (mode === "append") {
        rows = appendPage(target.rows(), next.summaries);
      } else {
        rows =
          mode === "merge" && rowsFilter === filters
            ? mergeFirstPage(target.rows(), next.summaries, next.matched)
            : [...next.summaries];
        firstShown = first;
        rowsFilter = filters;
      }
      target.show(rows, first >= firstShown ? next : null);
    } catch (error: unknown) {
      if (stale()) return;
      target.fail(error, rowsFilter !== filters);
    }
  };
}

/** Recorded item types whose shown or English name contains the search text. */
export function matchRewardItemTypes(
  itemTypes: readonly string[],
  search: string,
  db: Record<string, ItemDbEntry>,
): string[] {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return [];
  return itemTypes.filter((uniqueName) => {
    const entry: ItemDbEntry | undefined = db[uniqueName];
    const names = [
      entry?.displayName,
      entry?.name,
      entry ? undefined : fallbackNameFromUniqueName(uniqueName),
    ];
    return names.some((name) => name?.toLocaleLowerCase().includes(needle));
  });
}
