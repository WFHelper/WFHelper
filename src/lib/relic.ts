/** Barrel re-exports for `src/lib/relic/` - keeps `./relic.js` imports working. */

export {
  RELIC_ICON_PATHS,
  RELIC_QUALITY_SHORT_KEY,
  QUALITY_MODES,
  fissureTierClass,
  highestOwnedQuality,
} from "./relic/relicConstants.js";

export {
  relicGroupMatchesSearch,
  relicGroupHasMatchingReward,
  buildRelicSearchKeywordIndex,
} from "../../config/shared/relicSearch.js";

export { parseOwnedRelics, relicGroupForUniqueName } from "./relic/relicInventory.js";

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
