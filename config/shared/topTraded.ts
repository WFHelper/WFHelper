/** Wire shape of the worker's published top-traded doc (worker writer + renderer reader). */

/** The worker publishes at most this many rows, so a longer doc is not one of ours. */
export const TOP_TRADED_MAX_ITEMS = 100;
const MAX_NAME_LENGTH = 120;
const MAX_THUMB_LENGTH = 300;

export interface TopTradedItem {
  slug: string;
  name: string;
  volume: number;
  median: number;
  value: number;
  /** Absent, never empty: the worker omits the key when the catalog carries no art. */
  thumb?: string;
}

export interface TopTradedDoc {
  generatedAt: number;
  windowDays: number;
  items: TopTradedItem[];
  /** The same slugs ordered by total value; the reader joins them back onto `items`. */
  byValue: string[];
}

export function topTradedName(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_NAME_LENGTH) : "";
}

/** Spread into an item so a missing or empty thumb stays off the wire. */
export function topTradedThumb(value: unknown): { thumb?: string } {
  return typeof value === "string" && value ? { thumb: value.slice(0, MAX_THUMB_LENGTH) } : {};
}
