import { CATALOG_CACHE_KEY, ORDER_SUMMARY_CATALOG_KEY, SLUG_RE, WFM_HEADERS } from '../constants';
import type { Env, OrdersPayload, OrderSummaryCatalogEntry, OrderSummaryHotsetEntry } from '../types';
import { getWorkerConfig } from '../config';
import { getJsonFromKv } from '../utils';
import { normalizeRankFilter } from '../../../../config/shared/numeric';
import { isExcludedRankedMarketItem } from '../../../../config/shared/wfmExclusions';
import { cheapestOrderPrice } from '../../../../config/shared/wfmOrders';

const ORDER_SUMMARY_HOTSET_MAX_ENTRIES = 96;

export function cacheTtlSec(env: Env): number {
	return getWorkerConfig(env).cacheTtlSec;
}

export function orderSummaryCacheTtlSec(env: Env): number {
	return getWorkerConfig(env).orderSummaryCacheTtlSec;
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

export function sanitizeOrderSummaryHotsetEntries(value: unknown): OrderSummaryHotsetEntry[] {
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
	const refreshHours = getWorkerConfig(env).catalogRefreshHours;
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
	const refreshHours = getWorkerConfig(env).catalogRefreshHours;
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

export async function readRankedSummaryCatalogFromKv(env: Env): Promise<OrderSummaryCatalogEntry[]> {
	const cached = await getJsonFromKv(env.ITEM_META, ORDER_SUMMARY_CATALOG_KEY);
	return sanitizeOrderSummaryCatalogEntries(cached?.entries);
}
