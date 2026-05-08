import {
	ORDER_SUMMARY_CATALOG_PREWARM_CURSOR_KEY,
	ORDER_SUMMARY_CATALOG_PREWARM_LAST_RUN_KEY,
	ORDER_SUMMARY_HOTSET_KEY,
	ORDER_SUMMARY_PREWARM_CURSOR_KEY,
	ORDER_SUMMARY_PREWARM_LAST_RUN_KEY,
	MISS_PRICE_PREFIX,
	PREWARM_CURSOR_KEY,
	PREWARM_LAST_RUN_KEY,
	SKIP_UNTRADABLE_PREFIX,
	SLUG_RE,
	SNAPSHOT_ETAG_KEY,
	SNAPSHOT_KEY,
	SNAPSHOT_LAST_GEN_KEY,
} from '../constants';
import type { Env, MetaPayload, OrdersPayload, OrderSummaryHotsetEntry, OrderSummaryPrewarmResult, PrewarmResult } from '../types';
import { getWorkerConfig } from '../config';
import { clamp, getJsonFromKv } from '../utils';
import { extractLatestMedianFromStatsPayload } from '../../../../config/shared/wfmStats';
import { normalizeDucats, normalizeRankFilter } from '../../../../config/shared/numeric';
import { formatWfmAssetUrl, WFM_HEADERS } from '../../../../config/shared/wfm';
import {
	snapshotCacheKeyFromWorkerKey,
	workerMissCacheKey,
	workerOrderSummaryCacheKey,
	workerPriceCacheKey,
} from '../../../../config/shared/wfmCacheKeys';
import { extractWfmOrderList, normalizeWfmOrderBookSide } from '../../../../config/shared/wfmOrders';
import { WFM_SNAPSHOT_MAX_ENTRY_AGE_MS } from '../../../../config/shared/wfmSnapshotValidation';
import {
	buildOrderSummaryPayload,
	cacheTtlSec,
	fetchCatalogSlugs,
	fetchRankedSummaryCatalog,
	orderSummaryCacheTtlSec,
	sanitizeOrderSummaryHotsetEntries,
} from './prewarmCatalog';

export {
	buildOrderSummaryPayload,
	fetchRankedSummaryCatalog,
	readRankedSummaryCatalogFromKv,
	sanitizeOrderSummaryHotsetEntries,
} from './prewarmCatalog';

const UNTRADABLE_SKIP_TTL_SEC = 30 * 24 * 60 * 60;

interface FetchResult<T> {
	data: T | null;
	/** true when the failure is transient (429/5xx) — do NOT negatively cache. */
	transient: boolean;
	inactive?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function inactivePriceSnapshotEntry(timestamp = Date.now()): Record<string, unknown> {
	return {
		status: 'no_data',
		median: null,
		timestamp,
	};
}

function snapshotOrderSummaryEntryFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
	const wts = typeof payload.wts === 'number' && Number.isFinite(payload.wts) ? payload.wts : null;
	const wtb = typeof payload.wtb === 'number' && Number.isFinite(payload.wtb) ? payload.wtb : null;
	const timestamp = snapshotEntryTimestamp(payload) ?? Date.now();
	return {
		status: wts != null || wtb != null ? 'ok' : 'no_data',
		wts,
		wtb,
		timestamp,
	};
}

function snapshotPriceEntryFromPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
	const median = typeof payload.median === 'number' && Number.isFinite(payload.median) ? payload.median : null;
	if (median == null) return null;
	const timestamp = snapshotEntryTimestamp(payload) ?? Date.now();
	return {
		status: 'ok',
		median,
		timestamp,
	};
}

function snapshotEntryTimestamp(value: Record<string, unknown>): number | null {
	const timestamp = Number(value.timestamp || 0);
	return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function isDueForRefresh(value: Record<string, unknown> | null, refreshAgeSec: number, now = Date.now()): boolean {
	const timestamp = value ? snapshotEntryTimestamp(value) : null;
	if (timestamp == null) return true;
	return now - timestamp >= refreshAgeSec * 1000;
}

function isInactivePriceSource(sourceTimestamp: number | null, now = Date.now()): boolean {
	return sourceTimestamp != null && now - sourceTimestamp > WFM_SNAPSHOT_MAX_ENTRY_AGE_MS;
}

function sanitizeSnapshotEntries(
 entries: Record<string, unknown>,
 timestamp: number,
 options?: { prices?: boolean; preserveSourceTimestamp?: boolean },
): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entries)) {
		if (!isRecord(value)) {
			sanitized[key] = value;
			continue;
		}

		const sourceTimestamp = snapshotEntryTimestamp(value);
		if (options?.prices && value.status === 'ok' && isInactivePriceSource(sourceTimestamp, timestamp)) {
			sanitized[key] = inactivePriceSnapshotEntry(timestamp);
			continue;
		}

		const next: Record<string, unknown> = { ...value, timestamp };
		if (options?.preserveSourceTimestamp && sourceTimestamp != null && !isInactivePriceSource(sourceTimestamp, timestamp)) {
			next.sourceTimestamp = sourceTimestamp;
		} else if (options?.preserveSourceTimestamp) {
			delete next.sourceTimestamp;
		}
		sanitized[key] = next;
	}
	return sanitized;
}

export function sanitizeSnapshotForClient<T extends { generatedAt?: unknown; prices?: unknown; meta?: unknown; orderSummaries?: unknown }>(
	snapshot: T,
	now = Date.now(),
): T {
	const generatedAt = typeof snapshot.generatedAt === 'number' && Number.isFinite(snapshot.generatedAt) ? snapshot.generatedAt : now;
	return {
		...snapshot,
		...(isRecord(snapshot.prices) ? { prices: sanitizeSnapshotEntries(snapshot.prices, generatedAt, { prices: true }) } : {}),
		...(isRecord(snapshot.meta) ? { meta: sanitizeSnapshotEntries(snapshot.meta, generatedAt) } : {}),
		...(isRecord(snapshot.orderSummaries)
			? { orderSummaries: sanitizeSnapshotEntries(snapshot.orderSummaries, generatedAt, { preserveSourceTimestamp: true }) }
			: {}),
	};
}

export async function fetchPricePayload(
	slug: string,
	options?: { rank?: number | null },
): Promise<FetchResult<{ median: number; timestamp: number }>> {
	const targetRank = normalizeRankFilter(options?.rank);

	let response: Response;
	try {
		response = await fetch(`https://api.warframe.market/v1/items/${slug}/statistics`, {
			headers: WFM_HEADERS,
		});
	} catch {
		return { data: null, transient: true };
	}

	if (response.status === 429 || response.status >= 500) {
		return { data: null, transient: true };
	}
	if (!response.ok) return { data: null, transient: false };

	const payload = await response.json();
	const latest = extractLatestMedianFromStatsPayload(payload, targetRank != null ? { rank: targetRank } : undefined);
	if (!latest) return { data: null, transient: false };
	if (isInactivePriceSource(latest.timestamp)) return { data: null, transient: false, inactive: true };

	return {
		data: { median: latest.median, timestamp: Date.now() },
		transient: false,
	};
}

function normalizeAssetPath(pathValue: unknown): string | null {
	return formatWfmAssetUrl(pathValue);
}

export async function fetchMetaPayload(slug: string): Promise<FetchResult<MetaPayload>> {
	let response: Response;
	try {
		response = await fetch(`https://api.warframe.market/v2/items/${slug}`, {
			headers: WFM_HEADERS,
		});
	} catch {
		return { data: null, transient: true };
	}

	if (response.status === 429 || response.status >= 500) {
		return { data: null, transient: true };
	}
	if (!response.ok) return { data: null, transient: false };

	const jsonPayload = (await response.json()) as { data?: Record<string, unknown> };
	const data = jsonPayload.data;
	if (!data || typeof data !== 'object') return { data: null, transient: false };

	const i18nEn = (data.i18n as { en?: Record<string, unknown> } | undefined)?.en || {};
	const ducats = normalizeDucats(data.ducats);

	return {
		data: {
			slug,
			tradable: data.tradable === true,
			thumb: normalizeAssetPath(i18nEn.thumb || data.thumb || null),
			icon: normalizeAssetPath(i18nEn.icon || data.icon || null),
			ducats,
			setRoot: Boolean(data.setRoot),
			timestamp: Date.now(),
		},
		transient: false,
	};
}

async function fetchRawOrdersFromEndpoint(url: string): Promise<FetchResult<unknown[]>> {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: WFM_HEADERS,
		});
	} catch {
		return { data: null, transient: true };
	}

	if (response.status === 429 || response.status >= 500) {
		return { data: null, transient: true };
	}
	if (!response.ok) return { data: null, transient: false };

	const jsonPayload = await response.json();
	const rawOrders = extractWfmOrderList(jsonPayload);
	if (!rawOrders) return { data: null, transient: false };

	return { data: rawOrders, transient: false };
}

export async function fetchOrdersPayload(slug: string, options?: { rank?: number | null }): Promise<FetchResult<OrdersPayload>> {
	const targetRank = normalizeRankFilter(options?.rank);

	const v2Attempt = await fetchRawOrdersFromEndpoint(`https://api.warframe.market/v2/orders/item/${slug}`);
	if (v2Attempt.data) {
		return {
			data: {
				slug,
				sell: normalizeWfmOrderBookSide(v2Attempt.data, 'sell', targetRank),
				buy: normalizeWfmOrderBookSide(v2Attempt.data, 'buy', targetRank),
				timestamp: Date.now(),
			},
			transient: false,
		};
	}
	if (v2Attempt.transient) {
		return { data: null, transient: true };
	}

	const v1Attempt = await fetchRawOrdersFromEndpoint(`https://api.warframe.market/v1/items/${slug}/orders`);
	if (!v1Attempt.data) {
		return { data: null, transient: v1Attempt.transient };
	}

	return {
		data: {
			slug,
			sell: normalizeWfmOrderBookSide(v1Attempt.data, 'sell', targetRank),
			buy: normalizeWfmOrderBookSide(v1Attempt.data, 'buy', targetRank),
			timestamp: Date.now(),
		},
		transient: false,
	};
}

export async function putPricePayload(
	env: Env,
	slug: string,
	payload: { median: number; timestamp: number },
	rank?: number | null,
): Promise<Record<string, unknown>> {
	const normalizedRank = normalizeRankFilter(rank);
	const data = {
		slug,
		median: payload.median,
		timestamp: payload.timestamp,
		rank: normalizedRank,
	};

	const cacheKey = workerPriceCacheKey(slug, normalizedRank);

	await env.PRICE_CACHE.put(cacheKey, JSON.stringify(data), {
		expirationTtl: cacheTtlSec(env),
	});

	return data;
}

export async function markPriceNoData(env: Env, slug: string, rank?: number | null): Promise<void> {
	const normalizedRank = normalizeRankFilter(rank);
	const cacheKey = workerPriceCacheKey(slug, normalizedRank);
	const missKey = workerMissCacheKey(MISS_PRICE_PREFIX, slug, normalizedRank);
	await Promise.all([env.PRICE_CACHE.delete(cacheKey), env.PRICE_CACHE.put(missKey, '1', { expirationTtl: cacheTtlSec(env) })]);
}

export async function putMetaPayload(env: Env, payload: MetaPayload): Promise<Record<string, unknown>> {
	await env.ITEM_META.put(`meta:${payload.slug}`, JSON.stringify(payload), {
		expirationTtl: cacheTtlSec(env),
	});

	return payload as unknown as Record<string, unknown>;
}

export async function putOrderSummaryPayload(
	env: Env,
	slug: string,
	payload: Record<string, unknown>,
	rank?: number | null,
): Promise<Record<string, unknown>> {
	const normalizedRank = normalizeRankFilter(rank);
	const cacheKey = workerOrderSummaryCacheKey(slug, normalizedRank);

	await env.PRICE_CACHE.put(cacheKey, JSON.stringify(payload), {
		expirationTtl: orderSummaryCacheTtlSec(env),
	});

	return payload;
}

export async function markUntradable(env: Env, slug: string): Promise<void> {
	await env.ITEM_META.put(`${SKIP_UNTRADABLE_PREFIX}${slug}`, '1', {
		expirationTtl: UNTRADABLE_SKIP_TTL_SEC,
	});
}

export async function getOrderSummaryHotset(env: Env): Promise<OrderSummaryHotsetEntry[]> {
	const hotset = await getJsonFromKv(env.PRICE_CACHE, ORDER_SUMMARY_HOTSET_KEY);
	return sanitizeOrderSummaryHotsetEntries(hotset?.entries);
}

export async function saveOrderSummaryHotset(env: Env, entries: OrderSummaryHotsetEntry[]): Promise<OrderSummaryHotsetEntry[]> {
	const sanitized = sanitizeOrderSummaryHotsetEntries(entries);
	await env.PRICE_CACHE.put(
		ORDER_SUMMARY_HOTSET_KEY,
		JSON.stringify({
			updatedAt: Date.now(),
			entries: sanitized,
		}),
	);
	return sanitized;
}

function createOrderSummaryPrewarmResult(options: {
	reason: 'manual' | 'cron';
	source: 'hotset' | 'catalog';
	batchSize: number;
	totalEntries: number;
}): OrderSummaryPrewarmResult {
	return {
		ok: true,
		reason: options.reason,
		source: options.source,
		timestamp: Date.now(),
		batchSize: options.batchSize,
		totalEntries: options.totalEntries,
		cursorBefore: 0,
		cursorAfter: 0,
		processed: 0,
		updated: 0,
		failures: 0,
	};
}

export async function prewarmOrderSummaryHotset(
	env: Env,
	options: {
		reason: 'manual' | 'cron';
		batchSize?: number;
		entries?: OrderSummaryHotsetEntry[];
		resetCursor?: boolean;
	},
): Promise<OrderSummaryPrewarmResult> {
	const config = getWorkerConfig(env);
	const adminMaxBatch = config.adminPrewarmMaxBatch;
	const defaultBatch = config.orderSummaryPrewarmBatchSize;
	const batchSize = clamp(options.batchSize ?? defaultBatch, 1, adminMaxBatch);
	const providedEntries = sanitizeOrderSummaryHotsetEntries(options.entries);
	const hotset = providedEntries.length > 0 ? providedEntries : await getOrderSummaryHotset(env);

	const result = createOrderSummaryPrewarmResult({
		reason: options.reason,
		source: 'hotset',
		batchSize,
		totalEntries: hotset.length,
	});

	if (hotset.length === 0) {
		await env.PRICE_CACHE.put(ORDER_SUMMARY_PREWARM_LAST_RUN_KEY, JSON.stringify(result));
		return result;
	}

	let cursor = 0;
	if (!options.resetCursor) {
		const cursorRaw = await env.PRICE_CACHE.get(ORDER_SUMMARY_PREWARM_CURSOR_KEY);
		cursor = Number.isFinite(Number(cursorRaw)) ? Number(cursorRaw) : 0;
	}
	cursor = ((cursor % hotset.length) + hotset.length) % hotset.length;
	result.cursorBefore = cursor;

	for (let i = 0; i < Math.min(batchSize, hotset.length); i += 1) {
		const entry = hotset[(cursor + i) % hotset.length];
		for (const rank of [0, entry.maxRank]) {
			try {
				const ordersResult = await fetchOrdersPayload(entry.slug, { rank });
				if (!ordersResult.data) {
					if (!ordersResult.transient) {
						const payload = {
							slug: entry.slug,
							rank,
							wts: null,
							wtb: null,
							timestamp: Date.now(),
						};
						await putOrderSummaryPayload(env, entry.slug, payload, rank);
						result.updated += 1;
					} else {
						result.failures += 1;
					}
					result.processed += 1;
					continue;
				}

				const payload = buildOrderSummaryPayload(entry.slug, rank, ordersResult.data);
				await putOrderSummaryPayload(env, entry.slug, payload, rank);
				result.updated += 1;
				result.processed += 1;
			} catch {
				result.failures += 1;
				result.processed += 1;
			}
		}
	}

	result.cursorAfter = (cursor + Math.min(batchSize, hotset.length)) % hotset.length;
	await env.PRICE_CACHE.put(ORDER_SUMMARY_PREWARM_CURSOR_KEY, String(result.cursorAfter));
	await env.PRICE_CACHE.put(ORDER_SUMMARY_PREWARM_LAST_RUN_KEY, JSON.stringify(result));
	return result;
}

export async function prewarmOrderSummaryCatalog(
	env: Env,
	options: {
		reason: 'manual' | 'cron';
		batchSize?: number;
		refreshCatalog?: boolean;
		resetCursor?: boolean;
	},
): Promise<OrderSummaryPrewarmResult> {
	const config = getWorkerConfig(env);
	const cronRefresh = options.reason === 'cron';
	const adminMaxBatch = config.adminPrewarmMaxBatch;
	const defaultBatch = config.orderSummaryPrewarmBatchSize;
	const batchSize = clamp(options.batchSize ?? defaultBatch, 1, adminMaxBatch);
	const entries = await fetchRankedSummaryCatalog(env, Boolean(options.refreshCatalog));

	const result = createOrderSummaryPrewarmResult({
		reason: options.reason,
		source: 'catalog',
		batchSize,
		totalEntries: entries.length,
	});

	if (entries.length === 0) {
		await env.ITEM_META.put(ORDER_SUMMARY_CATALOG_PREWARM_LAST_RUN_KEY, JSON.stringify(result));
		return result;
	}

	let cursor = 0;
	if (!options.resetCursor) {
		const cursorRaw = await env.ITEM_META.get(ORDER_SUMMARY_CATALOG_PREWARM_CURSOR_KEY);
		cursor = Number.isFinite(Number(cursorRaw)) ? Number(cursorRaw) : 0;
	}
	cursor = ((cursor % entries.length) + entries.length) % entries.length;
	result.cursorBefore = cursor;

	// Collect order summaries and ranked prices to patch into the snapshot after the batch completes.
	const snapshotOrderSummaries: Record<string, unknown> = {};
	const snapshotPrices: Record<string, unknown> = {};

	for (let i = 0; i < Math.min(batchSize, entries.length); i += 1) {
		const entry = entries[(cursor + i) % entries.length];
		for (const rank of [0, entry.maxRank]) {
			const orderSummaryKey = workerOrderSummaryCacheKey(entry.slug, rank);
			const priceKey = workerPriceCacheKey(entry.slug, rank);
			let shouldRefreshOrderSummary = true;
			let shouldRefreshPrice = true;

			if (cronRefresh) {
				const [cachedOrderSummary, cachedPrice] = await Promise.all([
					getJsonFromKv(env.PRICE_CACHE, orderSummaryKey),
					getJsonFromKv(env.PRICE_CACHE, priceKey),
				]);
				shouldRefreshOrderSummary = isDueForRefresh(cachedOrderSummary, config.orderSummaryStaleRefreshSec);
				shouldRefreshPrice = isDueForRefresh(cachedPrice, config.staleRefreshSec);
				if (!shouldRefreshOrderSummary && !shouldRefreshPrice) {
					const snapshotOrderSummaryKey = snapshotCacheKeyFromWorkerKey(orderSummaryKey);
					if (snapshotOrderSummaryKey && cachedOrderSummary) {
						snapshotOrderSummaries[snapshotOrderSummaryKey] = snapshotOrderSummaryEntryFromPayload(cachedOrderSummary);
					}
					const snapshotPriceKey = snapshotCacheKeyFromWorkerKey(priceKey);
					const snapshotPrice = cachedPrice ? snapshotPriceEntryFromPayload(cachedPrice) : null;
					if (snapshotPriceKey && snapshotPrice) {
						snapshotPrices[snapshotPriceKey] = snapshotPrice;
					}
					result.processed += 1;
					continue;
				}
			}

			try {
				if (shouldRefreshOrderSummary) {
					const ordersResult = await fetchOrdersPayload(entry.slug, { rank });
					if (!ordersResult.data) {
						if (!ordersResult.transient) {
							const emptyPayload = {
								slug: entry.slug,
								rank,
								wts: null,
								wtb: null,
								timestamp: Date.now(),
							};
							await putOrderSummaryPayload(env, entry.slug, emptyPayload, rank);
							const snapshotKey = snapshotCacheKeyFromWorkerKey(orderSummaryKey);
							if (snapshotKey)
								snapshotOrderSummaries[snapshotKey] = {
									status: 'no_data',
									wts: null,
									wtb: null,
									timestamp: emptyPayload.timestamp,
								};
							result.updated += 1;
						} else {
							result.failures += 1;
						}
						result.processed += 1;
					} else {
						const payload = buildOrderSummaryPayload(entry.slug, rank, ordersResult.data);
						await putOrderSummaryPayload(env, entry.slug, payload, rank);
						const snapshotKey = snapshotCacheKeyFromWorkerKey(orderSummaryKey);
						if (snapshotKey)
							snapshotOrderSummaries[snapshotKey] = {
								status: payload.wts != null || payload.wtb != null ? 'ok' : 'no_data',
								wts: payload.wts ?? null,
								wtb: payload.wtb ?? null,
								timestamp: payload.timestamp,
							};
						result.updated += 1;
						result.processed += 1;
					}
				} else {
					result.processed += 1;
				}
			} catch {
				result.failures += 1;
				result.processed += 1;
			}

			// Also fetch and snapshot the ranked price (median) for this slug + rank.
			if (shouldRefreshPrice) {
				try {
					const snapshotPriceKey = snapshotCacheKeyFromWorkerKey(priceKey);
					if (!snapshotPriceKey) continue;
					const priceResult = await fetchPricePayload(entry.slug, { rank });
					if (priceResult.data) {
						await putPricePayload(env, entry.slug, priceResult.data, rank);
						snapshotPrices[snapshotPriceKey] = {
							status: 'ok',
							median: priceResult.data.median,
							timestamp: priceResult.data.timestamp,
						};
					} else if (priceResult.inactive) {
						await markPriceNoData(env, entry.slug, rank);
						snapshotPrices[snapshotPriceKey] = inactivePriceSnapshotEntry();
					}
				} catch {
					// Price fetch failure is non-fatal; order summary was already processed above.
				}
			}
		}
	}

	result.cursorAfter = (cursor + Math.min(batchSize, entries.length)) % entries.length;
	await env.ITEM_META.put(ORDER_SUMMARY_CATALOG_PREWARM_CURSOR_KEY, String(result.cursorAfter));
	await env.ITEM_META.put(ORDER_SUMMARY_CATALOG_PREWARM_LAST_RUN_KEY, JSON.stringify(result));

	// Incrementally patch the snapshot with order summaries and ranked prices written this batch.
	const snapshotPatch: Parameters<typeof patchSnapshot>[1] = {};
	if (Object.keys(snapshotOrderSummaries).length > 0) snapshotPatch.orderSummaries = snapshotOrderSummaries;
	if (Object.keys(snapshotPrices).length > 0) snapshotPatch.prices = snapshotPrices;
	if (Object.keys(snapshotPatch).length > 0) {
		await patchSnapshot(env, snapshotPatch);
	}

	return result;
}

export async function prewarmBatch(
	env: Env,
	options: {
		reason: 'manual' | 'cron';
		batchSize: number;
		refreshCatalog?: boolean;
		resetCursor?: boolean;
	},
): Promise<PrewarmResult> {
	const config = getWorkerConfig(env);
	const cronRefresh = options.reason === 'cron';
	const adminMaxBatch = config.adminPrewarmMaxBatch;
	const batchSize = clamp(options.batchSize, 1, adminMaxBatch);
	const slugs = await fetchCatalogSlugs(env, Boolean(options.refreshCatalog));

	const now = Date.now();
	const emptyResult: PrewarmResult = {
		ok: true,
		reason: options.reason,
		timestamp: now,
		batchSize,
		cursorBefore: 0,
		cursorAfter: 0,
		totalCatalogSlugs: slugs.length,
		priceUpdated: 0,
		metaUpdated: 0,
		processed: 0,
		skippedUntradable: 0,
		failures: 0,
	};

	if (slugs.length === 0) {
		await env.PRICE_CACHE.put(PREWARM_LAST_RUN_KEY, JSON.stringify(emptyResult));
		return emptyResult;
	}

	let cursor = 0;
	if (!options.resetCursor) {
		const cursorRaw = await env.PRICE_CACHE.get(PREWARM_CURSOR_KEY);
		cursor = Number.isFinite(Number(cursorRaw)) ? Number(cursorRaw) : 0;
	}
	cursor = ((cursor % slugs.length) + slugs.length) % slugs.length;

	const result: PrewarmResult = {
		...emptyResult,
		cursorBefore: cursor,
	};

	// Collect entries to patch into the snapshot after the batch completes.
	const snapshotPrices: Record<string, unknown> = {};
	const snapshotMeta: Record<string, unknown> = {};

	for (let i = 0; i < batchSize; i += 1) {
		const index = (cursor + i) % slugs.length;
		const slug = slugs[index];

		try {
			const skipMarker = await env.ITEM_META.get(`${SKIP_UNTRADABLE_PREFIX}${slug}`);
			if (skipMarker) {
				result.skippedUntradable += 1;
				result.processed += 1;
				continue;
			}

			let shouldRefreshMeta = true;
			let shouldRefreshPrice = true;
			if (cronRefresh) {
				const [cachedMeta, cachedPrice] = await Promise.all([
					getJsonFromKv(env.ITEM_META, `meta:${slug}`),
					getJsonFromKv(env.PRICE_CACHE, workerPriceCacheKey(slug, null)),
				]);
				shouldRefreshMeta = isDueForRefresh(cachedMeta, config.staleRefreshSec);
				shouldRefreshPrice = isDueForRefresh(cachedPrice, config.staleRefreshSec);
				if (!shouldRefreshMeta && !shouldRefreshPrice) {
					result.processed += 1;
					continue;
				}
			}

			if (shouldRefreshMeta) {
				const metaResult = await fetchMetaPayload(slug);
				if (!metaResult.data) {
					result.failures += 1;
					continue;
				}

				if (!metaResult.data.tradable) {
					await markUntradable(env, slug);
					result.skippedUntradable += 1;
					result.processed += 1;
					continue;
				}

				await putMetaPayload(env, metaResult.data);
				result.metaUpdated += 1;
				snapshotMeta[slug] = metaResult.data;
			}

			if (shouldRefreshPrice) {
				const priceResult = await fetchPricePayload(slug);
				if (priceResult.data) {
					await putPricePayload(env, slug, priceResult.data);
					result.priceUpdated += 1;
					snapshotPrices[slug] = { status: 'ok', median: priceResult.data.median, timestamp: priceResult.data.timestamp };
				} else if (priceResult.inactive) {
					await markPriceNoData(env, slug);
					snapshotPrices[slug] = inactivePriceSnapshotEntry();
				}
			}

			result.processed += 1;
		} catch {
			result.failures += 1;
		}
	}

	result.cursorAfter = (cursor + batchSize) % slugs.length;

	await env.PRICE_CACHE.put(PREWARM_CURSOR_KEY, String(result.cursorAfter));
	await env.PRICE_CACHE.put(PREWARM_LAST_RUN_KEY, JSON.stringify(result));

	// Incrementally patch the snapshot with items written this batch.
	// This means after a full catalog walk the snapshot contains all items — no
	// per-invocation subrequest cap applies here since we only do 1 read + 1 write.
	if (Object.keys(snapshotPrices).length > 0 || Object.keys(snapshotMeta).length > 0) {
		await patchSnapshot(env, { prices: snapshotPrices, meta: snapshotMeta });
	}

	return result;
}

/**
 * Merge new prices, meta, and/or orderSummaries entries into the persisted snapshot blob.
 * Costs 1 KV read + 1 KV write regardless of how many entries are merged, so it is safe
 * to call at the end of every prewarm batch without approaching the subrequest limit.
 */
async function patchSnapshot(
	env: Env,
	patches: {
		prices?: Record<string, unknown>;
		meta?: Record<string, unknown>;
		orderSummaries?: Record<string, unknown>;
	},
): Promise<void> {
	const ttlSec = orderSummaryCacheTtlSec(env);
	const raw = await env.PRICE_CACHE.get(SNAPSHOT_KEY);
	let snapshot: {
		version: number;
		generatedAt: number;
		prices: Record<string, unknown>;
		meta: Record<string, unknown>;
		orderSummaries: Record<string, unknown>;
	};
	try {
		snapshot = raw ? JSON.parse(raw) : { version: 1, generatedAt: 0, prices: {}, meta: {}, orderSummaries: {} };
	} catch {
		snapshot = { version: 1, generatedAt: 0, prices: {}, meta: {}, orderSummaries: {} };
	}

	if (patches.prices) Object.assign(snapshot.prices, patches.prices);
	if (patches.meta) Object.assign(snapshot.meta, patches.meta);
	if (patches.orderSummaries) Object.assign(snapshot.orderSummaries, patches.orderSummaries);
	snapshot.generatedAt = Date.now();
	snapshot = sanitizeSnapshotForClient(snapshot);
	const etag = `"${snapshot.generatedAt}"`;

	await env.PRICE_CACHE.put(SNAPSHOT_KEY, JSON.stringify(snapshot), { expirationTtl: ttlSec });
	await env.PRICE_CACHE.put(SNAPSHOT_LAST_GEN_KEY, String(snapshot.generatedAt));
	await env.PRICE_CACHE.put(SNAPSHOT_ETAG_KEY, etag);
}
