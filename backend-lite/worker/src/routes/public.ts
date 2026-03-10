import { ORDER_SUMMARY_CATALOG_PREWARM_LAST_RUN_KEY, PREWARM_LAST_RUN_KEY } from '../constants';
import { jsonResponse } from '../security/cors';
import {
	getAutoCacheConfig,
	getAutoCacheStats,
	getOrHydrateMeta,
	getOrHydrateOrderSummary,
	getOrHydrateOrders,
	getOrHydratePrice,
} from '../services/readThrough';
import type { Env } from '../types';
import { getJsonFromKv, getSlug } from '../utils';
import sharedNumeric from '../../../../config/shared/numeric.cjs';

const { normalizeRankFilter } = sharedNumeric as {
	normalizeRankFilter: (value: unknown) => number | null;
};

const routeStats = {
	healthzRequests: 0,
	priceRequests: 0,
	metaRequests: 0,
	orderSummaryRequests: 0,
	ordersRequests: 0,
};

function parseRankFilter(url: URL): number | null {
	const rawRank = url.searchParams.get('rank');
	if (!rawRank) return null;
	return normalizeRankFilter(rawRank);
}

export async function handlePublicRoutes(req: Request, url: URL, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
	if (url.pathname === '/healthz' && req.method === 'GET') {
		routeStats.healthzRequests += 1;
		const prewarmState = await getJsonFromKv(env.PRICE_CACHE, PREWARM_LAST_RUN_KEY);
		const orderSummaryCatalogPrewarmState = await getJsonFromKv(env.ITEM_META, ORDER_SUMMARY_CATALOG_PREWARM_LAST_RUN_KEY);
		return jsonResponse(
			{
				ok: true,
				service: 'wf-backend-lite',
				ts: Date.now(),
				automation: {
					enabled: true,
					config: getAutoCacheConfig(env),
					stats: getAutoCacheStats(),
					routes: routeStats,
				},
				prewarm: prewarmState,
				orderSummaryCatalogPrewarm: orderSummaryCatalogPrewarmState,
			},
			req,
			env,
			200,
		);
	}

	const priceSlug = getSlug(url.pathname, '/v1/prices/');
	if (req.method === 'GET' && priceSlug) {
		routeStats.priceRequests += 1;
		const rank = parseRankFilter(url);
		const result = await getOrHydratePrice(env, priceSlug, ctx, rank);
		if (result.status === 'ok') return jsonResponse({ ok: true, data: result.data }, req, env, 200);
		if (result.status === 'unavailable') return jsonResponse({ ok: false, error: 'unavailable' }, req, env, 503);
		return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
	}

	const metaSlug = getSlug(url.pathname, '/v1/meta/');
	if (req.method === 'GET' && metaSlug) {
		routeStats.metaRequests += 1;
		const data = await getOrHydrateMeta(env, metaSlug, ctx);
		if (!data) return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
		return jsonResponse({ ok: true, data }, req, env, 200);
	}

	const orderSummarySlug = getSlug(url.pathname, '/v1/order-summary/');
	if (req.method === 'GET' && orderSummarySlug) {
		routeStats.orderSummaryRequests += 1;
		const rank = parseRankFilter(url);
		const result = await getOrHydrateOrderSummary(env, orderSummarySlug, ctx, rank);
		if (result.status === 'ok') return jsonResponse({ ok: true, data: result.data }, req, env, 200);
		if (result.status === 'unavailable') return jsonResponse({ ok: false, error: 'unavailable' }, req, env, 503);
		return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
	}

	const ordersSlug = getSlug(url.pathname, '/v1/orders/');
	if (req.method === 'GET' && ordersSlug) {
		routeStats.ordersRequests += 1;
		const rank = parseRankFilter(url);
		const result = await getOrHydrateOrders(env, ordersSlug, ctx, rank);
		if (result.status === 'ok') return jsonResponse({ ok: true, data: result.data }, req, env, 200);
		if (result.status === 'unavailable') return jsonResponse({ ok: false, error: 'unavailable' }, req, env, 503);
		return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
	}

	return null;
}
