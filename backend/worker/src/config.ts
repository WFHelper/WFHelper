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
	dailyBudgetEnabled: boolean;
	catalogSlugGuardEnabled: boolean;
	dailyBudgetMaxRequests: number;
	dailyBudgetSampleRate: number;
}

export function getWorkerConfig(env: Env): WorkerConfig {
	return {
		cacheTtlSec: clamp(parsePositiveInt(env.CACHE_TTL_SEC, 86400), 60, 604800),
		noDataTtlSec: clamp(parsePositiveInt(env.NO_DATA_TTL_SEC, 900), 60, 604800),
		staleRefreshSec: clamp(parsePositiveInt(env.STALE_REFRESH_SEC, 75600), 120, 604800),
		orderSummaryCacheTtlSec: clamp(parsePositiveInt(env.ORDERS_SUMMARY_CACHE_TTL_SEC, 172800), 300, 604800),
		orderSummaryStaleRefreshSec: clamp(parsePositiveInt(env.ORDERS_SUMMARY_STALE_REFRESH_SEC, 75600), 60, 604800),
		catalogRefreshHours: clamp(parsePositiveInt(env.CATALOG_REFRESH_HOURS, 24), 1, 168),
		adminPrewarmMaxBatch: clamp(parsePositiveInt(env.ADMIN_PREWARM_MAX_BATCH, 100), 1, 100),
		prewarmBatchSize: parsePositiveInt(env.PREWARM_BATCH_SIZE, 125),
		orderSummaryPrewarmBatchSize: parsePositiveInt(env.ORDER_SUMMARY_PREWARM_BATCH_SIZE, 36),
		bootstrapTokenTtlSec: clamp(parsePositiveInt(env.BOOTSTRAP_TOKEN_TTL_SEC, 900), 60, 3600),
		publicRateLimitEnabled: (env.PUBLIC_RATE_LIMIT_ENABLED || '1').trim() !== '0',
		dailyBudgetEnabled: (env.DAILY_BUDGET_ENABLED || '1').trim() !== '0',
		catalogSlugGuardEnabled: (env.CATALOG_SLUG_GUARD_ENABLED || '1').trim() !== '0',
		dailyBudgetMaxRequests: clamp(parsePositiveInt(env.DAILY_BUDGET_MAX_REQUESTS, 300000), 1, 10000000),
		dailyBudgetSampleRate: clamp(parsePositiveInt(env.DAILY_BUDGET_SAMPLE_RATE, 100), 1, 1000),
	};
}
