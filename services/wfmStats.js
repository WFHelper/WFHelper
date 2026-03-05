"use strict";

const { extractSellRows, extractMedianFromStatsPayload } = require("../config/shared/wfmStats.cjs");

module.exports = {
  extractMedianFromStatsPayload,
  __test__: {
    extractRows: extractSellRows,
    extractMedianFromStatsPayload,
  },
};
