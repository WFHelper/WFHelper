/**
 * Barrel module — re-exports from relic sub-modules.
 *
 * All relic-related logic lives in `src/lib/relic/`. This file exists so that
 * existing consumer imports (`from "./relic.js"`) continue to work unchanged.
 */

// --- Constants & tier helpers ------------------------------------------------
export {
  RELIC_ICON_PATHS,
  RELIC_TIER_ORDER,
  fissureTierClass,
} from "./relic/relicConstants.js";

// --- Search helpers ----------------------------------------------------------
export { relicGroupMatchesSearch, buildRelicSearchKeywordIndex } from "./relic/relicSearch.js";

// --- Inventory (owned-relic parsing) -----------------------------------------
export { parseOwnedRelics } from "./relic/relicInventory.js";

// --- Math (squad EV) ---------------------------------------------------------
export { computeSquadEV, computeSquadDucatEV } from "./relic/relicMath.js";

// --- Price cache, EV cache, warmup orchestration -----------------------------
export {
  computeGroupDucatEv,
  computeGroupDucatonator,
  configureRelicRuntimeCacheFingerprint,
  getCachedEv,
  evHasFreshNoData,
  cancelWarmup,
  warmupRelicCardPrices,
  warmupPrimeRewardPriceCache,
  warmupRewardDucats,
  warmupRelicEvs,
} from "./relic/relicPriceCache.js";
