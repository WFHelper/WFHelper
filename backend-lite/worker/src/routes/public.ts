import { ORDER_SUMMARY_CATALOG_PREWARM_LAST_RUN_KEY, PREWARM_LAST_RUN_KEY, SNAPSHOT_ETAG_KEY, SNAPSHOT_KEY } from '../constants';
import { emptyResponse, jsonResponse, rawJsonResponse } from '../security/cors';
import { isAdminAuthorized } from '../security/adminAuth';
import { bootstrapEnabled, bootstrapHeaderName, bootstrapRequired, issueBootstrapToken, verifyBootstrapToken } from '../security/bootstrap';
import { checkPublicRateLimit } from '../security/rateLimit';
import {
	getAutoCacheConfig,
	getAutoCacheStats,
	getOrHydrateMeta,
	getOrHydrateOrderSummary,
	getOrHydratePrice,
} from '../services/readThrough';
import { readRankedSummaryCatalogFromKv, sanitizeSnapshotForClient } from '../services/prewarm';
import type { Env } from '../types';
import { getJsonFromKv, getSlug } from '../utils';
import { normalizeRankFilter } from '../../../../config/shared/numeric';
import { isValidSnapshotBlob, WFM_SNAPSHOT_CLIENT_CACHE_VERSION } from '../../../../config/shared/wfmSnapshotValidation';

const routeStats = {
	healthzRequests: 0,
	healthzAuthorizedRequests: 0,
	bootstrapRequests: 0,
	publicRateLimitedRequests: 0,
	bootstrapRejectedRequests: 0,
	invalidRankRequests: 0,
	snapshotRequests: 0,
	priceRequests: 0,
	metaRequests: 0,
	orderSummaryRequests: 0,
};

const PUBLIC_JSON_CACHE_HEADERS = { 'cache-control': 'public, max-age=60' };
const SNAPSHOT_CACHE_CONTROL = 'public, max-age=7200';

type PublicRateLimitRoute = Parameters<typeof checkPublicRateLimit>[2];
type HydrateResult<T> = { status: 'ok'; data: T } | { status: 'unavailable' } | { status: 'not_found' };
type RankedValidation = { ok: true; maxRank: number | null } | { ok: false; error?: 'catalog_unavailable' };

function parseRankFilter(url: URL): number | null {
	const rawRank = url.searchParams.get('rank');
	if (!rawRank) return null;
	return normalizeRankFilter(rawRank);
}

async function getRankedCatalogBySlug(env: Env): Promise<Map<string, number>> {
	const entries = await readRankedSummaryCatalogFromKv(env);
	const next = new Map<string, number>();
	for (const entry of entries) {
		next.set(entry.slug, entry.maxRank);
	}

	return next;
}

async function validateRankedSlugAndRank(
	env: Env,
	slug: string,
	rank: number | null,
	options?: { rankRequired?: boolean },
): Promise<RankedValidation> {
	if (rank == null) {
		return options?.rankRequired ? { ok: false } : { ok: true, maxRank: null };
	}

	const rankedCatalog = await getRankedCatalogBySlug(env);
	if (rankedCatalog.size === 0) {
		return { ok: false, error: 'catalog_unavailable' };
	}

	const maxRank = rankedCatalog.get(slug) ?? null;
	if (maxRank == null) return { ok: false };
	if (rank !== 0 && rank !== maxRank) return { ok: false };
	return { ok: true, maxRank };
}

function rankedValidationFailureResponse(validation: RankedValidation, req: Request, env: Env): Response {
	if (!validation.ok && validation.error === 'catalog_unavailable') {
		return jsonResponse({ ok: false, error: 'catalog_unavailable' }, req, env, 503);
	}
	return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
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

async function guardPublicRequest(
	req: Request,
	env: Env,
	route: PublicRateLimitRoute,
	options?: { bootstrap?: boolean },
): Promise<Response | null> {
	const rateLimited = await guardRateLimit(req, env, route);
	if (rateLimited) return rateLimited;

	if (options?.bootstrap !== true) return null;
	return guardBootstrap(req, env);
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

function snapshotNotModifiedResponse(etag: string, cacheControl: string, req: Request, env: Env): Response {
	return emptyResponse(req, env, 304, { etag: etag, 'cache-control': cacheControl });
}

function snapshotClientEtag(storedEtag: string | null): string | null {
	if (!storedEtag) return null;
	if (storedEtag.endsWith('"')) return `${storedEtag.slice(0, -1)}-${WFM_SNAPSHOT_CLIENT_CACHE_VERSION}"`;
	return `"${storedEtag}-${WFM_SNAPSHOT_CLIENT_CACHE_VERSION}"`;
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
		const guardResponse = await guardPublicRequest(req, env, 'healthz');
		if (guardResponse) return guardResponse;

		routeStats.healthzRequests += 1;
		if (!(await isAdminAuthorized(req, env))) {
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
		const guardResponse = await guardPublicRequest(req, env, 'bootstrap');
		if (guardResponse) return guardResponse;

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
		// each PoP after the first request. Cache hits are rewrapped below so CORS
		// is computed for the current request instead of replaying the priming
		// request's Origin.
		// The guard intentionally runs before Cache API lookup because these hits
		// still execute the Worker in tests and deployed runtime.
		const guardResponse = await guardPublicRequest(req, env, 'snapshot');
		if (guardResponse) return guardResponse;

		routeStats.snapshotRequests += 1;
		const cacheKey = new Request(`${url.origin}/v1/snapshot?body=${WFM_SNAPSHOT_CLIENT_CACHE_VERSION}`, { method: 'GET' });
		const edgeCache = caches.default;
		const cachedResponse = await edgeCache.match(cacheKey);
		if (cachedResponse) {
			const cachedEtag = cachedResponse.headers.get('etag');
			if (requestHasMatchingEtag(req, cachedEtag)) {
				return snapshotNotModifiedResponse(cachedEtag, cachedResponse.headers.get('cache-control') || SNAPSHOT_CACHE_CONTROL, req, env);
			}
			const cachedHeaders: Record<string, string> = {
				'cache-control': cachedResponse.headers.get('cache-control') || SNAPSHOT_CACHE_CONTROL,
			};
			if (cachedEtag) cachedHeaders.etag = cachedEtag;
			return rawJsonResponse(await cachedResponse.text(), req, env, 200, cachedHeaders);
		}
		const [raw, storedEtag] = await Promise.all([env.PRICE_CACHE.get(SNAPSHOT_KEY), env.PRICE_CACHE.get(SNAPSHOT_ETAG_KEY)]);
		if (!raw) {
			return jsonResponse({ ok: false, error: 'snapshot_not_ready' }, req, env, 503);
		}
		const etag = snapshotClientEtag(storedEtag);

		// Return 304 if the client already has this snapshot version.
		if (requestHasMatchingEtag(req, etag)) {
			return snapshotNotModifiedResponse(etag, SNAPSHOT_CACHE_CONTROL, req, env);
		}

		const responseHeaders: Record<string, string> = { 'cache-control': SNAPSHOT_CACHE_CONTROL };
		if (etag) responseHeaders['etag'] = etag;

		let body: string;
		try {
			const sanitized = sanitizeSnapshotForClient(JSON.parse(raw));
			if (!isValidSnapshotBlob(sanitized)) {
				return jsonResponse({ ok: false, error: 'snapshot_invalid' }, req, env, 503);
			}
			body = JSON.stringify(sanitized);
		} catch {
			return jsonResponse({ ok: false, error: 'snapshot_invalid' }, req, env, 503);
		}

		const response = rawJsonResponse(body, req, env, 200, responseHeaders);

		if (ctx) {
			ctx.waitUntil(edgeCache.put(cacheKey, new Response(body, { status: 200, headers: responseHeaders })));
		}

		return response;
	}

	const priceSlug = getSlug(url.pathname, '/v1/prices/');
	if (req.method === 'GET' && priceSlug) {
		const guardResponse = await guardPublicRequest(req, env, 'prices', { bootstrap: true });
		if (guardResponse) return guardResponse;

		routeStats.priceRequests += 1;
		const rank = parseRankFilter(url);
		const validation = await validateRankedSlugAndRank(env, priceSlug, rank);
		if (!validation.ok) {
			routeStats.invalidRankRequests += 1;
			return rankedValidationFailureResponse(validation, req, env);
		}

		const result = await getOrHydratePrice(env, priceSlug, ctx, rank);
		return respondWithStatus(result, req, env);
	}

	const metaSlug = getSlug(url.pathname, '/v1/meta/');
	if (req.method === 'GET' && metaSlug) {
		const guardResponse = await guardPublicRequest(req, env, 'meta', { bootstrap: true });
		if (guardResponse) return guardResponse;

		routeStats.metaRequests += 1;
		const result = await getOrHydrateMeta(env, metaSlug, ctx);
		return respondWithStatus(result, req, env);
	}

	const orderSummarySlug = getSlug(url.pathname, '/v1/order-summary/');
	if (req.method === 'GET' && orderSummarySlug) {
		const guardResponse = await guardPublicRequest(req, env, 'order-summary', { bootstrap: true });
		if (guardResponse) return guardResponse;

		routeStats.orderSummaryRequests += 1;
		const rank = parseRankFilter(url);
		const validation = await validateRankedSlugAndRank(env, orderSummarySlug, rank, { rankRequired: true });
		if (!validation.ok) {
			routeStats.invalidRankRequests += 1;
			return rankedValidationFailureResponse(validation, req, env);
		}

		const result = await getOrHydrateOrderSummary(env, orderSummarySlug, ctx, rank);
		return respondWithStatus(result, req, env);
	}

	const ordersSlug = getSlug(url.pathname, '/v1/orders/');
	if (req.method === 'GET' && ordersSlug) {
		return jsonResponse({ ok: false, error: 'deprecated' }, req, env, 410);
	}

	return null;
}
