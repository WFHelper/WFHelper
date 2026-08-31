export const CATALOG_CACHE_KEY = 'catalog:slugs:v1';
export const CATALOG_CLIENT_ITEMS_KEY = 'catalog:client-items:v2';
export const PREWARM_CURSOR_KEY = 'prewarm:cursor:v1';
export const PREWARM_LAST_RUN_KEY = 'prewarm:last-run:v1';
export const ORDER_SUMMARY_HOTSET_KEY = 'order-summary:hotset:v1';
export const ORDER_SUMMARY_PREWARM_CURSOR_KEY = 'order-summary:prewarm:cursor:v1';
export const ORDER_SUMMARY_PREWARM_LAST_RUN_KEY = 'order-summary:prewarm:last-run:v1';
export const ORDER_SUMMARY_CATALOG_KEY = 'order-summary:catalog:v1';
export const ORDER_SUMMARY_CATALOG_PREWARM_CURSOR_KEY = 'order-summary:catalog:prewarm:cursor:v1';
export const ORDER_SUMMARY_CATALOG_PREWARM_LAST_RUN_KEY = 'order-summary:catalog:prewarm:last-run:v1';
export const SKIP_UNTRADABLE_PREFIX = 'skip:untradable:';
export const MISS_PRICE_PREFIX = 'miss:price:v2:';
export const MISS_META_PREFIX = 'miss:meta:';
export const MISS_ORDER_SUMMARY_PREFIX = 'miss:orders-summary:v1:';
export const SNAPSHOT_KEY = 'snapshot:full:v1';
// History archives accrue from deploy day and are never backfilled.
export const ARCHIVE_PRICES_PREFIX = 'archive:prices:';
export const ARCHIVE_RIVENS_PREFIX = 'archive:rivens:';
export const ARCHIVE_BARO_PREFIX = 'archive:baro:';
export const ARCHIVE_INDEX_PREFIX = 'archive:index:';
export const RIVEN_ARCHIVE_WEAPONS_KEY = 'archive:riven-weapons:v1';
export const RIVEN_ARCHIVE_SWEEP_KEY = 'archive:riven-sweep:v1';
export const SUPPORTERS_KEY = 'supporters:discord:v1';
export const SUPPORTER_EXCLUSIONS_KEY = 'supporters:exclusions:v1';
// Retired Patreon pipeline keys (profile names, OAuth tokens); every
// successful sync deletes them.
export const LEGACY_PATREON_KEYS = ['patreon:supporters:v1', 'patreon:tokens:v1', 'patreon:exclusions:v1'] as const;
