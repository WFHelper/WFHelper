import { normalizeRank, toFiniteNumber } from "./numeric";
import { asRecord } from "./objectValidation";

export const WFM_PRICE_BASIS = "closed-volume-average-48h-v1";
const WINDOW_MS = 48 * 60 * 60 * 1000;
// WFM records a close at whatever price the closed order carried, so one fake close can
// be the whole 48h window. Measured 2026-09-24: 3 of 3213 snapshot prices exceeded 10x
// their lowest ask, and the highest bid covered the one that was not a fake close.
const PRICE_OUTLIER_FACTOR = 10;

export function isPriceOutlier(price: number, reference: number | null | undefined): boolean {
  return reference != null && reference > 0 && price > reference * PRICE_OUTLIER_FACTOR;
}

/** The row's rank when it belongs to the asked pool, undefined when it does not. */
function pooledRank(row: Record<string, unknown>, rank: number | null): number | null | undefined {
  const rawRank = row.mod_rank ?? row.rank;
  const rowRank = normalizeRank(rawRank);
  if (rawRank != null && (toFiniteNumber(rawRank) == null || rowRank == null)) return undefined;
  if (rank != null ? rowRank !== rank : rowRank != null && rowRank !== 0) return undefined;
  return rowRank;
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pooledMedians(
  rows: unknown,
  rank: number | null,
  keep: (row: Record<string, unknown>) => boolean,
): number[] {
  if (!Array.isArray(rows)) return [];
  const medians: number[] = [];
  for (const value of rows) {
    const row = asRecord(value);
    if (!row || !keep(row) || pooledRank(row, rank) === undefined) continue;
    const median = toFiniteNumber(row.median);
    if (median != null && median > 0) medians.push(median);
  }
  return medians;
}

/** What an honest trade of this rank fetches: the live sell book, or without one the
 *  rank's closed history before the window. */
function referencePrice(
  payload: Record<string, unknown> | null,
  rank: number | null,
  windowStart: number,
): number | null {
  const live = asRecord(payload?.statistics_live);
  const book = pooledMedians(
    live?.["48hours"] ?? live?.["48_hours"],
    rank,
    (row) => row.order_type === "sell",
  );
  if (book.length > 0) return medianOf(book);
  const closed = asRecord(payload?.statistics_closed);
  const history = pooledMedians(closed?.["90days"], rank, (row) => {
    const time = typeof row.datetime === "string" ? Date.parse(row.datetime) : NaN;
    return (row.order_type == null || row.order_type === "sell") && time < windowStart;
  });
  return medianOf(history);
}

export function extractAverageFromStatsPayload(
  jsonPayload: unknown,
  options?: { rank?: unknown; now?: number },
): { average: number; timestamp: number; volume: number } | null {
  const payload = asRecord(asRecord(jsonPayload)?.payload);
  const closed = asRecord(payload?.statistics_closed);
  const rows = closed?.["48hours"] ?? closed?.["48_hours"];
  if (!Array.isArray(rows)) return null;
  const rank = normalizeRank(options?.rank);
  if (options?.rank != null && rank == null) return null;
  const now = options?.now ?? Date.now();
  const samples = new Map<string, { price: number; volume: number; time: number }>();
  for (const value of rows) {
    const row = asRecord(value);
    if (!row || (row.order_type != null && row.order_type !== "sell")) continue;
    const rowRank = pooledRank(row, rank);
    if (rowRank === undefined) continue;
    const time = typeof row.datetime === "string" ? Date.parse(row.datetime) : NaN;
    const price = toFiniteNumber(row.wa_price);
    const volume = toFiniteNumber(row.volume);
    if (
      !Number.isFinite(time) ||
      time < now - WINDOW_MS ||
      time > now ||
      price == null ||
      price <= 0 ||
      volume == null ||
      volume <= 0
    )
      continue;
    samples.set(`${time}:${rowRank ?? "none"}`, { price, volume, time });
  }
  const reference = samples.size > 0 ? referencePrice(payload, rank, now - WINDOW_MS) : null;
  let total = 0;
  let volume = 0;
  let timestamp = 0;
  for (const sample of samples.values()) {
    if (isPriceOutlier(sample.price, reference)) continue;
    // wa_price already weights the trades inside each bucket by quantity.
    total += sample.price * sample.volume;
    volume += sample.volume;
    timestamp = Math.max(timestamp, sample.time);
  }
  const average = Math.round(total / volume);
  return volume > 0 && Number.isFinite(average) && average > 0
    ? { average, timestamp, volume }
    : null;
}
