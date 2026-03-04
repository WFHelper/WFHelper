import { MISS_META_PREFIX, MISS_PRICE_PREFIX, SKIP_UNTRADABLE_PREFIX } from '../constants';
import type { Env } from '../types';
import { clamp, getJsonFromKv, parsePositiveInt } from '../utils';
import { fetchMetaPayload, fetchPricePayload, markUntradable, putMetaPayload, putPricePayload } from './prewarm';

const priceInFlight = new Map<string, Promise<Record<string, unknown> | null>>();
const metaInFlight = new Map<string, Promise<Record<string, unknown> | null>>();

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
};

function noDataTtlSec(env: Env): number {
	return clamp(parsePositiveInt(env.NO_DATA_TTL_SEC, 900), 60, 604800);
}

function staleRefreshSec(env: Env): number {
	return clamp(parsePositiveInt(env.STALE_REFRESH_SEC, 1800), 120, 604800);
}

function timestampFromRecord(data: Record<string, unknown> | null): number {
	if (!data) return 0;
	const ts = Number(data.timestamp || 0);
	return Number.isFinite(ts) ? ts : 0;
}

function isStale(data: Record<string, unknown> | null, env: Env): boolean {
	const ts = timestampFromRecord(data);
	if (ts <= 0) return true;
	return Date.now() - ts > staleRefreshSec(env) * 1000;
}

async function setNegativeMarker(namespace: KVNamespace, key: string, env: Env): Promise<void> {
	await namespace.put(key, '1', {
		expirationTtl: noDataTtlSec(env),
	});
}

async function hydratePrice(env: Env, slug: string, markNoData: boolean): Promise<Record<string, unknown> | null> {
	const inFlight = priceInFlight.get(slug);
	if (inFlight) return inFlight;

	const task = (async () => {
		const payload = await fetchPricePayload(slug);
		if (!payload) {
			if (markNoData) {
				await setNegativeMarker(env.PRICE_CACHE, `${MISS_PRICE_PREFIX}${slug}`, env);
			}
			return null;
		}

		await env.PRICE_CACHE.delete(`${MISS_PRICE_PREFIX}${slug}`);
		autoStats.priceHydrated += 1;
		return putPricePayload(env, slug, payload);
	})()
		.catch(() => null)
		.finally(() => {
			priceInFlight.delete(slug);
		});

	priceInFlight.set(slug, task);
	return task;
}

async function hydrateMeta(env: Env, slug: string, markNoData: boolean): Promise<Record<string, unknown> | null> {
	const inFlight = metaInFlight.get(slug);
	if (inFlight) return inFlight;

	const task = (async () => {
		const payload = await fetchMetaPayload(slug);
		if (!payload) {
			if (markNoData) {
				await setNegativeMarker(env.ITEM_META, `${MISS_META_PREFIX}${slug}`, env);
			}
			return null;
		}

		if (!payload.tradable) {
			autoStats.metaUntradableSkips += 1;
			await markUntradable(env, slug);
			return null;
		}

		await env.ITEM_META.delete(`${MISS_META_PREFIX}${slug}`);
		await env.ITEM_META.delete(`${SKIP_UNTRADABLE_PREFIX}${slug}`);
		autoStats.metaHydrated += 1;
		return putMetaPayload(env, payload);
	})()
		.catch(() => null)
		.finally(() => {
			metaInFlight.delete(slug);
		});

	metaInFlight.set(slug, task);
	return task;
}

export async function getOrHydratePrice(env: Env, slug: string, ctx?: ExecutionContext): Promise<Record<string, unknown> | null> {
	const cached = await getJsonFromKv(env.PRICE_CACHE, `price:${slug}`);
	if (cached) {
		autoStats.priceCacheHits += 1;
		if (ctx && isStale(cached, env)) {
			autoStats.priceStaleRefreshQueued += 1;
			ctx.waitUntil(hydratePrice(env, slug, false));
		}
		return cached;
	}

	const missMarker = await env.PRICE_CACHE.get(`${MISS_PRICE_PREFIX}${slug}`);
	if (missMarker) {
		autoStats.priceNegativeHits += 1;
		return null;
	}

	return hydratePrice(env, slug, true);
}

export async function getOrHydrateMeta(env: Env, slug: string, ctx?: ExecutionContext): Promise<Record<string, unknown> | null> {
	const cached = await getJsonFromKv(env.ITEM_META, `meta:${slug}`);
	if (cached) {
		autoStats.metaCacheHits += 1;
		if (ctx && isStale(cached, env)) {
			autoStats.metaStaleRefreshQueued += 1;
			ctx.waitUntil(hydrateMeta(env, slug, false));
		}
		return cached;
	}

	const untradableMarker = await env.ITEM_META.get(`${SKIP_UNTRADABLE_PREFIX}${slug}`);
	if (untradableMarker) {
		autoStats.metaUntradableSkips += 1;
		return null;
	}

	const missMarker = await env.ITEM_META.get(`${MISS_META_PREFIX}${slug}`);
	if (missMarker) {
		autoStats.metaNegativeHits += 1;
		return null;
	}

	return hydrateMeta(env, slug, true);
}

export function getAutoCacheStats(): Record<string, number> {
	return { ...autoStats };
}

export function getAutoCacheConfig(env: Env): Record<string, number> {
	return {
		cacheTtlSec: clamp(parsePositiveInt(env.CACHE_TTL_SEC, 43200), 60, 604800),
		noDataTtlSec: noDataTtlSec(env),
		staleRefreshSec: staleRefreshSec(env),
	};
}
