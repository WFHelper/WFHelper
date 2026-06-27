/** Barrel re-exports for `src/lib/relic/` - keeps `./relic.js` imports working. */

export { RELIC_ICON_PATHS, RELIC_TIER_ORDER, fissureTierClass } from "./relic/relicConstants.js";

export { relicGroupMatchesSearch, buildRelicSearchKeywordIndex } from "./relic/relicSearch.js";

export { parseOwnedRelics } from "./relic/relicInventory.js";

export { computeSquadEV } from "./relic/relicMath.js";

export {
  computeGroupDucatEv,
  computeGroupDucatonator,
  configureRelicRuntimeCacheFingerprint,
  getCachedEv,
  evHasFreshNoData,
  warmupPrimeRewardPriceCache,
} from "./relic/relicPriceCache.js";

export { createRelicWarmupController } from "./relic/relicWarmupController.js";
