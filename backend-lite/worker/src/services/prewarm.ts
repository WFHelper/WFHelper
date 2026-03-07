import { CATALOG_CACHE_KEY, PREWARM_CURSOR_KEY, PREWARM_LAST_RUN_KEY, SKIP_UNTRADABLE_PREFIX, SLUG_RE, WFM_HEADERS } from '../constants';
import type { Env, MetaPayload, OrdersPayload, PrewarmResult } from '../types';
import { clamp, getJsonFromKv, parsePositiveInt } from '../utils';
import wfmStatsShared from '../../../../config/shared/wfmStats.cjs';
import sharedNumeric from '../../../../config/shared/numeric.cjs';

const UNTRADABLE_SKIP_TTL_SEC = 30 * 24 * 60 * 60;

type SharedWfmStatsModule = {
	extractMedianFromStatsPayload: (jsonPayload: unknown, options?: { rank?: number | null }) => number | null;
};

const { extractMedianFromStatsPayload } = wfmStatsShared as SharedWfmStatsModule;
const { normalizeRankFilter } = sharedNumeric as {
	normalizeRankFilter: (value: unknown) => number | null;
};

export function cacheTtlSec(env: Env): number {
	return clamp(parsePositiveInt(env.CACHE_TTL_SEC, 43200), 60, 604800);
}

function sanitizeSlugList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === 'string' && SLUG_RE.test(entry));
}

export async function fetchCatalogSlugs(env: Env, forceRefresh: boolean): Promise<string[]> {
	const refreshHours = clamp(parsePositiveInt(env.CATALOG_REFRESH_HOURS, 24), 1, 168);
	const refreshMs = refreshHours * 60 * 60 * 1000;

	if (!forceRefresh) {
		const cached = await getJsonFromKv(env.ITEM_META, CATALOG_CACHE_KEY);
		const updatedAt = Number(cached?.updatedAt || 0);
		const slugs = sanitizeSlugList(cached?.slugs);
		if (Date.now() - updatedAt < refreshMs && slugs.length > 0) {
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

	const jsonPayload = (await response.json()) as {
		data?: { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
	};
	const list = Array.isArray(jsonPayload?.data) ? jsonPayload.data : Array.isArray(jsonPayload?.data?.items) ? jsonPayload.data.items : [];

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

	await env.ITEM_META.put(
		CATALOG_CACHE_KEY,
		JSON.stringify({
			updatedAt: Date.now(),
			slugs,
		}),
		{
			expirationTtl: refreshHours * 60 * 60,
		},
	);

	return slugs;
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

export async function markUntradable(env: Env, slug: string): Promise<void> {
	await env.ITEM_META.put(`${SKIP_UNTRADABLE_PREFIX}${slug}`, '1', {
		expirationTtl: UNTRADABLE_SKIP_TTL_SEC,
	});
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

			const priceResult = await fetchPricePayload(slug);
			if (priceResult.data) {
				await putPricePayload(env, slug, priceResult.data);
				result.priceUpdated += 1;
			}

			result.processed += 1;
		} catch {
			result.failures += 1;
		}
	}

	result.cursorAfter = (cursor + batchSize) % slugs.length;

	await env.PRICE_CACHE.put(PREWARM_CURSOR_KEY, String(result.cursorAfter));
	await env.PRICE_CACHE.put(PREWARM_LAST_RUN_KEY, JSON.stringify(result));

	return result;
}

export const __test__ = {
	extractMedianFromStatsPayload,
} as const;
