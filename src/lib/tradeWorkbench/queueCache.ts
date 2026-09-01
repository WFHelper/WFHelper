import type { WorkbenchQueueRow } from "./queueModel.js";

// Process-lifetime only, never persisted: the rows hold live ParsedItem
// references and a fetched order book that would be stale on the next launch.
let cachedRows: readonly WorkbenchQueueRow[] = [];

/** Queue rows the Bulk Sell modal left behind, for the next open to merge. */
export function readCachedQueueRows(): readonly WorkbenchQueueRow[] {
  return cachedRows;
}

export function writeCachedQueueRows(rows: readonly WorkbenchQueueRow[]): void {
  cachedRows = rows;
}
