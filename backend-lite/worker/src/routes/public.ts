import { ORDER_SUMMARY_CATALOG_KEY, ORDER_SUMMARY_CATALOG_PREWARM_LAST_RUN_KEY, PREWARM_LAST_RUN_KEY, SNAPSHOT_ETAG_KEY, SNAPSHOT_KEY } from '../constants';
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
import { normalizeRankFilter } from '../../../../config/shared/numeric';

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

const PUBLIC_JSON_CACHE_HEADERS = { 'cache-control': 'public, max-age=60' };
const SNAPSHOT_CACHE_CONTROL = 'public, max-age=7200';

type PublicRateLimitRoute = Parameters<typeof checkPublicRateLimit>[2];
type HydrateResult<T> =
	| { status: 'ok'; data: T }
	| { status: 'unavailable' }
	| { status: 'not_found' };

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

async function requireBootstrapIfNeeded(req: Request, env: Env): Promise<'ok' | 'missing_secret' | 'invalid'> {
	if (!bootstrapRequired(env)) return 'ok';
	// Required mode without a secret is a server misconfiguration; fail closed so
	// token protection cannot be silently disabled in production.
	if (!bootstrapEnabled(env)) return 'missing_secret';
	return (await verifyBootstrapToken(req, env)) ? 'ok' : 'invalid';
}

function bootstrapGuardResponse(result: 'missing_secret' | 'invalid', req: Request, env: Env): Response {
	if (result === 'missing_secret') {
		return jsonResponse({ ok: false, error: 'bootstrap_misconfigured' }, req, env, 503);
	}
	return jsonResponse({ ok: false, error: 'bootstrap_required' }, req, env, 401);
}

async function guardBootstrap(req: Request, env: Env): Promise<Response | null> {
	const bootstrapGuard = await requireBootstrapIfNeeded(req, env);
	if (bootstrapGuard === 'ok') return null;
	routeStats.bootstrapRejectedRequests += 1;
	return bootstrapGuardResponse(bootstrapGuard, req, env);
}

async function guardRateLimit(req: Request, env: Env, route: PublicRateLimitRoute): Promise<Response | null> {
	const rateLimited = await checkPublicRateLimit(req, env, route);
	if (rateLimited) routeStats.publicRateLimitedRequests += 1;
	return rateLimited;
}

function respondWithStatus<T>(result: HydrateResult<T>, req: Request, env: Env): Response {
	if (result.status === 'ok') {
		return jsonResponse({ ok: true, data: result.data }, req, env, 200, PUBLIC_JSON_CACHE_HEADERS);
	}
	if (result.status === 'unavailable') {
		return jsonResponse({ ok: false, error: 'unavailable' }, req, env, 503);
	}
	return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
}

function publicOrdersRouteEnabled(env: Env): boolean {
	return (env.ENABLE_PUBLIC_ORDERS_ROUTE || '').trim() === '1';
}

function snapshotNotModifiedResponse(etag: string, cacheControl: string): Response {
	return new Response(null, {
		status: 304,
		headers: { 'etag': etag, 'cache-control': cacheControl },
	});
}

function requestHasMatchingEtag(req: Request, etag: string | null): etag is string {
	if (!etag) return false;
	const clientEtags = req.headers.get('if-none-match');
	if (!clientEtags) return false;
	return clientEtags
		.split(',')
		.map((entry) => entry.trim())
		.includes(etag);
}

export async function handlePublicRoutes(req: Request, url: URL, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
	if (url.pathname === '/healthz' && req.method === 'GET') {
		const rateLimited = await guardRateLimit(req, env, 'healthz');
		if (rateLimited) return rateLimited;

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
		const rateLimited = await guardRateLimit(req, env, 'bootstrap');
		if (rateLimited) return rateLimited;

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
		// bootstrap would create a chicken-and-egg failure.
		//
		// Edge caching: we use the Cloudflare Cache API so the response is stored at
		// each PoP after the first request. Subsequent users in the same region are
		// served directly from the edge — zero Worker execution, zero KV reads.
		// The rate limiter only runs on genuine cache misses (first request per PoP).
		const cacheKey = new Request(`${url.origin}/v1/snapshot`, { method: 'GET' });
		const edgeCache = caches.default;
		const cachedResponse = await edgeCache.match(cacheKey);
		if (cachedResponse) {
			const cachedEtag = cachedResponse.headers.get('etag');
			if (requestHasMatchingEtag(req, cachedEtag)) {
				return snapshotNotModifiedResponse(
					cachedEtag,
					cachedResponse.headers.get('cache-control') || SNAPSHOT_CACHE_CONTROL,
				);
			}
			return cachedResponse;
		}

		const rateLimited = await guardRateLimit(req, env, 'snapshot');
		if (rateLimited) return rateLimited;

		routeStats.snapshotRequests += 1;
		const [raw, etag] = await Promise.all([
			env.PRICE_CACHE.get(SNAPSHOT_KEY),
			env.PRICE_CACHE.get(SNAPSHOT_ETAG_KEY),
		]);
		if (!raw) {
			return jsonResponse({ ok: false, error: 'snapshot_not_ready' }, req, env, 503);
		}

		// Return 304 if the client already has this snapshot version.
		if (requestHasMatchingEtag(req, etag)) {
			return snapshotNotModifiedResponse(etag, SNAPSHOT_CACHE_CONTROL);
		}

		const responseHeaders: Record<string, string> = {
			'content-type': 'application/json',
			'cache-control': SNAPSHOT_CACHE_CONTROL,
		};
		if (etag) responseHeaders['etag'] = etag;

		const response = new Response(raw, { headers: responseHeaders });

		if (ctx) {
			ctx.waitUntil(edgeCache.put(cacheKey, response.clone()));
		}

		return response;
	}

	const priceSlug = getSlug(url.pathname, '/v1/prices/');
	if (req.method === 'GET' && priceSlug) {
		const rateLimited = await guardRateLimit(req, env, 'prices');
		if (rateLimited) return rateLimited;

		const bootstrapResponse = await guardBootstrap(req, env);
		if (bootstrapResponse) return bootstrapResponse;

		routeStats.priceRequests += 1;
		const rank = parseRankFilter(url);
		const validation = await validateRankedSlugAndRank(env, priceSlug, rank);
		if (!validation.ok) {
			routeStats.invalidRankRequests += 1;
			return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
		}

		const result = await getOrHydratePrice(env, priceSlug, ctx, rank);
		return respondWithStatus(result, req, env);
	}

	const metaSlug = getSlug(url.pathname, '/v1/meta/');
	if (req.method === 'GET' && metaSlug) {
		const rateLimited = await guardRateLimit(req, env, 'meta');
		if (rateLimited) return rateLimited;

		const bootstrapResponse = await guardBootstrap(req, env);
		if (bootstrapResponse) return bootstrapResponse;

		routeStats.metaRequests += 1;
		const data = await getOrHydrateMeta(env, metaSlug, ctx);
		if (!data) return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
		return jsonResponse({ ok: true, data }, req, env, 200, PUBLIC_JSON_CACHE_HEADERS);
	}

	const orderSummarySlug = getSlug(url.pathname, '/v1/order-summary/');
	if (req.method === 'GET' && orderSummarySlug) {
		const rateLimited = await guardRateLimit(req, env, 'order-summary');
		if (rateLimited) return rateLimited;

		const bootstrapResponse = await guardBootstrap(req, env);
		if (bootstrapResponse) return bootstrapResponse;

		routeStats.orderSummaryRequests += 1;
		const rank = parseRankFilter(url);
		const validation = await validateRankedSlugAndRank(env, orderSummarySlug, rank, { rankRequired: true });
		if (!validation.ok) {
			routeStats.invalidRankRequests += 1;
			return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
		}

		const result = await getOrHydrateOrderSummary(env, orderSummarySlug, ctx, rank);
		return respondWithStatus(result, req, env);
	}

	const ordersSlug = getSlug(url.pathname, '/v1/orders/');
	if (req.method === 'GET' && ordersSlug) {
		if (!publicOrdersRouteEnabled(env)) {
			routeStats.deprecatedOrdersRequests += 1;
			return jsonResponse({ ok: false, error: 'deprecated' }, req, env, 410);
		}

		const rateLimited = await guardRateLimit(req, env, 'orders');
		if (rateLimited) return rateLimited;

		const bootstrapResponse = await guardBootstrap(req, env);
		if (bootstrapResponse) return bootstrapResponse;

		routeStats.ordersRequests += 1;
		const rank = parseRankFilter(url);
		const validation = await validateRankedSlugAndRank(env, ordersSlug, rank);
		if (!validation.ok) {
			routeStats.invalidRankRequests += 1;
			return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
		}

		const result = await getOrHydrateOrders(env, ordersSlug, ctx, rank);
		return respondWithStatus(result, req, env);
	}

	return null;
}
