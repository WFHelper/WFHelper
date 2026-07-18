import {
	ORDER_SUMMARY_CATALOG_KEY,
	ORDER_SUMMARY_CATALOG_PREWARM_LAST_RUN_KEY,
	ORDER_SUMMARY_HOTSET_KEY,
	ORDER_SUMMARY_PREWARM_LAST_RUN_KEY,
	PREWARM_LAST_RUN_KEY,
	SNAPSHOT_KEY,
} from '../constants';
import {
	fetchRankedSummaryCatalog,
	getOrderSummaryHotset,
	prewarmBatch,
	prewarmOrderSummaryCatalog,
	prewarmOrderSummaryHotset,
	saveOrderSummaryHotset,
	sanitizeOrderSummaryHotsetEntries,
} from '../services/prewarm';
import { getWorkerConfig } from '../config';
import { jsonResponse } from '../security/cors';
import { isAdminAuthorized } from '../security/adminAuth';
import { checkAdminRateLimit } from '../security/rateLimit';
import type { Env } from '../types';
import { getJsonFromKv, parseJsonBody, parsePositiveInt } from '../utils';

async function guardAdmin(req: Request, env: Env): Promise<Response | null> {
	const rateLimited = await checkAdminRateLimit(req, env);
	if (rateLimited) return rateLimited;
	if (!(await isAdminAuthorized(req, env))) {
		return jsonResponse({ ok: false, error: 'unauthorized' }, req, env, 401);
	}
	return null;
}

export async function handleAdminRoutes(req: Request, url: URL, env: Env): Promise<Response | null> {
	if (req.method === 'POST' && url.pathname === '/admin/prewarm') {
		const guardResponse = await guardAdmin(req, env);
		if (guardResponse) return guardResponse;

		const body = parseJsonBody(await req.text());
		const config = getWorkerConfig(env);
		const result = await prewarmBatch(env, {
			reason: 'manual',
			batchSize: parsePositiveInt(String(body.batchSize || ''), config.prewarmBatchSize),
			resetCursor: Boolean(body.resetCursor),
			refreshCatalog: Boolean(body.refreshCatalog),
		});

		return jsonResponse({ ok: true, result }, req, env, 202);
	}

	if (req.method === 'GET' && url.pathname === '/admin/prewarm/status') {
		const guardResponse = await guardAdmin(req, env);
		if (guardResponse) return guardResponse;

		const result = await getJsonFromKv(env.PRICE_CACHE, PREWARM_LAST_RUN_KEY);
		return jsonResponse({ ok: true, result }, req, env, 200);
	}

	if (req.method === 'POST' && url.pathname === '/admin/order-summary-hotset') {
		const guardResponse = await guardAdmin(req, env);
		if (guardResponse) return guardResponse;

		const body = parseJsonBody(await req.text());
		const nextEntries = sanitizeOrderSummaryHotsetEntries(body.entries);
		const replace = body.replace === true;
		const current = replace ? [] : await getOrderSummaryHotset(env);
		const saved = await saveOrderSummaryHotset(env, [...current, ...nextEntries]);

		return jsonResponse({ ok: true, result: { total: saved.length, entries: saved } }, req, env, 200);
	}

	if (req.method === 'GET' && url.pathname === '/admin/order-summary-hotset') {
		const guardResponse = await guardAdmin(req, env);
		if (guardResponse) return guardResponse;

		const hotset = await getJsonFromKv(env.PRICE_CACHE, ORDER_SUMMARY_HOTSET_KEY);
		return jsonResponse({ ok: true, result: hotset }, req, env, 200);
	}

	if (req.method === 'GET' && url.pathname === '/admin/order-summary-catalog') {
		const guardResponse = await guardAdmin(req, env);
		if (guardResponse) return guardResponse;

		const refreshCatalog = url.searchParams.get('refresh') === '1';
		const entries = await fetchRankedSummaryCatalog(env, refreshCatalog);
		const cached = await getJsonFromKv(env.ITEM_META, ORDER_SUMMARY_CATALOG_KEY);
		return jsonResponse(
			{ ok: true, result: { updatedAt: cached?.updatedAt ?? Date.now(), total: entries.length, entries } },
			req,
			env,
			200,
		);
	}

	if (req.method === 'POST' && url.pathname === '/admin/prewarm/order-summaries') {
		const guardResponse = await guardAdmin(req, env);
		if (guardResponse) return guardResponse;

		const body = parseJsonBody(await req.text());
		const config = getWorkerConfig(env);
		const source = body.source === 'hotset' ? 'hotset' : 'catalog';
		const batchSize = parsePositiveInt(String(body.batchSize || ''), config.orderSummaryPrewarmBatchSize);
		const result =
			source === 'hotset'
				? await prewarmOrderSummaryHotset(env, {
						reason: 'manual',
						batchSize,
						entries: sanitizeOrderSummaryHotsetEntries(body.entries),
						resetCursor: body.resetCursor === true,
					})
				: await prewarmOrderSummaryCatalog(env, {
						reason: 'manual',
						batchSize,
						refreshCatalog: body.refreshCatalog === true,
						resetCursor: body.resetCursor === true,
					});

		return jsonResponse({ ok: true, result }, req, env, 202);
	}

	if (req.method === 'GET' && url.pathname === '/admin/prewarm/order-summaries/status') {
		const guardResponse = await guardAdmin(req, env);
		if (guardResponse) return guardResponse;

		const source = url.searchParams.get('source') === 'hotset' ? 'hotset' : 'catalog';
		const result =
			source === 'hotset'
				? await getJsonFromKv(env.PRICE_CACHE, ORDER_SUMMARY_PREWARM_LAST_RUN_KEY)
				: await getJsonFromKv(env.ITEM_META, ORDER_SUMMARY_CATALOG_PREWARM_LAST_RUN_KEY);
		return jsonResponse({ ok: true, result }, req, env, 200);
	}

	if (req.method === 'GET' && url.pathname === '/admin/snapshot/status') {
		const guardResponse = await guardAdmin(req, env);
		if (guardResponse) return guardResponse;

		const raw = await env.PRICE_CACHE.get(SNAPSHOT_KEY);
		let generatedAt: number | null = null;
		try {
			const value = raw ? (JSON.parse(raw) as { generatedAt?: unknown }) : null;
			generatedAt = typeof value?.generatedAt === 'number' && Number.isFinite(value.generatedAt) ? value.generatedAt : null;
		} catch {
			// Malformed snapshots have no usable generation time.
		}
		return jsonResponse({ ok: true, result: { generatedAt } }, req, env, 200);
	}

	return null;
}
