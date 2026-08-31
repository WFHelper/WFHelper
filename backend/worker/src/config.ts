import type { Env, SupporterTier } from './types';
import { clamp, parsePositiveInt } from './utils';

// Role ids are opaque Discord snowflakes, so the map is validated by value only.
function parseRoleTierMap(raw: string | undefined): Record<string, SupporterTier> {
	const map: Record<string, SupporterTier> = {};
	if (!raw || !raw.trim()) return map;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return map;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map;

	for (const [roleId, tier] of Object.entries(parsed as Record<string, unknown>)) {
		const id = roleId.trim();
		if (!id) continue;
		if (tier === 'basic' || tier === 'big' || tier === 'biggest') map[id] = tier;
	}
	return map;
}

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
	historyArchiveEnabled: boolean;
	historyRetentionDays: number;
	rivenArchiveBatchSize: number;
	priceSeedEnabled: boolean;
	priceSeedBatchSize: number;
	discordGuildId: string;
	discordRoleTierMap: Record<string, SupporterTier>;
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
		historyArchiveEnabled: (env.HISTORY_ARCHIVE_ENABLED || '1').trim() !== '0',
		historyRetentionDays: clamp(parsePositiveInt(env.HISTORY_RETENTION_DAYS, 730), 1, 3650),
		rivenArchiveBatchSize: clamp(parsePositiveInt(env.RIVEN_ARCHIVE_BATCH_SIZE, 12), 1, 60),
		priceSeedEnabled: (env.PRICE_SEED_ENABLED || '1').trim() !== '0',
		priceSeedBatchSize: clamp(parsePositiveInt(env.PRICE_SEED_BATCH_SIZE, 20), 1, 40),
		discordGuildId: (env.DISCORD_GUILD_ID || '').trim(),
		discordRoleTierMap: parseRoleTierMap(env.DISCORD_ROLE_TIER_MAP),
	};
}
