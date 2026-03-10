import { ORDER_SUMMARY_HOTSET_KEY, ORDER_SUMMARY_PREWARM_LAST_RUN_KEY, PREWARM_LAST_RUN_KEY } from '../constants';
import { getOrderSummaryHotset, prewarmBatch, prewarmOrderSummaryHotset, saveOrderSummaryHotset } from '../services/prewarm';
import { jsonResponse } from '../security/cors';
import { checkAdminRateLimit } from '../security/rateLimit';
import type { Env } from '../types';
import { getJsonFromKv, parseJsonBody, parsePositiveInt } from '../utils';
import sharedNumeric from '../../../../config/shared/numeric.cjs';

const { normalizeRankFilter } = sharedNumeric as {
	normalizeRankFilter: (value: unknown) => number | null;
};

function parseHotsetEntries(value: unknown): Array<{ slug: string; maxRank: number; lastSeenAt: number }> {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => {
			if (!entry || typeof entry !== 'object') return null;
			const row = entry as Record<string, unknown>;
			const slug = typeof row.slug === 'string' ? row.slug.trim().toLowerCase() : '';
			const maxRank = normalizeRankFilter(row.maxRank);
			const lastSeenAt = Number(row.lastSeenAt || Date.now());
			if (!slug || maxRank == null || maxRank <= 0) return null;
			return {
				slug,
				maxRank,
				lastSeenAt: Number.isFinite(lastSeenAt) && lastSeenAt > 0 ? Math.round(lastSeenAt) : Date.now(),
			};
		})
		.filter((entry): entry is { slug: string; maxRank: number; lastSeenAt: number } => entry != null);
}

function isAdminAuthorized(req: Request, env: Env): boolean {
	const auth = req.headers.get('authorization') || '';
	return Boolean(env.ADMIN_API_KEY) && auth === `Bearer ${env.ADMIN_API_KEY}`;
}

export async function handleAdminRoutes(req: Request, url: URL, env: Env): Promise<Response | null> {
	if (req.method === 'POST' && url.pathname === '/admin/prewarm') {
		const rateLimited = await checkAdminRateLimit(req, env);
		if (rateLimited) return rateLimited;

		if (!isAdminAuthorized(req, env)) {
			return jsonResponse({ ok: false, error: 'unauthorized' }, req, env, 401);
		}

		const body = parseJsonBody(await req.text());
		const result = await prewarmBatch(env, {
			reason: 'manual',
			batchSize: parsePositiveInt(String(body.batchSize || ''), parsePositiveInt(env.PREWARM_BATCH_SIZE, 8)),
			resetCursor: Boolean(body.resetCursor),
			refreshCatalog: Boolean(body.refreshCatalog),
		});

		return jsonResponse({ ok: true, result }, req, env, 202);
	}

	if (req.method === 'GET' && url.pathname === '/admin/prewarm/status') {
		if (!isAdminAuthorized(req, env)) {
			return jsonResponse({ ok: false, error: 'unauthorized' }, req, env, 401);
		}

		const result = await getJsonFromKv(env.PRICE_CACHE, PREWARM_LAST_RUN_KEY);
		return jsonResponse({ ok: true, result }, req, env, 200);
	}

	if (req.method === 'POST' && url.pathname === '/admin/order-summary-hotset') {
		const rateLimited = await checkAdminRateLimit(req, env);
		if (rateLimited) return rateLimited;

		if (!isAdminAuthorized(req, env)) {
			return jsonResponse({ ok: false, error: 'unauthorized' }, req, env, 401);
		}

		const body = parseJsonBody(await req.text());
		const nextEntries = parseHotsetEntries(body.entries);
		const replace = body.replace === true;
		const current = replace ? [] : await getOrderSummaryHotset(env);
		const saved = await saveOrderSummaryHotset(env, [...current, ...nextEntries]);

		return jsonResponse({ ok: true, result: { total: saved.length, entries: saved } }, req, env, 200);
	}

	if (req.method === 'GET' && url.pathname === '/admin/order-summary-hotset') {
		if (!isAdminAuthorized(req, env)) {
			return jsonResponse({ ok: false, error: 'unauthorized' }, req, env, 401);
		}

		const hotset = await getJsonFromKv(env.PRICE_CACHE, ORDER_SUMMARY_HOTSET_KEY);
		return jsonResponse({ ok: true, result: hotset }, req, env, 200);
	}

	if (req.method === 'POST' && url.pathname === '/admin/prewarm/order-summaries') {
		const rateLimited = await checkAdminRateLimit(req, env);
		if (rateLimited) return rateLimited;

		if (!isAdminAuthorized(req, env)) {
			return jsonResponse({ ok: false, error: 'unauthorized' }, req, env, 401);
		}

		const body = parseJsonBody(await req.text());
		const result = await prewarmOrderSummaryHotset(env, {
			reason: 'manual',
			batchSize: parsePositiveInt(String(body.batchSize || ''), parsePositiveInt(env.ORDER_SUMMARY_PREWARM_BATCH_SIZE, 12)),
			entries: parseHotsetEntries(body.entries),
		});

		return jsonResponse({ ok: true, result }, req, env, 202);
	}

	if (req.method === 'GET' && url.pathname === '/admin/prewarm/order-summaries/status') {
		if (!isAdminAuthorized(req, env)) {
			return jsonResponse({ ok: false, error: 'unauthorized' }, req, env, 401);
		}

		const result = await getJsonFromKv(env.PRICE_CACHE, ORDER_SUMMARY_PREWARM_LAST_RUN_KEY);
		return jsonResponse({ ok: true, result }, req, env, 200);
	}

	return null;
}
