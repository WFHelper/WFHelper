const { extractSellRows, extractMedianFromStatsPayload } = require("../config/shared/wfmStats.cjs") as {
  extractSellRows: (jsonPayload: unknown) => Array<Record<string, unknown>>;
  extractMedianFromStatsPayload: (jsonPayload: unknown, options?: { rank?: unknown }) => number | null;
};

export { extractMedianFromStatsPayload };

export const __test__ = {
  extractRows: extractSellRows,
  extractMedianFromStatsPayload,
};
