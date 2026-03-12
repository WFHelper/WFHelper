import {
	CATALOG_CACHE_KEY,
	ORDER_SUMMARY_CATALOG_KEY,
	ORDER_SUMMARY_CATALOG_PREWARM_CURSOR_KEY,
	ORDER_SUMMARY_CATALOG_PREWARM_LAST_RUN_KEY,
	ORDER_SUMMARY_HOTSET_KEY,
	ORDER_SUMMARY_PREWARM_CURSOR_KEY,
	ORDER_SUMMARY_PREWARM_LAST_RUN_KEY,
	PREWARM_CURSOR_KEY,
	PREWARM_LAST_RUN_KEY,
	SKIP_UNTRADABLE_PREFIX,
	SLUG_RE,
	SNAPSHOT_ETAG_KEY,
	SNAPSHOT_KEY,
	SNAPSHOT_LAST_GEN_KEY,
	WFM_HEADERS,
} from '../constants';
import type {
	Env,
	MetaPayload,
	OrdersPayload,
	OrderSummaryCatalogEntry,
	OrderSummaryHotsetEntry,
	OrderSummaryPrewarmResult,
	PrewarmResult,
} from '../types';
import { clamp, getJsonFromKv, parsePositiveInt } from '../utils';
import wfmStatsShared from '../../../../config/shared/wfmStats.cjs';
import sharedNumeric from '../../../../config/shared/numeric.cjs';
import wfmExclusionsShared from '../../../../config/shared/wfmExclusions.cjs';

const UNTRADABLE_SKIP_TTL_SEC = 30 * 24 * 60 * 60;
const ORDER_SUMMARY_HOTSET_MAX_ENTRIES = 96;

type SharedWfmStatsModule = {
	extractMedianFromStatsPayload: (jsonPayload: unknown, options?: { rank?: number | null }) => number | null;
};

const { extractMedianFromStatsPayload } = wfmStatsShared as SharedWfmStatsModule;
const { normalizeRankFilter } = sharedNumeric as {
	normalizeRankFilter: (value: unknown) => number | null;
};
const { isExcludedRankedMarketItem } = wfmExclusionsShared as {
	isExcludedRankedMarketItem: (name: string | null | undefined, slug: string | null | undefined) => boolean;
};

export function cacheTtlSec(env: Env): number {
	return clamp(parsePositiveInt(env.CACHE_TTL_SEC, 43200), 60, 604800);
}

export function orderSummaryCacheTtlSec(env: Env): number {
	return clamp(parsePositiveInt(env.ORDERS_SUMMARY_CACHE_TTL_SEC, 172800), 300, 604800);
}

function sanitizeSlugList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === 'string' && SLUG_RE.test(entry));
}

function normalizeCatalogList(value: unknown): Array<Record<string, unknown>> {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
	}
	if (typeof value !== 'object') return [];
	const obj = value as {
		data?: { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
		payload?: { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
	};
	if (Array.isArray(obj.data)) return normalizeCatalogList(obj.data);
	if (Array.isArray(obj.payload)) return normalizeCatalogList(obj.payload);
	if (obj.data && typeof obj.data === 'object' && Array.isArray((obj.data as { items?: unknown }).items)) {
		return normalizeCatalogList((obj.data as { items?: unknown }).items);
	}
	if (obj.payload && typeof obj.payload === 'object' && Array.isArray((obj.payload as { items?: unknown }).items)) {
		return normalizeCatalogList((obj.payload as { items?: unknown }).items);
	}
	return [];
}

function normalizeCatalogSlug(item: Record<string, unknown>): string {
	const slug = typeof item.slug === 'string' ? item.slug : typeof item.url_name === 'string' ? item.url_name : '';
	return slug.trim().toLowerCase();
}

function normalizeCatalogMaxRank(item: Record<string, unknown>): number | null {
	const rawMaxRank = Number(item.maxRank ?? item.max_rank ?? null);
	return Number.isFinite(rawMaxRank) && rawMaxRank > 0 ? Math.floor(rawMaxRank) : null;
}

function sanitizeOrderSummaryCatalogEntries(value: unknown): OrderSummaryCatalogEntry[] {
	if (!Array.isArray(value)) return [];
	const entries = value
		.map((entry) => {
			if (!entry || typeof entry !== 'object') return null;
			const row = entry as Record<string, unknown>;
			const slug = typeof row.slug === 'string' ? row.slug.trim().toLowerCase() : '';
			const maxRank = normalizeRankFilter(row.maxRank);
			if (!SLUG_RE.test(slug)) return null;
			if (maxRank == null || maxRank <= 0) return null;
			if (isExcludedRankedMarketItem(null, slug)) return null;
			return { slug, maxRank };
		})
		.filter((entry): entry is OrderSummaryCatalogEntry => entry != null)
		.sort((a, b) => a.slug.localeCompare(b.slug));

	const deduped: OrderSummaryCatalogEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.slug)) continue;
		seen.add(entry.slug);
		deduped.push(entry);
	}
	return deduped;
}

function buildRankedSummaryCatalog(items: Array<Record<string, unknown>>): OrderSummaryCatalogEntry[] {
	return sanitizeOrderSummaryCatalogEntries(
		items.map((item) => ({
			slug: normalizeCatalogSlug(item),
			maxRank: normalizeCatalogMaxRank(item),
		})),
	);
}

function sanitizeOrderSummaryHotsetEntries(value: unknown): OrderSummaryHotsetEntry[] {
	if (!Array.isArray(value)) return [];

	const entries = value
		.map((entry) => {
			if (!entry || typeof entry !== 'object') return null;
			const row = entry as Record<string, unknown>;
			const slug = typeof row.slug === 'string' ? row.slug.trim().toLowerCase() : '';
			const maxRank = normalizeRankFilter(row.maxRank);
			const lastSeenAt = Number(row.lastSeenAt || 0);
			if (!SLUG_RE.test(slug)) return null;
			if (maxRank == null || maxRank <= 0) return null;
			if (isExcludedRankedMarketItem(null, slug)) return null;
			if (!Number.isFinite(lastSeenAt) || lastSeenAt <= 0) return null;
			return {
				slug,
				maxRank,
				lastSeenAt: Math.round(lastSeenAt),
			};
		})
		.filter((entry): entry is OrderSummaryHotsetEntry => entry != null)
		.sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.slug.localeCompare(b.slug));

	const deduped: OrderSummaryHotsetEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.slug)) continue;
		seen.add(entry.slug);
		deduped.push(entry);
		if (deduped.length >= ORDER_SUMMARY_HOTSET_MAX_ENTRIES) break;
	}

	return deduped;
}

function cheapestOrderPrice(entries: Array<{ platinum: number; status: string | null }>, activeOnly: boolean): number | null {
	const filtered = activeOnly ? entries.filter((entry) => entry.status === 'ingame' || entry.status === 'online') : entries;
	if (filtered.length === 0) return null;
	return Math.min(...filtered.map((entry) => entry.platinum));
}

export function buildOrderSummaryPayload(slug: string, rank: number | null, payload: OrdersPayload): Record<string, unknown> {
	const sellActive = cheapestOrderPrice(payload.sell, true);
	const buyActive = cheapestOrderPrice(payload.buy, true);
	const sellAny = cheapestOrderPrice(payload.sell, false);
	const buyAny = cheapestOrderPrice(payload.buy, false);

	return {
		slug,
		rank,
		wts: sellActive ?? sellAny ?? null,
		wtb: buyActive ?? buyAny ?? null,
		timestamp: payload.timestamp,
	};
}

export async function fetchCatalogSlugs(env: Env, forceRefresh: boolean): Promise<string[]> {
	const refreshHours = clamp(parsePositiveInt(env.CATALOG_REFRESH_HOURS, 24), 1, 168);
	const refreshMs = refreshHours * 60 * 60 * 1000;

	if (!forceRefresh) {
		const cached = await getJsonFromKv(env.ITEM_META, CATALOG_CACHE_KEY);
		const updatedAt = Number(cached?.updatedAt || 0);
		const slugs = sanitizeSlugList(cached?.slugs);
		const rankedCatalog = sanitizeOrderSummaryCatalogEntries(cached?.rankedSummaryCatalog);
		if (Date.now() - updatedAt < refreshMs && slugs.length > 0) {
			if (rankedCatalog.length > 0) {
				await env.ITEM_META.put(
					ORDER_SUMMARY_CATALOG_KEY,
					JSON.stringify({
						updatedAt,
						entries: rankedCatalog,
					}),
					{
						expirationTtl: refreshHours * 60 * 60,
					},
				);
			}
			return slugs;
		}
	}

	const response = await fetch('https://api.warframe.market/v2/items', {
		headers: WFM_HEADERS,
	});
	if (!response.ok) {
		const fallback = await getJsonFromKv(env.ITEM_META, CATALOG_CACHE_KEY);
		return sanitizeSlugList(fallback?.slugs);
	}

	const jsonPayload = await response.json();
	const list = normalizeCatalogList(jsonPayload);

	const slugs = Array.from(
		new Set(
			list
				.map((item) => {
					const slug = typeof item.slug === 'string' ? item.slug : typeof item.url_name === 'string' ? item.url_name : '';
					return slug.toLowerCase();
				})
				.filter((slug) => SLUG_RE.test(slug)),
		),
	);
	const rankedSummaryCatalog = buildRankedSummaryCatalog(list);

	await env.ITEM_META.put(
		CATALOG_CACHE_KEY,
		JSON.stringify({
			updatedAt: Date.now(),
			slugs,
			rankedSummaryCatalog,
		}),
		{
			expirationTtl: refreshHours * 60 * 60,
		},
	);

	await env.ITEM_META.put(
		ORDER_SUMMARY_CATALOG_KEY,
		JSON.stringify({
			updatedAt: Date.now(),
			entries: rankedSummaryCatalog,
		}),
		{
			expirationTtl: refreshHours * 60 * 60,
		},
	);

	return slugs;
}

export async function fetchRankedSummaryCatalog(env: Env, forceRefresh: boolean): Promise<OrderSummaryCatalogEntry[]> {
	const refreshHours = clamp(parsePositiveInt(env.CATALOG_REFRESH_HOURS, 24), 1, 168);
	const refreshMs = refreshHours * 60 * 60 * 1000;

	if (!forceRefresh) {
		const cached = await getJsonFromKv(env.ITEM_META, ORDER_SUMMARY_CATALOG_KEY);
		const updatedAt = Number(cached?.updatedAt || 0);
		const entries = sanitizeOrderSummaryCatalogEntries(cached?.entries);
		if (Date.now() - updatedAt < refreshMs && entries.length > 0) {
			return entries;
		}
	}

	await fetchCatalogSlugs(env, true);
	const refreshed = await getJsonFromKv(env.ITEM_META, ORDER_SUMMARY_CATALOG_KEY);
	return sanitizeOrderSummaryCatalogEntries(refreshed?.entries);
}

export interface FetchResult<T> {
	data: T | null;
	/** true when the failure is transient (429/5xx) — do NOT negatively cache. */
	transient: boolean;
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
	const median = extractMedianFromStatsPayload(payload, targetRank != null ? { rank: targetRank } : undefined);
	if (median == null) return { data: null, transient: false };

	return {
		data: { median, timestamp: Date.now() },
		transient: false,
	};
}

function normalizeAssetPath(pathValue: unknown): string | null {
	if (typeof pathValue !== 'string' || !pathValue.trim()) return null;
	return pathValue.startsWith('http') ? pathValue : `https://warframe.market/static/assets/${pathValue}`;
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
	const ducatsRaw = data.ducats;
	const ducats = typeof ducatsRaw === 'number' && Number.isFinite(ducatsRaw) ? Math.max(0, Math.round(ducatsRaw)) : null;

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

const ORDERBOOK_MAX_ENTRIES_PER_SIDE = 500;

function parseOrderType(order: Record<string, unknown>): 'sell' | 'buy' | null {
	const typeV1 = typeof order.order_type === 'string' ? order.order_type.toLowerCase() : '';
	if (typeV1 === 'sell' || typeV1 === 'buy') return typeV1;
	const typeV2 = typeof order.type === 'string' ? order.type.toLowerCase() : '';
	if (typeV2 === 'sell' || typeV2 === 'buy') return typeV2;
	return null;
}

function parseOrderUserName(order: Record<string, unknown>): string {
	const user = order.user as Record<string, unknown> | undefined;
	if (!user) return '';
	const nameV1 = typeof user.ingame_name === 'string' ? user.ingame_name.trim() : '';
	if (nameV1) return nameV1;
	const nameV2 = typeof user.ingameName === 'string' ? user.ingameName.trim() : '';
	if (nameV2) return nameV2;
	return '';
}

function parseOrderStatus(order: Record<string, unknown>): string | null {
	const user = order.user as Record<string, unknown> | undefined;
	const statusRaw = typeof user?.status === 'string' ? user.status.toLowerCase() : null;
	return statusRaw;
}

function parseOrderRank(order: Record<string, unknown>): number | null {
	const rankRaw = typeof order.rank === 'number' ? order.rank : typeof order.mod_rank === 'number' ? order.mod_rank : null;
	if (rankRaw == null || !Number.isFinite(rankRaw) || rankRaw < 0) return null;
	return Math.floor(rankRaw);
}

function extractOrderList(payload: unknown): unknown[] | null {
	if (!payload || typeof payload !== 'object') return null;
	const jsonPayload = payload as {
		payload?: { orders?: unknown };
		data?: { orders?: unknown } | unknown[];
		orders?: unknown;
	};

	if (Array.isArray(jsonPayload.data)) return jsonPayload.data;
	if (Array.isArray(jsonPayload.payload?.orders)) return jsonPayload.payload.orders;
	if (jsonPayload.data && typeof jsonPayload.data === 'object') {
		const maybeData = jsonPayload.data as { orders?: unknown };
		if (Array.isArray(maybeData.orders)) return maybeData.orders;
	}
	if (Array.isArray(jsonPayload.orders)) return jsonPayload.orders;
	return null;
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
	const rawOrders = extractOrderList(jsonPayload);
	if (!rawOrders) return { data: null, transient: false };

	return { data: rawOrders, transient: false };
}

function toOrderBookSide(rawOrders: unknown, orderType: 'sell' | 'buy', rankFilter: number | null) {
	if (!Array.isArray(rawOrders)) return [];

	const entries = rawOrders
		.map((raw) => {
			if (!raw || typeof raw !== 'object') return null;
			const order = raw as Record<string, unknown>;

			const side = parseOrderType(order);
			if (side !== orderType) return null;

			if (order.visible === false) return null;

			const rank = parseOrderRank(order);
			if (rankFilter != null && rank !== rankFilter) return null;

			const userName = parseOrderUserName(order);
			if (!userName) return null;

			const statusRaw = parseOrderStatus(order);

			const platinumRaw = Number(order.platinum);
			if (!Number.isFinite(platinumRaw) || platinumRaw <= 0) return null;

			const quantityRaw = Number(order.quantity);
			const quantity = Number.isFinite(quantityRaw) && quantityRaw > 0 ? Math.floor(quantityRaw) : 1;

			return {
				userName,
				status: statusRaw,
				platinum: Math.round(platinumRaw),
				quantity,
				rank,
			};
		})
		.filter(
			(entry): entry is { userName: string; status: string | null; platinum: number; quantity: number; rank: number | null } =>
				entry != null,
		);

	entries.sort((a, b) => {
		if (a.platinum !== b.platinum) {
			return orderType === 'sell' ? a.platinum - b.platinum : b.platinum - a.platinum;
		}
		if (a.quantity !== b.quantity) {
			return b.quantity - a.quantity;
		}
		return a.userName.localeCompare(b.userName);
	});

	return entries.slice(0, ORDERBOOK_MAX_ENTRIES_PER_SIDE);
}

export async function fetchOrdersPayload(slug: string, options?: { rank?: number | null }): Promise<FetchResult<OrdersPayload>> {
	const targetRank = normalizeRankFilter(options?.rank);

	const v2Attempt = await fetchRawOrdersFromEndpoint(`https://api.warframe.market/v2/orders/item/${slug}`);
	if (v2Attempt.data) {
		return {
			data: {
				slug,
				sell: toOrderBookSide(v2Attempt.data, 'sell', targetRank),
				buy: toOrderBookSide(v2Attempt.data, 'buy', targetRank),
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
			sell: toOrderBookSide(v1Attempt.data, 'sell', targetRank),
			buy: toOrderBookSide(v1Attempt.data, 'buy', targetRank),
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

	const cacheKey = normalizedRank == null ? `price:${slug}` : `price:${slug}:r${normalizedRank}`;

	await env.PRICE_CACHE.put(cacheKey, JSON.stringify(data), {
		expirationTtl: cacheTtlSec(env),
	});

	return data;
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
	const cacheKey = normalizedRank == null ? `orders-summary:${slug}` : `orders-summary:${slug}:r${normalizedRank}`;

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
	const adminMaxBatch = clamp(parsePositiveInt(env.ADMIN_PREWARM_MAX_BATCH, 30), 1, 100);
	const defaultBatch = parsePositiveInt(env.ORDER_SUMMARY_PREWARM_BATCH_SIZE, 12);
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
	const adminMaxBatch = clamp(parsePositiveInt(env.ADMIN_PREWARM_MAX_BATCH, 30), 1, 100);
	const defaultBatch = parsePositiveInt(env.ORDER_SUMMARY_PREWARM_BATCH_SIZE, 12);
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
			try {
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
						snapshotOrderSummaries[`${entry.slug}:r${rank}`] = { status: 'no_data', wts: null, wtb: null, timestamp: emptyPayload.timestamp };
						result.updated += 1;
					} else {
						result.failures += 1;
					}
					result.processed += 1;
					continue;
				}

				const payload = buildOrderSummaryPayload(entry.slug, rank, ordersResult.data);
				await putOrderSummaryPayload(env, entry.slug, payload, rank);
				snapshotOrderSummaries[`${entry.slug}:r${rank}`] = {
					status: payload.wts != null || payload.wtb != null ? 'ok' : 'no_data',
					wts: payload.wts ?? null,
					wtb: payload.wtb ?? null,
					timestamp: payload.timestamp,
				};
				result.updated += 1;
				result.processed += 1;
			} catch {
				result.failures += 1;
				result.processed += 1;
			}

			// Also fetch and snapshot the ranked price (median) for this slug + rank.
			// The client needs these as `{slug}:rank-v3:r{rank}` keys in snapshot.prices.
			try {
				const priceResult = await fetchPricePayload(entry.slug, { rank });
				if (priceResult.data) {
					await putPricePayload(env, entry.slug, priceResult.data, rank);
					snapshotPrices[`${entry.slug}:rank-v3:r${rank}`] = {
						status: 'ok',
						median: priceResult.data.median,
						timestamp: priceResult.data.timestamp,
					};
				}
			} catch {
				// Price fetch failure is non-fatal; order summary was already processed above.
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
	const adminMaxBatch = clamp(parsePositiveInt(env.ADMIN_PREWARM_MAX_BATCH, 30), 1, 100);
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

			const priceResult = await fetchPricePayload(slug);
			if (priceResult.data) {
				const written = await putPricePayload(env, slug, priceResult.data);
				result.priceUpdated += 1;
				snapshotPrices[slug] = { status: 'ok', median: priceResult.data.median, timestamp: priceResult.data.timestamp };
				void written;
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
		snapshot = raw
			? JSON.parse(raw)
			: { version: 1, generatedAt: 0, prices: {}, meta: {}, orderSummaries: {} };
	} catch {
		snapshot = { version: 1, generatedAt: 0, prices: {}, meta: {}, orderSummaries: {} };
	}

	if (patches.prices) Object.assign(snapshot.prices, patches.prices);
	if (patches.meta) Object.assign(snapshot.meta, patches.meta);
	if (patches.orderSummaries) Object.assign(snapshot.orderSummaries, patches.orderSummaries);
	snapshot.generatedAt = Date.now();
	const etag = `"${snapshot.generatedAt}"`;

	await env.PRICE_CACHE.put(SNAPSHOT_KEY, JSON.stringify(snapshot), { expirationTtl: ttlSec });
	await env.PRICE_CACHE.put(SNAPSHOT_LAST_GEN_KEY, String(snapshot.generatedAt));
	await env.PRICE_CACHE.put(SNAPSHOT_ETAG_KEY, etag);
}

export const __test__ = {
	extractMedianFromStatsPayload,
} as const;
