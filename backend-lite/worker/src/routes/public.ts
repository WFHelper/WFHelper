import { ORDER_SUMMARY_CATALOG_KEY, ORDER_SUMMARY_CATALOG_PREWARM_LAST_RUN_KEY, PREWARM_LAST_RUN_KEY, SNAPSHOT_KEY } from '../constants';
import { jsonResponse } from '../security/cors';
import { isAdminAuthorized } from '../security/adminAuth';
import { bootstrapEnabled, bootstrapHeaderName, bootstrapRequired, issueBootstrapToken, verifyBootstrapToken } from '../security/bootstrap';
import { checkPublicRateLimit } from '../security/rateLimit';
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
	healthzAuthorizedRequests: 0,
	bootstrapRequests: 0,
	publicRateLimitedRequests: 0,
	bootstrapRejectedRequests: 0,
	invalidRankRequests: 0,
	deprecatedOrdersRequests: 0,
	snapshotRequests: 0,
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

async function getRankedCatalogBySlug(env: Env): Promise<Map<string, number>> {
	const cached = await getJsonFromKv(env.ITEM_META, ORDER_SUMMARY_CATALOG_KEY);
	const next = new Map<string, number>();
	const entries = Array.isArray(cached?.entries) ? cached.entries : [];
	for (const entry of entries) {
		if (!entry || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		const slug = typeof row.slug === 'string' ? row.slug.trim().toLowerCase() : '';
		const maxRank = normalizeRankFilter(row.maxRank);
		if (!slug || maxRank == null || maxRank <= 0) continue;
		next.set(slug, maxRank);
	}

	return next;
}

async function validateRankedSlugAndRank(
	env: Env,
	slug: string,
	rank: number | null,
	options?: { rankRequired?: boolean },
): Promise<{ ok: true; maxRank: number | null } | { ok: false }> {
	if (rank == null) {
		return options?.rankRequired ? { ok: false } : { ok: true, maxRank: null };
	}

	const rankedCatalog = await getRankedCatalogBySlug(env);
	if (rankedCatalog.size === 0) {
		return { ok: true, maxRank: null };
	}

	const maxRank = rankedCatalog.get(slug) ?? null;
	if (maxRank == null) return { ok: false };
	if (rank !== 0 && rank !== maxRank) return { ok: false };
	return { ok: true, maxRank };
}

async function requireBootstrapIfNeeded(req: Request, env: Env): Promise<boolean> {
	if (!bootstrapRequired(env)) return true;
	// If the secret hasn't been configured yet, the token can't be verified.
	// Pass through rather than blocking all traffic — this covers the deployment
	// window between setting PUBLIC_BOOTSTRAP_REQUIRED=1 and running
	// `wrangler secret put BOOTSTRAP_TOKEN_SECRET`.
	if (!bootstrapEnabled(env)) return true;
	return verifyBootstrapToken(req, env);
}

function publicOrdersRouteEnabled(env: Env): boolean {
	return (env.ENABLE_PUBLIC_ORDERS_ROUTE || '').trim() === '1';
}

export async function handlePublicRoutes(req: Request, url: URL, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
	if (url.pathname === '/healthz' && req.method === 'GET') {
		const rateLimited = await checkPublicRateLimit(req, env, 'healthz');
		if (rateLimited) {
			routeStats.publicRateLimitedRequests += 1;
			return rateLimited;
		}

		routeStats.healthzRequests += 1;
		if (!isAdminAuthorized(req, env)) {
			return jsonResponse(
				{
					ok: true,
					service: 'wf-backend-lite',
					ts: Date.now(),
				},
				req,
				env,
				200,
			);
		}

		routeStats.healthzAuthorizedRequests += 1;
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

	if (req.method === 'GET' && url.pathname === '/v1/bootstrap') {
		const rateLimited = await checkPublicRateLimit(req, env, 'bootstrap');
		if (rateLimited) {
			routeStats.publicRateLimitedRequests += 1;
			return rateLimited;
		}

		routeStats.bootstrapRequests += 1;
		if (!bootstrapEnabled(env)) {
			return jsonResponse({ ok: false, error: 'disabled' }, req, env, 404);
		}

		const issued = await issueBootstrapToken(req, env);
		if (!issued) {
			return jsonResponse({ ok: false, error: 'disabled' }, req, env, 404);
		}

		return jsonResponse(
			{
				ok: true,
				data: {
					token: issued.token,
					header: bootstrapHeaderName(),
					expiresAt: issued.expiresAt,
				},
			},
			req,
			env,
			200,
		);
	}

	if (req.method === 'GET' && url.pathname === '/v1/snapshot') {
		// No bootstrap requirement: snapshot is a CDN-cached bulk read of data that
		// is already publicly accessible via per-slug routes. It is fetched once at
		// client startup — before the bootstrap token flow has completed — so adding
		// bootstrap would create a chicken-and-egg failure. The 10/600s rate limit
		// on this route is the primary abuse control.
		const rateLimited = await checkPublicRateLimit(req, env, 'snapshot');
		if (rateLimited) {
			routeStats.publicRateLimitedRequests += 1;
			return rateLimited;
		}

		routeStats.snapshotRequests += 1;
		const raw = await env.PRICE_CACHE.get(SNAPSHOT_KEY);
		if (!raw) {
			return jsonResponse({ ok: false, error: 'snapshot_not_ready' }, req, env, 503);
		}

		return new Response(raw, {
			headers: {
				'content-type': 'application/json',
				'cache-control': 'public, max-age=7200',
			},
		});
	}

	const priceSlug = getSlug(url.pathname, '/v1/prices/');
	if (req.method === 'GET' && priceSlug) {
		const rateLimited = await checkPublicRateLimit(req, env, 'prices');
		if (rateLimited) {
			routeStats.publicRateLimitedRequests += 1;
			return rateLimited;
		}

		if (!(await requireBootstrapIfNeeded(req, env))) {
			routeStats.bootstrapRejectedRequests += 1;
			return jsonResponse({ ok: false, error: 'bootstrap_required' }, req, env, 401);
		}

		routeStats.priceRequests += 1;
		const rank = parseRankFilter(url);
		const validation = await validateRankedSlugAndRank(env, priceSlug, rank);
		if (!validation.ok) {
			routeStats.invalidRankRequests += 1;
			return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
		}

		const result = await getOrHydratePrice(env, priceSlug, ctx, rank);
		if (result.status === 'ok') return jsonResponse({ ok: true, data: result.data }, req, env, 200);
		if (result.status === 'unavailable') return jsonResponse({ ok: false, error: 'unavailable' }, req, env, 503);
		return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
	}

	const metaSlug = getSlug(url.pathname, '/v1/meta/');
	if (req.method === 'GET' && metaSlug) {
		const rateLimited = await checkPublicRateLimit(req, env, 'meta');
		if (rateLimited) {
			routeStats.publicRateLimitedRequests += 1;
			return rateLimited;
		}

		if (!(await requireBootstrapIfNeeded(req, env))) {
			routeStats.bootstrapRejectedRequests += 1;
			return jsonResponse({ ok: false, error: 'bootstrap_required' }, req, env, 401);
		}

		routeStats.metaRequests += 1;
		const data = await getOrHydrateMeta(env, metaSlug, ctx);
		if (!data) return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
		return jsonResponse({ ok: true, data }, req, env, 200);
	}

	const orderSummarySlug = getSlug(url.pathname, '/v1/order-summary/');
	if (req.method === 'GET' && orderSummarySlug) {
		const rateLimited = await checkPublicRateLimit(req, env, 'order-summary');
		if (rateLimited) {
			routeStats.publicRateLimitedRequests += 1;
			return rateLimited;
		}

		if (!(await requireBootstrapIfNeeded(req, env))) {
			routeStats.bootstrapRejectedRequests += 1;
			return jsonResponse({ ok: false, error: 'bootstrap_required' }, req, env, 401);
		}

		routeStats.orderSummaryRequests += 1;
		const rank = parseRankFilter(url);
		const validation = await validateRankedSlugAndRank(env, orderSummarySlug, rank, { rankRequired: true });
		if (!validation.ok) {
			routeStats.invalidRankRequests += 1;
			return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
		}

		const result = await getOrHydrateOrderSummary(env, orderSummarySlug, ctx, rank);
		if (result.status === 'ok') return jsonResponse({ ok: true, data: result.data }, req, env, 200);
		if (result.status === 'unavailable') return jsonResponse({ ok: false, error: 'unavailable' }, req, env, 503);
		return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
	}

	const ordersSlug = getSlug(url.pathname, '/v1/orders/');
	if (req.method === 'GET' && ordersSlug) {
		if (!publicOrdersRouteEnabled(env)) {
			routeStats.deprecatedOrdersRequests += 1;
			return jsonResponse({ ok: false, error: 'deprecated' }, req, env, 410);
		}

		const rateLimited = await checkPublicRateLimit(req, env, 'orders');
		if (rateLimited) {
			routeStats.publicRateLimitedRequests += 1;
			return rateLimited;
		}

		if (!(await requireBootstrapIfNeeded(req, env))) {
			routeStats.bootstrapRejectedRequests += 1;
			return jsonResponse({ ok: false, error: 'bootstrap_required' }, req, env, 401);
		}

		routeStats.ordersRequests += 1;
		const rank = parseRankFilter(url);
		const validation = await validateRankedSlugAndRank(env, ordersSlug, rank);
		if (!validation.ok) {
			routeStats.invalidRankRequests += 1;
			return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
		}

		const result = await getOrHydrateOrders(env, ordersSlug, ctx, rank);
		if (result.status === 'ok') return jsonResponse({ ok: true, data: result.data }, req, env, 200);
		if (result.status === 'unavailable') return jsonResponse({ ok: false, error: 'unavailable' }, req, env, 503);
		return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
	}

	return null;
}
