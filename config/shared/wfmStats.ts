import { normalizeRank } from "./numeric";

const SELL_ORDER_TYPE = "sell";
const STATS_WINDOW_KEYS: readonly string[] = Object.freeze(["48hours", "48_hours"]);
const MEDIAN_CANDIDATE_FIELDS: readonly string[] = Object.freeze([
  "median",
  "moving_avg",
  "wa_price",
  "avg_price",
  "min_price",
]);

function pickStatsWindowRows(statsSection: unknown): Array<Record<string, unknown>> {
  if (!statsSection || typeof statsSection !== "object") return [];
  const section = statsSection as Record<string, unknown>;
  for (const key of STATS_WINDOW_KEYS) {
    const rows = section[key];
    if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>;
  }
  return [];
}

function extractSellRows(jsonPayload: unknown): Array<Record<string, unknown>> {
  const payload =
    jsonPayload && typeof jsonPayload === "object"
      ? (jsonPayload as Record<string, unknown>).payload
      : null;
  if (!payload || typeof payload !== "object") return [];

  const payloadRecord = payload as Record<string, unknown>;

  const closedRows = pickStatsWindowRows(payloadRecord.statistics_closed || {});
  const liveRows = pickStatsWindowRows(payloadRecord.statistics_live || {});

  return [...closedRows, ...liveRows]
    .filter((entry) => !entry.order_type || entry.order_type === SELL_ORDER_TYPE)
    .sort(
      (a, b) =>
        new Date(String(a.datetime || 0)).getTime() - new Date(String(b.datetime || 0)).getTime(),
    );
}

function resolveTargetRank(options: unknown): number | null {
  if (!options || typeof options !== "object") return null;
  const record = options as { rank?: unknown };
  const rank = normalizeRank(record.rank);
  return rank;
}

export function extractMedianFromStatsPayload(
  jsonPayload: unknown,
  options?: { rank?: unknown },
): number | null {
  return extractLatestMedianFromStatsPayload(jsonPayload, options)?.median ?? null;
}

export function extractLatestMedianFromStatsPayload(
  jsonPayload: unknown,
  options?: { rank?: unknown },
): { median: number; timestamp: number | null } | null {
  const targetRank = resolveTargetRank(options);
  const rows = extractSellRows(jsonPayload).filter((entry) => {
    if (targetRank == null) return true;
    const rowRank = normalizeRank(entry.mod_rank ?? entry.rank);
    return rowRank === targetRank;
  });
  const latest = rows.length > 0 ? rows[rows.length - 1] : null;
  if (!latest || typeof latest !== "object") return null;

  let raw: unknown = null;
  for (const field of MEDIAN_CANDIDATE_FIELDS) {
    if (latest[field] != null) {
      raw = latest[field];
      break;
    }
  }

  if (raw == null) return null;
  const value = Math.round(Math.abs(Number(raw)));
  if (!Number.isFinite(value) || value <= 0) return null;

  const sourceTime = new Date(String(latest.datetime || 0)).getTime();
  return {
    median: value,
    timestamp: Number.isFinite(sourceTime) && sourceTime > 0 ? sourceTime : null,
  };
}

const __test__ = {
  SELL_ORDER_TYPE,
  STATS_WINDOW_KEYS,
  MEDIAN_CANDIDATE_FIELDS,
  pickStatsWindowRows,
  normalizeRankValue: normalizeRank,
  resolveTargetRank,
};
