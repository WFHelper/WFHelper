import { CATALOG_CACHE_KEY, PREWARM_CURSOR_KEY, PREWARM_LAST_RUN_KEY, SKIP_UNTRADABLE_PREFIX, SLUG_RE, WFM_HEADERS } from '../constants';
import type { Env, MetaPayload, PrewarmResult } from '../types';
import { clamp, getJsonFromKv, parsePositiveInt } from '../utils';

const UNTRADABLE_SKIP_TTL_SEC = 30 * 24 * 60 * 60;

export function cacheTtlSec(env: Env): number {
	return clamp(parsePositiveInt(env.CACHE_TTL_SEC, 43200), 60, 604800);
}

function extractMedian(jsonPayload: unknown): number | null {
	const payload = (jsonPayload as { payload?: Record<string, unknown> })?.payload;
	if (!payload) return null;

	const closed = (payload.statistics_closed || {}) as Record<string, unknown>;
	const live = (payload.statistics_live || {}) as Record<string, unknown>;
	const closedRows = (closed['48hours'] as Record<string, unknown>[]) || (closed['48_hours'] as Record<string, unknown>[]) || [];
	const liveRows = (live['48hours'] as Record<string, unknown>[]) || (live['48_hours'] as Record<string, unknown>[]) || [];

	const rows = [...closedRows, ...liveRows]
		.filter((row) => !row.order_type || row.order_type === 'sell')
		.sort((a, b) => new Date(String(a.datetime || 0)).getTime() - new Date(String(b.datetime || 0)).getTime());

	const latest = rows.length > 0 ? rows[rows.length - 1] : undefined;
	if (!latest) return null;

	const raw = latest.median ?? latest.moving_avg ?? latest.wa_price ?? latest.avg_price ?? latest.min_price;
	if (raw == null) return null;

	const value = Math.round(Math.abs(Number(raw)));
	return Number.isFinite(value) && value > 0 ? value : null;
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

export async function fetchPricePayload(slug: string): Promise<{ median: number; timestamp: number } | null> {
	const response = await fetch(`https://api.warframe.market/v1/items/${slug}/statistics`, {
		headers: WFM_HEADERS,
	});
	if (!response.ok) return null;

	const payload = await response.json();
	const median = extractMedian(payload);
	if (median == null) return null;

	return {
		median,
		timestamp: Date.now(),
	};
}

function normalizeAssetPath(pathValue: unknown): string | null {
	if (typeof pathValue !== 'string' || !pathValue.trim()) return null;
	return pathValue.startsWith('http') ? pathValue : `https://warframe.market/static/assets/${pathValue}`;
}

export async function fetchMetaPayload(slug: string): Promise<MetaPayload | null> {
	const response = await fetch(`https://api.warframe.market/v2/items/${slug}`, {
		headers: WFM_HEADERS,
	});
	if (!response.ok) return null;

	const jsonPayload = (await response.json()) as { data?: Record<string, unknown> };
	const data = jsonPayload.data;
	if (!data || typeof data !== 'object') return null;

	const i18nEn = (data.i18n as { en?: Record<string, unknown> } | undefined)?.en || {};
	const ducatsRaw = data.ducats;
	const ducats = typeof ducatsRaw === 'number' && Number.isFinite(ducatsRaw) ? Math.max(0, Math.round(ducatsRaw)) : null;

	return {
		slug,
		tradable: data.tradable === true,
		thumb: normalizeAssetPath(i18nEn.thumb || data.thumb || null),
		icon: normalizeAssetPath(i18nEn.icon || data.icon || null),
		ducats,
		setRoot: Boolean(data.setRoot),
		timestamp: Date.now(),
	};
}

export async function putPricePayload(
	env: Env,
	slug: string,
	payload: { median: number; timestamp: number },
): Promise<Record<string, unknown>> {
	const data = {
		slug,
		median: payload.median,
		timestamp: payload.timestamp,
	};

	await env.PRICE_CACHE.put(`price:${slug}`, JSON.stringify(data), {
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

			const metaPayload = await fetchMetaPayload(slug);
			if (!metaPayload) {
				result.failures += 1;
				continue;
			}

			if (!metaPayload.tradable) {
				await markUntradable(env, slug);
				result.skippedUntradable += 1;
				result.processed += 1;
				continue;
			}

			await putMetaPayload(env, metaPayload);
			result.metaUpdated += 1;

			const pricePayload = await fetchPricePayload(slug);
			if (pricePayload) {
				await putPricePayload(env, slug, pricePayload);
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
