export interface Env {
	PRICE_CACHE: KVNamespace;
	ITEM_META: KVNamespace;
	ADMIN_API_KEY?: string;
	CACHE_TTL_SEC: string;
	ALLOW_ORIGIN: string;
	ADMIN_RATE_LIMIT_WINDOW_SEC: string;
	ADMIN_RATE_LIMIT_MAX: string;
	PREWARM_BATCH_SIZE?: string;
	ADMIN_PREWARM_MAX_BATCH?: string;
	CATALOG_REFRESH_HOURS?: string;
	NO_DATA_TTL_SEC?: string;
	STALE_REFRESH_SEC?: string;
}

export interface PrewarmResult {
	ok: boolean;
	reason: 'manual' | 'cron';
	timestamp: number;
	batchSize: number;
	cursorBefore: number;
	cursorAfter: number;
	totalCatalogSlugs: number;
	priceUpdated: number;
	metaUpdated: number;
	processed: number;
	skippedUntradable: number;
	failures: number;
}

export interface MetaPayload {
	slug: string;
	tradable: boolean;
	thumb: string | null;
	icon: string | null;
	ducats: number | null;
	setRoot: boolean;
	timestamp: number;
}
