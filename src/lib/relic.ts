/**
 * Barrel module — re-exports from relic sub-modules.
 *
 * All relic-related logic lives in `src/lib/relic/`. This file exists so that
 * existing consumer imports (`from "./relic.js"`) continue to work unchanged.
 */

export {
  RELIC_ICON_PATHS,
  RELIC_TIER_ORDER,
  fissureTierClass,
} from "./relic/relicConstants.js";

export { relicGroupMatchesSearch, buildRelicSearchKeywordIndex } from "./relic/relicSearch.js";

export { parseOwnedRelics } from "./relic/relicInventory.js";

export { computeSquadEV, computeSquadDucatEV } from "./relic/relicMath.js";

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
