import type { Env } from './types';
import { clamp, parsePositiveInt } from './utils';

interface WorkerConfig {
	cacheTtlSec: number;
	noDataTtlSec: number;
	staleRefreshSec: number;
	orderSummaryCacheTtlSec: number;
	orderSummaryStaleRefreshSec: number;
	catalogRefreshHours: number;
	adminPrewarmMaxBatch: number;
	prewarmBatchSize: number;
	orderSummaryPrewarmBatchSize: number;
	bootstrapTokenTtlSec: number;
	publicRateLimitEnabled: boolean;
	adminRateLimitWindowSec: number;
	adminRateLimitMax: number;
}

export function getWorkerConfig(env: Env): WorkerConfig {
	return {
		cacheTtlSec: clamp(parsePositiveInt(env.CACHE_TTL_SEC, 43200), 60, 604800),
		noDataTtlSec: clamp(parsePositiveInt(env.NO_DATA_TTL_SEC, 900), 60, 604800),
		staleRefreshSec: clamp(parsePositiveInt(env.STALE_REFRESH_SEC, 1800), 120, 604800),
		orderSummaryCacheTtlSec: clamp(parsePositiveInt(env.ORDERS_SUMMARY_CACHE_TTL_SEC, 172800), 300, 604800),
		orderSummaryStaleRefreshSec: clamp(parsePositiveInt(env.ORDERS_SUMMARY_STALE_REFRESH_SEC, 21600), 60, 604800),
		catalogRefreshHours: clamp(parsePositiveInt(env.CATALOG_REFRESH_HOURS, 24), 1, 168),
		adminPrewarmMaxBatch: clamp(parsePositiveInt(env.ADMIN_PREWARM_MAX_BATCH, 30), 1, 100),
		prewarmBatchSize: parsePositiveInt(env.PREWARM_BATCH_SIZE, 8),
		orderSummaryPrewarmBatchSize: parsePositiveInt(env.ORDER_SUMMARY_PREWARM_BATCH_SIZE, 12),
		bootstrapTokenTtlSec: clamp(parsePositiveInt(env.BOOTSTRAP_TOKEN_TTL_SEC, 900), 60, 3600),
		publicRateLimitEnabled: (env.PUBLIC_RATE_LIMIT_ENABLED || '1').trim() !== '0',
		adminRateLimitWindowSec: clamp(parsePositiveInt(env.ADMIN_RATE_LIMIT_WINDOW_SEC, 60), 10, 3600),
		adminRateLimitMax: clamp(parsePositiveInt(env.ADMIN_RATE_LIMIT_MAX, 12), 1, 500),
	};
}
