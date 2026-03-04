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
export const SKIP_UNTRADABLE_PREFIX = 'skip:untradable:';
export const MISS_PRICE_PREFIX = 'miss:price:';
export const MISS_META_PREFIX = 'miss:meta:';
