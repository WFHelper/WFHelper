import { dropStaleMarketData, type WorkbenchQueueRow } from "./queueModel.js";

/** Order-book freshness, matching ORDERBOOK_TTL_MS in src/lib/wfm/orderBook.ts:
 *  the queue never carries a book the renderer itself calls stale, and a reopen
 *  inside the window re-fetches straight from that cache anyway. */
export const QUEUE_MARKET_TTL_MS = 45_000;

// Process-lifetime only, never persisted: the rows hold live ParsedItem
// references and a fetched order book that would be stale on the next launch.
let cachedRows: readonly WorkbenchQueueRow[] = [];
// The book ages from its fetch, not from the last row edit: editing quantities
// for an hour must not keep a stale book "fresh".
let marketFetchedAt = 0;

/** Queue rows the Bulk Sell modal left behind, for the next open to merge.
 *  Past the TTL the market data is dropped, so Execute cannot go out on an
 *  order book nobody looked at for hours. */
export function readCachedQueueRows(now: number = Date.now()): readonly WorkbenchQueueRow[] {
  if (cachedRows.length === 0) return cachedRows;
  if (now - marketFetchedAt <= QUEUE_MARKET_TTL_MS) return cachedRows;
  if (!cachedRows.some((row) => row.sellBook || row.suggestion || row.market)) return cachedRows;
  return dropStaleMarketData(cachedRows);
}

export function writeCachedQueueRows(rows: readonly WorkbenchQueueRow[]): void {
  cachedRows = rows;
}

/** Called when an order book was just attached to the rows. */
export function markQueueMarketFetched(now: number = Date.now()): void {
  marketFetchedAt = now;
}
