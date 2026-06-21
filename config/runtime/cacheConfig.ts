/** Identical reward frames only need to be skipped during one settled reward-screen dwell. */
export const REWARD_FRAME_DEDUP_TTL_MS = 5_000;

/** WFM statistics change slowly, but five minutes keeps overlay pricing responsive. */
export const WFM_STATS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Warframe process/focus checks are expensive enough to debounce but must feel live. */
export const WARFRAME_STATUS_CACHE_TTL_MS = 2_000;

/** Endless fissures reuse the same era for several rotations, then re-detect after leaving. */
export const RELIC_MISSION_TIER_CACHE_TTL_MS = 25 * 60 * 1000;

/** Failed bootstrap fetches should not fan out into parallel retry storms. */
export const BACKEND_BOOTSTRAP_FAILURE_COOLDOWN_MS = 30_000;

/** Failed backend price reads should cool down briefly before trying the worker again. */
export const WFM_BACKEND_ERROR_COOLDOWN_MS = 60_000;
