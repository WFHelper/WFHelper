export interface Env {
	PRICE_CACHE: KVNamespace;
	ITEM_META: KVNamespace;
	DAILY_BUDGET: DurableObjectNamespace;
	SNAPSHOT_COORDINATOR: DurableObjectNamespace;
	PUBLIC_HEALTH_RATE_LIMITER: RateLimit;
	PUBLIC_LOW_RATE_LIMITER: RateLimit;
	PUBLIC_API_RATE_LIMITER: RateLimit;
	PUBLIC_SNAPSHOT_RATE_LIMITER: RateLimit;
	ADMIN_RATE_LIMITER: RateLimit;
	ADMIN_API_KEY?: string;
	CACHE_TTL_SEC: string;
	ORDERS_SUMMARY_CACHE_TTL_SEC?: string;
	ORDERS_SUMMARY_STALE_REFRESH_SEC?: string;
	ALLOW_ORIGIN: string;
	CATALOG_SLUG_GUARD_ENABLED?: string;
	DAILY_BUDGET_ENABLED?: string;
	DAILY_BUDGET_MAX_REQUESTS?: string;
	DAILY_BUDGET_SAMPLE_RATE?: string;
	PREWARM_BATCH_SIZE?: string;
	ORDER_SUMMARY_PREWARM_BATCH_SIZE?: string;
	ADMIN_PREWARM_MAX_BATCH?: string;
	CATALOG_REFRESH_HOURS?: string;
	NO_DATA_TTL_SEC?: string;
	STALE_REFRESH_SEC?: string;
	PUBLIC_RATE_LIMIT_ENABLED?: string;
	BOOTSTRAP_TOKEN_SECRET?: string;
	BOOTSTRAP_TOKEN_TTL_SEC?: string;
	PUBLIC_BOOTSTRAP_REQUIRED?: string;
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

export interface OrderSummaryHotsetEntry {
	slug: string;
	maxRank: number;
	lastSeenAt: number;
}

export interface OrderSummaryCatalogEntry {
	slug: string;
	maxRank: number;
}

export interface OrderSummaryPrewarmResult {
	ok: boolean;
	reason: 'manual' | 'cron';
	source: 'hotset' | 'catalog';
	timestamp: number;
	batchSize: number;
	totalEntries: number;
	cursorBefore: number;
	cursorAfter: number;
	processed: number;
	updated: number;
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

interface OrderBookEntry {
	userName: string;
	status: string | null;
	platinum: number;
	quantity: number;
	rank: number | null;
}

export interface OrdersPayload {
	slug: string;
	sell: OrderBookEntry[];
	buy: OrderBookEntry[];
	timestamp: number;
}
