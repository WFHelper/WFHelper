import {
  AYATAN_SCULPTURES,
  ayatanEndoRatio,
  ayatanSculptureEndo,
  ayatanStarsOf,
  ayatanWhisperStars,
  type AyatanSculpture,
  type AyatanStars,
} from "../../../config/shared/ayatanEndo.js";
import type { SortDirection } from "../../types/filters.js";
import type { Translator } from "../i18n.js";
import { readStoredJson, writeStorage } from "../persistence.js";
import type { OrderBookEntry } from "./orderBook.js";
import { matchesSellerStatus, orderWhisper, type SellerStatusFilter } from "./orderRows.js";

interface AyatanEndoInfo {
  stars: AyatanStars;
  sockets: number;
  endo: number;
  ratio: number;
  endoPerPlat: number;
}

/** Null for a listing whose price has no ratio. */
export function ayatanEndoInfo(
  sculpture: AyatanSculpture,
  entry: OrderBookEntry,
): AyatanEndoInfo | null {
  const stars = ayatanStarsOf(sculpture, entry);
  const endo = ayatanSculptureEndo(sculpture, stars);
  const ratio = ayatanEndoRatio(endo, entry.platinum, entry.perTrade);
  if (ratio === null) return null;
  return {
    stars,
    sockets: sculpture.maxAmberStars + sculpture.maxCyanStars,
    endo,
    ratio,
    endoPerPlat: Math.round(ratio),
  };
}

/** A sculpture's name carries the stars the order states, worded like warframe.market's
 *  clipboard text (app.order.clipboard.stars); the rest is the app's usual whisper. */
export function ayatanOrderWhisper(
  t: Translator,
  side: "sell" | "buy",
  entry: OrderBookEntry,
  itemName: string,
  sculpture: AyatanSculpture | null,
): string {
  const stars = sculpture ? ayatanWhisperStars(entry) : "";
  return orderWhisper(t, side, entry, stars ? `${itemName} ${stars}` : itemName);
}

export interface AyatanListing extends AyatanEndoInfo {
  slug: string;
  entry: OrderBookEntry;
}

export type AyatanStarsFilter = "any" | "full" | "none";
export type AyatanSortKey = "sculpture" | "qty" | "user" | "status" | "unitPrice" | "endoPerPlat";

interface AyatanListingFilter {
  status: SellerStatusFilter;
  minEndoPerPlat: number | null;
  /** Slugs to keep; empty keeps every sculpture. */
  sculptures: readonly string[];
  stars: AyatanStarsFilter;
}

interface AyatanSort {
  sortBy: AyatanSortKey;
  sortDirection: SortDirection;
}

function matchesStars(filter: AyatanStarsFilter, info: AyatanEndoInfo): boolean {
  if (filter === "any") return true;
  const filled = info.stars.amber + info.stars.cyan;
  return filter === "none" ? filled === 0 : filled === info.sockets;
}

function bestEndoFirst(a: AyatanListing, b: AyatanListing): number {
  return (
    b.ratio - a.ratio ||
    a.entry.unitPlatinum - b.entry.unitPlatinum ||
    b.entry.quantity - a.entry.quantity ||
    a.entry.userName.localeCompare(b.entry.userName) ||
    a.slug.localeCompare(b.slug)
  );
}

/** Sell orders of every loaded sculpture that pass the filter, in book order;
 *  sortAyatanListings orders them. The minimum compares the rounded figure the
 *  table shows. */
export function buildAyatanListings(
  books: ReadonlyArray<{ sculpture: AyatanSculpture; sell: readonly OrderBookEntry[] }>,
  filter: AyatanListingFilter,
): AyatanListing[] {
  const min =
    filter.minEndoPerPlat != null && filter.minEndoPerPlat > 0 ? filter.minEndoPerPlat : 0;
  const only = filter.sculptures.length > 0 ? new Set(filter.sculptures) : null;
  const out: AyatanListing[] = [];
  for (const { sculpture, sell } of books) {
    if (only && !only.has(sculpture.slug)) continue;
    for (const entry of sell) {
      if (!matchesSellerStatus(entry.status, filter.status)) continue;
      const info = ayatanEndoInfo(sculpture, entry);
      if (!info || info.endoPerPlat < min || !matchesStars(filter.stars, info)) continue;
      out.push({ slug: sculpture.slug, entry, ...info });
    }
  }
  return out;
}

/** Direction a column header starts at: endo and stock read most first, the rest
 *  (name, seller, in game before online, cheapest) ascending. */
export function ayatanSortStart(sortBy: AyatanSortKey): SortDirection {
  return sortBy === "endoPerPlat" || sortBy === "qty" ? "desc" : "asc";
}

function statusRank(status: string | null): number {
  if (status === "ingame") return 0;
  if (status === "online") return 1;
  return 2;
}

/** Ties fall back to the default endo order, so a re-sort never shuffles equal rows. */
export function sortAyatanListings(
  listings: readonly AyatanListing[],
  sort: AyatanSort,
  labelOf: (slug: string) => string,
): AyatanListing[] {
  const labels = new Map<string, string>();
  const label = (slug: string): string => {
    let text = labels.get(slug);
    if (text === undefined) {
      text = labelOf(slug);
      labels.set(slug, text);
    }
    return text;
  };
  const compare = (a: AyatanListing, b: AyatanListing): number => {
    switch (sort.sortBy) {
      case "sculpture":
        return label(a.slug).localeCompare(label(b.slug));
      case "qty":
        return a.entry.quantity - b.entry.quantity;
      case "user":
        return a.entry.userName.localeCompare(b.entry.userName, undefined, {
          sensitivity: "base",
        });
      case "status":
        return statusRank(a.entry.status) - statusRank(b.entry.status);
      case "unitPrice":
        return a.entry.unitPlatinum - b.entry.unitPlatinum;
      case "endoPerPlat":
        return a.ratio - b.ratio;
    }
  };
  const sign = sort.sortDirection === "asc" ? 1 : -1;
  return [...listings].sort((a, b) => sign * compare(a, b) || bestEndoFirst(a, b));
}

/** One sculpture's order book as the view keeps it across refreshes. */
export interface AyatanBookState {
  /** Latest finished fetch; null until the first one finishes. */
  result: "ok" | "not_found" | "error" | null;
  loading: boolean;
  /** Last good sell side, kept while a refresh is pending or failed. */
  sell: readonly OrderBookEntry[];
  /** When `sell` was fetched; null until a fetch succeeds. */
  loadedAt: number | null;
}

export const EMPTY_AYATAN_BOOK: AyatanBookState = {
  result: null,
  loading: false,
  sell: [],
  loadedAt: null,
};

type AyatanFetchResult =
  | { status: "ok"; data: { sell: OrderBookEntry[]; timestamp: number } }
  | { status: "not_found" | "error" };

export function settleAyatanBook(
  previous: AyatanBookState,
  fetched: AyatanFetchResult | undefined,
): AyatanBookState {
  if (fetched?.status === "ok") {
    return {
      result: "ok",
      loading: false,
      sell: fetched.data.sell,
      loadedAt: fetched.data.timestamp,
    };
  }
  if (fetched?.status === "not_found") return { ...EMPTY_AYATAN_BOOK, result: "not_found" };
  return { ...previous, result: "error", loading: false };
}

interface AyatanLoadNotice {
  key: "browse.ayatan.failed" | "browse.ayatan.refreshFailed" | "browse.ayatan.partlyStale";
  count: number;
  total: number;
  /** Oldest fetch among the failed sculptures still showing orders. */
  since: number | null;
}

interface AyatanLoadSummary {
  pending: number;
  failed: number;
  /** Some sculpture has a good book to show, even an empty one. */
  hasData: boolean;
  /** Oldest good fetch still on screen, so nothing shown is older. */
  updatedAt: number | null;
  /** Null while nothing is on screen: the empty state reports that failure. */
  notice: AyatanLoadNotice | null;
}

/** A book counts by its latest finished fetch, so a refresh in progress keeps
 *  reporting the last failures until each sculpture answers again. */
export function summarizeAyatanBooks(books: readonly AyatanBookState[]): AyatanLoadSummary {
  let pending = 0;
  let failed = 0;
  let updatedAt: number | null = null;
  let since: number | null = null;
  for (const book of books) {
    if (book.loading) pending += 1;
    if (book.loadedAt != null) updatedAt = Math.min(updatedAt ?? Infinity, book.loadedAt);
    if (book.result !== "error") continue;
    failed += 1;
    if (book.loadedAt != null) since = Math.min(since ?? Infinity, book.loadedAt);
  }
  const hasData = updatedAt != null;
  const total = books.length;
  let notice: AyatanLoadNotice | null = null;
  if (failed > 0 && hasData) {
    const key =
      since == null
        ? "browse.ayatan.failed"
        : failed === total
          ? "browse.ayatan.refreshFailed"
          : "browse.ayatan.partlyStale";
    notice = { key, count: failed, total, since };
  }
  return { pending, failed, hasData, updatedAt, notice };
}

/** How long ago a fetch was, worded by the locale, e.g. "12 sec. ago". */
export function formatLoadAge(loadedAt: number, now: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" });
  const seconds = Math.max(0, Math.floor((now - loadedAt) / 1000));
  if (seconds < 60) return format.format(-seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return format.format(-minutes, "minute");
  return format.format(-Math.floor(minutes / 60), "hour");
}

export interface AyatanViewPrefs extends AyatanListingFilter, AyatanSort {}

const PREFS_KEY = "wf_market_ayatan_view";
const SORT_KEYS: readonly AyatanSortKey[] = [
  "sculpture",
  "qty",
  "user",
  "status",
  "unitPrice",
  "endoPerPlat",
];
const DIRECTIONS: readonly SortDirection[] = ["asc", "desc"];
const STATUS_FILTERS: readonly SellerStatusFilter[] = ["ingame", "onsite", "all"];
const STARS_FILTERS: readonly AyatanStarsFilter[] = ["any", "full", "none"];

function defaultAyatanViewPrefs(): AyatanViewPrefs {
  return {
    sortBy: "endoPerPlat",
    sortDirection: "desc",
    status: "ingame",
    minEndoPerPlat: null,
    sculptures: [],
    stars: "any",
  };
}

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return (allowed as readonly unknown[]).includes(value);
}

/** Any field that is missing or no longer valid takes its default on its own. */
function normalizeAyatanViewPrefs(parsed: unknown): AyatanViewPrefs {
  const fallback = defaultAyatanViewPrefs();
  if (!parsed || typeof parsed !== "object") return fallback;
  const saved = parsed as Record<string, unknown>;
  const { sculptures, minEndoPerPlat } = saved;
  return {
    sortBy: isOneOf(SORT_KEYS, saved.sortBy) ? saved.sortBy : fallback.sortBy,
    sortDirection: isOneOf(DIRECTIONS, saved.sortDirection)
      ? saved.sortDirection
      : fallback.sortDirection,
    status: isOneOf(STATUS_FILTERS, saved.status) ? saved.status : fallback.status,
    minEndoPerPlat:
      typeof minEndoPerPlat === "number" && Number.isFinite(minEndoPerPlat) && minEndoPerPlat > 0
        ? minEndoPerPlat
        : null,
    sculptures: Array.isArray(sculptures)
      ? AYATAN_SCULPTURES.map(({ slug }) => slug).filter((slug) => sculptures.includes(slug))
      : [],
    stars: isOneOf(STARS_FILTERS, saved.stars) ? saved.stars : fallback.stars,
  };
}

export function loadAyatanViewPrefs(): AyatanViewPrefs {
  return readStoredJson(PREFS_KEY, normalizeAyatanViewPrefs, defaultAyatanViewPrefs);
}

export function saveAyatanViewPrefs(prefs: AyatanViewPrefs): void {
  writeStorage(PREFS_KEY, JSON.stringify(prefs));
}
