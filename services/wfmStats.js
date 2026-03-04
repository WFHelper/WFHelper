"use strict";

function extractRows(jsonPayload) {
  const payload = jsonPayload?.payload;
  if (!payload || typeof payload !== "object") return [];

  const closed = payload.statistics_closed || {};
  const live = payload.statistics_live || {};

  const closedRows = closed["48hours"] || closed["48_hours"] || [];
  const liveRows = live["48hours"] || live["48_hours"] || [];

  const rows = [...closedRows, ...liveRows]
    .filter((entry) => !entry.order_type || entry.order_type === "sell")
    .sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());

  return rows;
}

function extractMedianFromStatsPayload(jsonPayload) {
  const latest = extractRows(jsonPayload).at(-1);
  if (!latest || typeof latest !== "object") return null;

  const raw =
    latest.median ?? latest.moving_avg ?? latest.wa_price ?? latest.avg_price ?? latest.min_price;

  if (raw == null) return null;

  const value = Math.round(Math.abs(Number(raw)));
  return Number.isFinite(value) && value > 0 ? value : null;
}

module.exports = {
  extractMedianFromStatsPayload,
  __test__: {
    extractRows,
    extractMedianFromStatsPayload,
  },
};
