"use strict";

const log = require("./logger").withScope("wfmStatsPrice");
const { extractMedianFromStatsPayload } = require("./wfmStats");

const STATS_TTL_MS = 5 * 60 * 1000;
const STATS_TIMEOUT_MS = 7_000;

const WFM_HEADERS = Object.freeze({
  Platform: "pc",
  Language: "en",
  Crossplay: "true",
  Accept: "application/json",
});

const cache = new Map();
const inFlight = new Map();

function normalizeSlug(slug) {
  if (typeof slug !== "string") return "";
  return slug.trim().toLowerCase();
}

function getCachedPrice(slug) {
  const hit = cache.get(slug);
  if (!hit) return null;
  if (Date.now() - hit.ts > STATS_TTL_MS) {
    cache.delete(slug);
    return null;
  }
  return hit.median;
}

function setCachedPrice(slug, median) {
  cache.set(slug, {
    median,
    ts: Date.now(),
  });
}

async function fetchPriceBySlug(slugInput) {
  const slug = normalizeSlug(slugInput);
  if (!slug) return null;

  const cached = getCachedPrice(slug);
  if (cached != null) return cached;

  const pending = inFlight.get(slug);
  if (pending) return pending;

  const task = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), STATS_TIMEOUT_MS);

    try {
      const response = await fetch(`https://api.warframe.market/v1/items/${slug}/statistics`, {
        headers: WFM_HEADERS,
        signal: controller.signal,
      });

      if (!response.ok) return null;

      const payload = await response.json();
      const median = extractMedianFromStatsPayload(payload);
      if (median == null) return null;

      setCachedPrice(slug, median);
      return median;
    } catch (err) {
      log.warn(`[WFM] stats fetch failed for ${slug}:`, err?.message || String(err));
      return null;
    } finally {
      clearTimeout(timer);
      inFlight.delete(slug);
    }
  })();

  inFlight.set(slug, task);
  return task;
}

function clearCache() {
  cache.clear();
  inFlight.clear();
}

module.exports = {
  fetchPriceBySlug,
  __test__: {
    normalizeSlug,
    clearCache,
    getCachedPrice,
    setCachedPrice,
  },
};
