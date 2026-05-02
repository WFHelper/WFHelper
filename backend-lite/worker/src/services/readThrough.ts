import { MISS_META_PREFIX, MISS_ORDERS_PREFIX, MISS_ORDER_SUMMARY_PREFIX, MISS_PRICE_PREFIX, SKIP_UNTRADABLE_PREFIX } from '../constants';
import type { Env } from '../types';
import { getWorkerConfig } from '../config';
import { getJsonFromKv } from '../utils';
import {
	buildOrderSummaryPayload,
	fetchMetaPayload,
	fetchOrdersPayload,
	fetchPricePayload,
	markPriceNoData,
	markUntradable,
	putMetaPayload,
	putOrderSummaryPayload,
	putPricePayload,
} from './prewarm';
import { normalizeRankFilter } from '../../../../config/shared/numeric';
import { isExcludedRankedMarketItem } from '../../../../config/shared/wfmExclusions';
import {
	workerMissCacheKey,
	workerOrderSummaryCacheKey,
	workerOrdersCacheKey,
	workerPriceCacheKey,
} from '../../../../config/shared/wfmCacheKeys';

type AutoReadResult =
	| { status: 'ok'; data: Record<string, unknown> }
	| { status: 'not_found'; data: null }
	| { status: 'unavailable'; data: null };

interface HydrateResult {
	data: Record<string, unknown> | null;
	transient: boolean;
}

type AutoStatsKey = keyof typeof autoStats;

interface ReadThroughDescriptor {
	namespace: KVNamespace;
	cacheKey: string;
	missKey: string;
	isStale: (data: Record<string, unknown> | null, env: Env) => boolean;
	hydrate: (markNoData: boolean) => Promise<HydrateResult>;
	stats: {
		cacheHit: AutoStatsKey;
		negativeHit: AutoStatsKey;
		staleRefreshQueued: AutoStatsKey;
	};
	canQueueRefresh?: () => boolean;
	beforeMissCheck?: () => Promise<boolean>;
	onBeforeMissHit?: () => void;
}

function priceCacheKey(slug: string, rank: number | null): string {
	return workerPriceCacheKey(slug, rank);
}

function priceMissKey(slug: string, rank: number | null): string {
	return workerMissCacheKey(MISS_PRICE_PREFIX, slug, rank);
}

function ordersCacheKey(slug: string, rank: number | null): string {
	return workerOrdersCacheKey(slug, rank);
}

function ordersMissKey(slug: string, rank: number | null): string {
	return workerMissCacheKey(MISS_ORDERS_PREFIX, slug, rank);
}

function orderSummaryCacheKey(slug: string, rank: number | null): string {
	return workerOrderSummaryCacheKey(slug, rank);
}

function orderSummaryMissKey(slug: string, rank: number | null): string {
	return workerMissCacheKey(MISS_ORDER_SUMMARY_PREFIX, slug, rank);
}

const priceInFlight = new Map<string, Promise<HydrateResult>>();
const metaInFlight = new Map<string, Promise<Record<string, unknown> | null>>();
const ordersInFlight = new Map<string, Promise<HydrateResult>>();
const orderSummaryInFlight = new Map<string, Promise<HydrateResult>>();

const ORDER_SUMMARY_BREAKER_THRESHOLD = 6;
const ORDER_SUMMARY_BREAKER_COOLDOWN_MS = 90_000;

/**
 * Circuit-breaker state is per-V8-isolate, not global.
 *
 * Cloudflare Workers run in multiple isolates across hundreds of PoPs. Each
 * isolate loads its own copy of this module, so these counters are NOT shared
 * across isolates. The practical effect:
 *
 *   - Under steady load, each isolate independently discovers upstream is down
 *     (up to ~6 failed calls per isolate before opening).
 *   - A "tripped" breaker in PoP-A does not prevent PoP-B from hammering WFM.
 *   - Aggregate failed calls during a full outage can be up to N * threshold,
 *     where N is the number of active isolates (typically single-digits).
 *
 * This is acceptable: the goal is to stop *this* isolate from retry-storming
 * WFM, not to coordinate a global shutdown. A true global breaker would require
 * KV-backed state, which adds a KV read per request — not worth it.
 */
let localOrderSummaryTransientStreak = 0;
let localOrderSummaryCircuitOpenUntil = 0;

const autoStats = {
	priceCacheHits: 0,
	priceHydrated: 0,
	priceNegativeHits: 0,
	priceStaleRefreshQueued: 0,
	metaCacheHits: 0,
	metaHydrated: 0,
	metaNegativeHits: 0,
	metaUntradableSkips: 0,
	metaStaleRefreshQueued: 0,
	ordersCacheHits: 0,
	ordersHydrated: 0,
	ordersNegativeHits: 0,
	ordersStaleRefreshQueued: 0,
	orderSummaryCacheHits: 0,
	orderSummaryHydrated: 0,
	orderSummaryNegativeHits: 0,
	orderSummaryStaleRefreshQueued: 0,
	orderSummaryUnavailable: 0,
	orderSummaryCircuitOpen: 0,
};

function ordersCacheTtlSec(env: Env): number {
	// KV hard-eviction TTL — must be well above ORDERS_STALE_REFRESH_SEC so that
	// stale-if-error works: stale data stays available in KV when upstream is degraded.
	return getWorkerConfig(env).ordersCacheTtlSec;
}

function timestampFromRecord(data: Record<string, unknown> | null): number {
	if (!data) return 0;
	const ts = Number(data.timestamp || 0);
	return Number.isFinite(ts) ? ts : 0;
}

function isStale(data: Record<string, unknown> | null, env: Env): boolean {
	const ts = timestampFromRecord(data);
	if (ts <= 0) return true;
	return Date.now() - ts > getWorkerConfig(env).staleRefreshSec * 1000;
}

function isOrdersStale(data: Record<string, unknown> | null, env: Env): boolean {
	const ts = timestampFromRecord(data);
	if (ts <= 0) return true;
	return Date.now() - ts > getWorkerConfig(env).ordersStaleRefreshSec * 1000;
}

function isOrderSummaryStale(data: Record<string, unknown> | null, env: Env): boolean {
	const ts = timestampFromRecord(data);
	if (ts <= 0) return true;
	return Date.now() - ts > getWorkerConfig(env).orderSummaryStaleRefreshSec * 1000;
}

function noteOrderSummaryTransient(): void {
	localOrderSummaryTransientStreak += 1;
	if (localOrderSummaryTransientStreak >= ORDER_SUMMARY_BREAKER_THRESHOLD) {
		localOrderSummaryCircuitOpenUntil = Date.now() + ORDER_SUMMARY_BREAKER_COOLDOWN_MS;
		autoStats.orderSummaryCircuitOpen += 1;
	}
}

function noteOrderSummaryRecovery(): void {
	localOrderSummaryTransientStreak = 0;
	localOrderSummaryCircuitOpenUntil = 0;
}

function orderSummaryCircuitOpen(): boolean {
	return localOrderSummaryCircuitOpenUntil > Date.now();
}

async function setNegativeMarker(namespace: KVNamespace, key: string, env: Env): Promise<void> {
	await namespace.put(key, '1', {
		expirationTtl: getWorkerConfig(env).noDataTtlSec,
	});
}

async function hydratePrice(env: Env, slug: string, markNoData: boolean, rank: number | null): Promise<HydrateResult> {
	const requestKey = priceCacheKey(slug, rank);
	const missKey = priceMissKey(slug, rank);

	const inFlight = priceInFlight.get(requestKey);
	if (inFlight) return inFlight;

	const task = (async () => {
		const result = await fetchPricePayload(slug, rank != null ? { rank } : undefined);
		if (!result.data) {
			// Only negatively cache confirmed "no data" — never cache transient errors (429/5xx).
			if (markNoData && !result.transient) {
				if (result.inactive) {
					await markPriceNoData(env, slug, rank);
				} else {
					await setNegativeMarker(env.PRICE_CACHE, missKey, env);
				}
			}
			return { data: null, transient: result.transient };
		}

		await env.PRICE_CACHE.delete(missKey);
		autoStats.priceHydrated += 1;
		const data = await putPricePayload(env, slug, result.data, rank);
		return { data, transient: false };
	})()
		.catch(() => ({ data: null, transient: true }))
		.finally(() => {
			priceInFlight.delete(requestKey);
		});

	priceInFlight.set(requestKey, task);
	return task;
}

async function hydrateMeta(env: Env, slug: string, markNoData: boolean): Promise<Record<string, unknown> | null> {
	const inFlight = metaInFlight.get(slug);
	if (inFlight) return inFlight;

	const task = (async () => {
		const result = await fetchMetaPayload(slug);
		if (!result.data) {
			// Only negatively cache confirmed "no data" — never cache transient errors (429/5xx).
			if (markNoData && !result.transient) {
				await setNegativeMarker(env.ITEM_META, `${MISS_META_PREFIX}${slug}`, env);
			}
			return null;
		}

		if (!result.data.tradable) {
			autoStats.metaUntradableSkips += 1;
			await markUntradable(env, slug);
			return null;
		}

		await env.ITEM_META.delete(`${MISS_META_PREFIX}${slug}`);
		await env.ITEM_META.delete(`${SKIP_UNTRADABLE_PREFIX}${slug}`);
		autoStats.metaHydrated += 1;
		return putMetaPayload(env, result.data);
	})()
		.catch(() => null)
		.finally(() => {
			metaInFlight.delete(slug);
		});

	metaInFlight.set(slug, task);
	return task;
}

async function hydrateOrders(env: Env, slug: string, markNoData: boolean, rank: number | null): Promise<HydrateResult> {
	const requestKey = ordersCacheKey(slug, rank);
	const missKey = ordersMissKey(slug, rank);

	const inFlight = ordersInFlight.get(requestKey);
	if (inFlight) return inFlight;

	const task = (async () => {
		const result = await fetchOrdersPayload(slug, rank != null ? { rank } : undefined);
		if (!result.data) {
			if (markNoData && !result.transient) {
				await setNegativeMarker(env.PRICE_CACHE, missKey, env);
			}
			return { data: null, transient: result.transient };
		}

		const data = {
			slug: result.data.slug,
			sell: result.data.sell,
			buy: result.data.buy,
			timestamp: result.data.timestamp,
			rank,
		};

		await env.PRICE_CACHE.delete(missKey);
		await env.PRICE_CACHE.put(requestKey, JSON.stringify(data), {
			expirationTtl: ordersCacheTtlSec(env),
		});

		autoStats.ordersHydrated += 1;
		return { data: data as Record<string, unknown>, transient: false };
	})()
		.catch(() => ({ data: null, transient: true }))
		.finally(() => {
			ordersInFlight.delete(requestKey);
		});

	ordersInFlight.set(requestKey, task);
	return task;
}

async function hydrateOrderSummary(env: Env, slug: string, markNoData: boolean, rank: number | null): Promise<HydrateResult> {
	const requestKey = orderSummaryCacheKey(slug, rank);
	const missKey = orderSummaryMissKey(slug, rank);

	if (orderSummaryCircuitOpen()) {
		autoStats.orderSummaryUnavailable += 1;
		return { data: null, transient: true };
	}

	const inFlight = orderSummaryInFlight.get(requestKey);
	if (inFlight) return inFlight;

	const task = (async () => {
		const result = await fetchOrdersPayload(slug, rank != null ? { rank } : undefined);
		if (!result.data) {
			if (result.transient) {
				noteOrderSummaryTransient();
				autoStats.orderSummaryUnavailable += 1;
			} else {
				noteOrderSummaryRecovery();
			}

			if (markNoData && !result.transient) {
				await setNegativeMarker(env.PRICE_CACHE, missKey, env);
			}
			return { data: null, transient: result.transient };
		}

		noteOrderSummaryRecovery();
		const data = buildOrderSummaryPayload(result.data.slug, rank, result.data);
		await env.PRICE_CACHE.delete(missKey);
		await putOrderSummaryPayload(env, result.data.slug, data, rank);

		autoStats.orderSummaryHydrated += 1;
		return { data, transient: false };
	})()
		.catch(() => {
			noteOrderSummaryTransient();
			autoStats.orderSummaryUnavailable += 1;
			return { data: null, transient: true };
		})
		.finally(() => {
			orderSummaryInFlight.delete(requestKey);
		});

	orderSummaryInFlight.set(requestKey, task);
	return task;
}

async function withReadThrough(env: Env, ctx: ExecutionContext | undefined, descriptor: ReadThroughDescriptor): Promise<AutoReadResult> {
	const cached = await getJsonFromKv(descriptor.namespace, descriptor.cacheKey);
	if (cached) {
		autoStats[descriptor.stats.cacheHit] += 1;
		const canQueueRefresh = descriptor.canQueueRefresh ? descriptor.canQueueRefresh() : true;
		if (ctx && canQueueRefresh && descriptor.isStale(cached, env)) {
			autoStats[descriptor.stats.staleRefreshQueued] += 1;
			ctx.waitUntil(
				descriptor.hydrate(false).then(() => {
					return;
				}),
			);
		}
		return { status: 'ok', data: cached };
	}

	if (descriptor.beforeMissCheck && (await descriptor.beforeMissCheck())) {
		descriptor.onBeforeMissHit?.();
		return { status: 'not_found', data: null };
	}

	const missMarker = await descriptor.namespace.get(descriptor.missKey);
	if (missMarker) {
		autoStats[descriptor.stats.negativeHit] += 1;
		return { status: 'not_found', data: null };
	}

	const hydrated = await descriptor.hydrate(true);
	if (hydrated.data) {
		return { status: 'ok', data: hydrated.data };
	}

	return hydrated.transient ? { status: 'unavailable', data: null } : { status: 'not_found', data: null };
}

export async function getOrHydratePrice(
	env: Env,
	slug: string,
	ctx?: ExecutionContext,
	rankInput?: number | null,
): Promise<AutoReadResult> {
	const rank = normalizeRankFilter(rankInput);
	const cacheKey = priceCacheKey(slug, rank);
	const missKey = priceMissKey(slug, rank);
	return withReadThrough(env, ctx, {
		namespace: env.PRICE_CACHE,
		cacheKey,
		missKey,
		isStale,
		hydrate: (markNoData) => hydratePrice(env, slug, markNoData, rank),
		stats: {
			cacheHit: 'priceCacheHits',
			negativeHit: 'priceNegativeHits',
			staleRefreshQueued: 'priceStaleRefreshQueued',
		},
	});
}

export async function getOrHydrateMeta(env: Env, slug: string, ctx?: ExecutionContext): Promise<Record<string, unknown> | null> {
	const result = await withReadThrough(env, ctx, {
		namespace: env.ITEM_META,
		cacheKey: `meta:${slug}`,
		missKey: `${MISS_META_PREFIX}${slug}`,
		isStale,
		hydrate: async (markNoData) => {
			const data = await hydrateMeta(env, slug, markNoData);
			return { data, transient: false };
		},
		stats: {
			cacheHit: 'metaCacheHits',
			negativeHit: 'metaNegativeHits',
			staleRefreshQueued: 'metaStaleRefreshQueued',
		},
		beforeMissCheck: async () => Boolean(await env.ITEM_META.get(`${SKIP_UNTRADABLE_PREFIX}${slug}`)),
		onBeforeMissHit: () => {
			autoStats.metaUntradableSkips += 1;
		},
	});

	return result.status === 'ok' ? result.data : null;
}

export async function getOrHydrateOrders(
	env: Env,
	slug: string,
	ctx?: ExecutionContext,
	rankInput?: number | null,
): Promise<AutoReadResult> {
	const rank = normalizeRankFilter(rankInput);
	const cacheKey = ordersCacheKey(slug, rank);
	const missKey = ordersMissKey(slug, rank);
	return withReadThrough(env, ctx, {
		namespace: env.PRICE_CACHE,
		cacheKey,
		missKey,
		isStale: isOrdersStale,
		hydrate: (markNoData) => hydrateOrders(env, slug, markNoData, rank),
		stats: {
			cacheHit: 'ordersCacheHits',
			negativeHit: 'ordersNegativeHits',
			staleRefreshQueued: 'ordersStaleRefreshQueued',
		},
	});
}

export async function getOrHydrateOrderSummary(
	env: Env,
	slug: string,
	ctx?: ExecutionContext,
	rankInput?: number | null,
): Promise<AutoReadResult> {
	if (isExcludedRankedMarketItem(null, slug)) {
		return { status: 'not_found', data: null };
	}

	const rank = normalizeRankFilter(rankInput);
	const cacheKey = orderSummaryCacheKey(slug, rank);
	const missKey = orderSummaryMissKey(slug, rank);
	return withReadThrough(env, ctx, {
		namespace: env.PRICE_CACHE,
		cacheKey,
		missKey,
		isStale: isOrderSummaryStale,
		hydrate: (markNoData) => hydrateOrderSummary(env, slug, markNoData, rank),
		stats: {
			cacheHit: 'orderSummaryCacheHits',
			negativeHit: 'orderSummaryNegativeHits',
			staleRefreshQueued: 'orderSummaryStaleRefreshQueued',
		},
		canQueueRefresh: () => !orderSummaryCircuitOpen(),
	});
}

export function getAutoCacheStats(): Record<string, number> {
	return {
		...autoStats,
		orderSummaryCircuitActive: orderSummaryCircuitOpen() ? 1 : 0,
		orderSummaryCircuitRetryAfterMs: Math.max(0, localOrderSummaryCircuitOpenUntil - Date.now()),
	};
}

export function getAutoCacheConfig(env: Env): Record<string, number> {
	const config = getWorkerConfig(env);
	return {
		cacheTtlSec: config.cacheTtlSec,
		noDataTtlSec: config.noDataTtlSec,
		staleRefreshSec: config.staleRefreshSec,
		ordersCacheTtlSec: ordersCacheTtlSec(env),
		ordersStaleRefreshSec: config.ordersStaleRefreshSec,
		orderSummaryCacheTtlSec: config.orderSummaryCacheTtlSec,
		orderSummaryStaleRefreshSec: config.orderSummaryStaleRefreshSec,
	};
}
