"use strict";

/**
 * Pure math / string utility functions for reward scanning.
 * No Electron or Node dependencies — safe for unit-testing.
 */

const { clampNumber } = require("../config/shared/numeric.cjs");

function clamp01(value) {
  return clampNumber(value, 0, 1, 0);
}

function round4(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Number(n.toFixed(4));
}

function medianNumber(values, fallback) {
  if (!Array.isArray(values) || values.length === 0) return fallback;
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (nums.length === 0) return fallback;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 1) return nums[mid];
  return (nums[mid - 1] + nums[mid]) / 2;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeMeanAndStd(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { mean: 0, std: 0 };
  }

  let sum = 0;
  for (const value of values) {
    sum += value;
  }

  const mean = sum / values.length;
  let varianceSum = 0;
  for (const value of values) {
    const diff = value - mean;
    varianceSum += diff * diff;
  }

  const variance = varianceSum / values.length;
  return {
    mean,
    std: Math.sqrt(Math.max(0, variance)),
  };
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

const LUMINANCE_WEIGHTS = Object.freeze({
  red: 77,
  green: 150,
  blue: 29,
  shift: 8,
});

function luminanceFromBgr(blue, green, red) {
  return (
    (LUMINANCE_WEIGHTS.red * red +
      LUMINANCE_WEIGHTS.green * green +
      LUMINANCE_WEIGHTS.blue * blue) >>
    LUMINANCE_WEIGHTS.shift
  );
}

module.exports = {
  clampNumber,
  clamp01,
  round4,
  medianNumber,
  sleep,
  computeMeanAndStd,
  levenshteinDistance,
  luminanceFromBgr,
  LUMINANCE_WEIGHTS,
};
