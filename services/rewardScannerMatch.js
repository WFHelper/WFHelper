"use strict";

/**
 * OCR text → item matching helpers for reward scanning.
 * All functions are pure (except `matchItemsDetailed` which reads a `sortedItems` array parameter).
 */

const { levenshteinDistance } = require("./rewardScannerUtils");

const MAX_REWARD_SLOTS = 4;
const EXACT_MATCH_SKIP_OVERLAP_COUNT = 3;
const MIN_MATCHED_WORDS_FOR_OVERLAP = 2;
const OVERLAP_CONFIDENCE_FLOOR = 0.86;

const RELIC_ERA_TOKENS = Object.freeze([
  { token: "lith", text: "LITH" },
  { token: "meso", text: "MESO" },
  { token: "neo", text: "NEO" },
  { token: "axi", text: "AXI" },
  { token: "requiem", text: "REQUIEM" },
]);

const CONSENSUS_TUNING = Object.freeze({
  minScoreWeight: 0.1,
  minConfidenceWeight: 0.1,
  confidenceDecimals: 3,
});

function normalizeOcrToken(token) {
  return String(token || "")
    .toUpperCase()
    .replace(/[1|!]/g, "I")
    .replace(/0/g, "O")
    .replace(/5/g, "S")
    .replace(/[^A-Z]/g, "")
    .trim();
}

function norm(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildWordSet(text) {
  return new Set(
    text
      .split(" ")
      .map((w) => w.trim())
      .filter((w) => w.length > 2),
  );
}

function matchItemsDetailed(ocrText, threshold, sortedItems) {
  const text = norm(ocrText);
  if (!text) {
    return { items: [], score: 0, matches: [], exactCount: 0 };
  }

  const words = buildWordSet(text);
  const found = [];
  const usedNames = new Set();
  const overlapThreshold = Math.max(Number(threshold) || 0, OVERLAP_CONFIDENCE_FLOOR);

  for (const item of sortedItems) {
    if (found.length >= MAX_REWARD_SLOTS) break;
    const normalizedName = norm(item.name);
    if (!normalizedName || usedNames.has(normalizedName)) continue;

    const idx = text.indexOf(normalizedName);
    if (idx >= 0) {
      found.push({ item, pos: idx, confidence: 1, mode: "exact" });
      usedNames.add(normalizedName);
    }
  }

  const exactCount = found.length;
  const shouldRunOverlapPass =
    exactCount < EXACT_MATCH_SKIP_OVERLAP_COUNT && found.length < MAX_REWARD_SLOTS;

  if (shouldRunOverlapPass) {
    for (const item of sortedItems) {
      if (found.length >= MAX_REWARD_SLOTS) break;
      const normalizedName = norm(item.name);
      if (!normalizedName || usedNames.has(normalizedName)) continue;

      const itemWords = normalizedName.split(" ").filter((w) => w.length > 2);
      if (itemWords.length === 0) continue;

      const matchedWords = itemWords.filter((w) => words.has(w)).length;
      if (matchedWords < MIN_MATCHED_WORDS_FOR_OVERLAP) continue;

      const ratio = matchedWords / itemWords.length;
      if (ratio < overlapThreshold) continue;

      const firstWord = itemWords.find((w) => words.has(w)) || "";
      const pos = firstWord ? text.indexOf(firstWord) : text.length;

      found.push({ item, pos, confidence: ratio, mode: "overlap" });
      usedNames.add(normalizedName);
    }
  }

  found.sort((a, b) => a.pos - b.pos);

  const exactMatches = found.filter((m) => m.mode === "exact").length;
  const confidenceSum = found.reduce((sum, m) => sum + m.confidence, 0);
  const coverageBoost = Math.min(MAX_REWARD_SLOTS, found.length) * 0.6;
  const exactBoost = exactMatches * 0.35;

  return {
    items: found.map((m) => ({ ...m.item, confidence: Number(m.confidence.toFixed(3)) })),
    score: confidenceSum + coverageBoost + exactBoost,
    matches: found,
    exactCount,
  };
}

function chooseBetterOcrPass(currentBest, candidate) {
  if (!candidate) return currentBest;
  if (!currentBest) return candidate;

  const currentItemCount = Array.isArray(currentBest.items) ? currentBest.items.length : 0;
  const candidateItemCount = Array.isArray(candidate.items) ? candidate.items.length : 0;
  if (candidateItemCount !== currentItemCount) {
    return candidateItemCount > currentItemCount ? candidate : currentBest;
  }

  const currentExact = Number(currentBest.exactCount || 0);
  const candidateExact = Number(candidate.exactCount || 0);
  if (candidateExact !== currentExact) {
    return candidateExact > currentExact ? candidate : currentBest;
  }

  return Number(candidate.score || 0) > Number(currentBest.score || 0) ? candidate : currentBest;
}

function detectRelicEraFromText(text) {
  const normalized = String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return { era: null, confidence: 0 };
  }

  const words = normalized
    .split(" ")
    .map((word) => normalizeOcrToken(word))
    .filter((word) => word.length >= 2);

  let best = { era: null, confidence: 0 };

  for (const word of words) {
    for (const era of RELIC_ERA_TOKENS) {
      const target = era.text;
      if (word === target) {
        return { era: era.token, confidence: 1 };
      }

      if (word.length >= 3 && (target.startsWith(word) || word.startsWith(target))) {
        best = best.confidence < 0.82 ? { era: era.token, confidence: 0.82 } : best;
      }

      if (word.length >= 3) {
        const distance = levenshteinDistance(word, target);
        if (distance <= 1) {
          best = best.confidence < 0.76 ? { era: era.token, confidence: 0.76 } : best;
        }
      }
    }
  }

  return best;
}

function detectRelicEraFromTileLabelText(text) {
  const normalized = String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return { era: null, confidence: 0 };
  }

  const base = detectRelicEraFromText(normalized);
  if (!base.era || base.confidence <= 0) {
    return base;
  }

  let confidence = base.confidence;
  const startsWithEra =
    normalized.startsWith("LITH ") ||
    normalized.startsWith("MESO ") ||
    normalized.startsWith("NEO ") ||
    normalized.startsWith("AXI ") ||
    normalized.startsWith("REQUIEM ");
  if (startsWithEra) {
    confidence += 0.08;
  }

  if (normalized.includes(" RELIC")) {
    confidence += 0.06;
  }

  return {
    era: base.era,
    confidence: Math.min(1, confidence),
  };
}

function buildConsensusSelection(passResults) {
  const { medianNumber } = require("./rewardScannerUtils");

  const successful = passResults.filter((result) => result.items.length > 0);
  if (successful.length === 0) return null;

  if (successful.length === 1) {
    return {
      items: successful[0].items.slice(0, MAX_REWARD_SLOTS),
      selectedPass: successful[0],
      strategy: "single-pass",
      targetCount: successful[0].items.length,
    };
  }

  const estimatedCount = Math.max(
    1,
    Math.min(
      MAX_REWARD_SLOTS,
      Math.round(
        medianNumber(
          successful.map((result) => result.items.length),
          successful[0].items.length,
        ),
      ),
    ),
  );

  const votes = new Map();

  for (const result of successful) {
    const scoreWeight = Math.max(CONSENSUS_TUNING.minScoreWeight, result.score);
    for (const match of result.matches) {
      const key = match.item.name;
      const existing = votes.get(key) || {
        item: match.item,
        hits: 0,
        weightedScore: 0,
        bestConfidence: 0,
        avgPosAccumulator: 0,
        avgPosCount: 0,
      };

      existing.hits += 1;
      existing.weightedScore +=
        scoreWeight * Math.max(CONSENSUS_TUNING.minConfidenceWeight, Number(match.confidence) || 0);
      existing.bestConfidence = Math.max(existing.bestConfidence, Number(match.confidence) || 0);

      if (Number.isFinite(match.pos) && match.pos >= 0) {
        existing.avgPosAccumulator += match.pos;
        existing.avgPosCount += 1;
      }

      votes.set(key, existing);
    }
  }

  const ranked = [...votes.values()].sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    if (b.weightedScore !== a.weightedScore) return b.weightedScore - a.weightedScore;
    if (b.bestConfidence !== a.bestConfidence) return b.bestConfidence - a.bestConfidence;
    return a.item.name.localeCompare(b.item.name);
  });

  const selectedWithPos = ranked
    .slice(0, estimatedCount)
    .map((entry) => {
      const avgPos =
        entry.avgPosCount > 0
          ? entry.avgPosAccumulator / entry.avgPosCount
          : Number.MAX_SAFE_INTEGER;
      return {
        avgPos,
        item: {
          ...entry.item,
          confidence: Number(entry.bestConfidence.toFixed(CONSENSUS_TUNING.confidenceDecimals)),
        },
      };
    })
    .sort((a, b) => a.avgPos - b.avgPos);

  const chosenItems = selectedWithPos.map((entry) => entry.item);

  const selectedPass = [...successful].sort((a, b) => {
    const aDelta = Math.abs(a.items.length - estimatedCount);
    const bDelta = Math.abs(b.items.length - estimatedCount);
    if (aDelta !== bDelta) return aDelta - bDelta;
    return b.score - a.score;
  })[0];

  return {
    items: chosenItems,
    selectedPass,
    strategy: "consensus",
    targetCount: estimatedCount,
  };
}

module.exports = {
  normalizeOcrToken,
  norm,
  buildWordSet,
  matchItemsDetailed,
  chooseBetterOcrPass,
  detectRelicEraFromText,
  detectRelicEraFromTileLabelText,
  buildConsensusSelection,
  MAX_REWARD_SLOTS,
  RELIC_ERA_TOKENS,
  CONSENSUS_TUNING,
};
