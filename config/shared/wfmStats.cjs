"use strict";

const SELL_ORDER_TYPE = "sell";
const STATS_WINDOW_KEYS = Object.freeze(["48hours", "48_hours"]);
const MEDIAN_CANDIDATE_FIELDS = Object.freeze([
  "median",
  "moving_avg",
  "wa_price",
  "avg_price",
  "min_price",
]);

/**
 * @param {unknown} statsSection
 * @returns {Array<Record<string, unknown>>}
 */
function pickStatsWindowRows(statsSection) {
  if (!statsSection || typeof statsSection !== "object") return [];
  const section = /** @type {Record<string, unknown>} */ (statsSection);
  for (const key of STATS_WINDOW_KEYS) {
    const rows = section[key];
    if (Array.isArray(rows)) return /** @type {Array<Record<string, unknown>>} */ (rows);
  }
  return [];
}

/**
 * @param {unknown} jsonPayload
 * @returns {Array<Record<string, unknown>>}
 */
function extractSellRows(jsonPayload) {
  const payload =
    jsonPayload && typeof jsonPayload === "object"
      ? /** @type {Record<string, unknown>} */ (jsonPayload).payload
      : null;
  if (!payload || typeof payload !== "object") return [];

  const payloadRecord = /** @type {Record<string, unknown>} */ (payload);

  const closedRows = pickStatsWindowRows(payloadRecord.statistics_closed || {});
  const liveRows = pickStatsWindowRows(payloadRecord.statistics_live || {});

  return [...closedRows, ...liveRows]
    .filter((entry) => !entry.order_type || entry.order_type === SELL_ORDER_TYPE)
    .sort(
      (a, b) =>
        new Date(String(a.datetime || 0)).getTime() - new Date(String(b.datetime || 0)).getTime(),
    );
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeRankValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

/**
 * @param {unknown} options
 * @returns {number|null}
 */
function resolveTargetRank(options) {
  if (!options || typeof options !== "object") return null;
  const record = /** @type {{ rank?: unknown }} */ (options);
  const rank = normalizeRankValue(record.rank);
  return rank;
}

/**
 * @param {unknown} jsonPayload
 * @param {{ rank?: unknown }} [options]
 */
function extractMedianFromStatsPayload(jsonPayload, options) {
  const targetRank = resolveTargetRank(options);
  const rows = extractSellRows(jsonPayload).filter((entry) => {
    if (targetRank == null) return true;
    const rowRank = normalizeRankValue(entry.mod_rank ?? entry.rank);
    return rowRank === targetRank;
  });
  const latest = rows.length > 0 ? rows[rows.length - 1] : null;
  if (!latest || typeof latest !== "object") return null;

  let raw = null;
  for (const field of MEDIAN_CANDIDATE_FIELDS) {
    if (latest[field] != null) {
      raw = latest[field];
      break;
    }
  }

  if (raw == null) return null;
  const value = Math.round(Math.abs(Number(raw)));
  return Number.isFinite(value) && value > 0 ? value : null;
}

module.exports = {
  extractSellRows,
  extractMedianFromStatsPayload,
  __test__: {
    SELL_ORDER_TYPE,
    STATS_WINDOW_KEYS,
    MEDIAN_CANDIDATE_FIELDS,
    pickStatsWindowRows,
    normalizeRankValue,
    resolveTargetRank,
  },
};
