export const SLUG_RE = /^[a-z0-9_]+$/;

export const WFM_HEADERS = {
	Platform: 'pc',
	Language: 'en',
	Crossplay: 'true',
	Accept: 'application/json',
};

export const CATALOG_CACHE_KEY = 'catalog:slugs:v1';
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
export const MISS_ORDERS_PREFIX = 'miss:orders:v2:';
export const MISS_ORDER_SUMMARY_PREFIX = 'miss:orders-summary:v1:';
export const SNAPSHOT_KEY = 'snapshot:full:v1';
export const SNAPSHOT_LAST_GEN_KEY = 'snapshot:last-gen:v1';
