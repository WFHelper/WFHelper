import { ORDER_SUMMARY_CATALOG_PREWARM_LAST_RUN_KEY, PREWARM_LAST_RUN_KEY, SNAPSHOT_KEY } from '../constants';
import { emptyResponse, jsonResponse, rawJsonResponse, streamJsonResponse } from '../security/cors';
import { isAdminAuthorized } from '../security/adminAuth';
import { BOOTSTRAP_HEADER, bootstrapEnabled, bootstrapRequired, issueBootstrapToken, verifyBootstrapToken } from '../security/bootstrap';
import { checkPublicRateLimit } from '../security/rateLimit';
import {
	getAutoCacheConfig,
	getAutoCacheStats,
	getOrHydrateMeta,
	getOrHydrateOrderSummary,
	getOrHydrateOrderSummaryBySubtype,
	getOrHydratePrice,
} from '../services/readThrough';
import { readAdversaryVendorsDoc } from '../services/adversaryVendors';
import { isRelicSlug, normalizeOrderSubtype } from '../services/orderSubtype';
import { readPublishedSupporters } from '../services/supporters';
import { readTopTradedDoc } from '../services/topTraded';
import { recordActiveUser } from '../services/activeUsers';
import { readRankedSummaryCatalogFromKv, sanitizeSnapshotForClient } from '../services/prewarm';
import { fetchCatalogSlugs, readClientCatalogFromKv } from '../services/prewarmCatalog';
import { annotateResponse } from '../services/logging';
import type { Env } from '../types';
import { getJsonFromKv, getSlug } from '../utils';
import { normalizeRankFilter } from '../../../../config/shared/numeric';
import { isWfmExcludedSlug } from '../../../../config/shared/wfmExclusions';
import { codaBatchAt } from '../../../../config/shared/vendorRotation';
import { isValidSnapshotBlob, WFM_SNAPSHOT_CLIENT_CACHE_VERSION } from '../../../../config/shared/wfmSnapshotValidation';

const routeStats = {
	healthzRequests: 0,
	healthzAuthorizedRequests: 0,
	bootstrapRequests: 0,
	publicRateLimitedRequests: 0,
	bootstrapRejectedRequests: 0,
	invalidRankRequests: 0,
	invalidSubtypeRequests: 0,
	snapshotRequests: 0,
	priceRequests: 0,
	metaRequests: 0,
	orderSummaryRequests: 0,
	wfmItemsRequests: 0,
	supportersRequests: 0,
	topTradedRequests: 0,
	adversaryVendorsRequests: 0,
};

const PUBLIC_JSON_CACHE_HEADERS = { 'cache-control': 'public, max-age=60' };
const EXCLUDED_MARKET_HEADERS = { 'cache-control': 'public, max-age=3600' };
const SNAPSHOT_CACHE_CONTROL = 'public, max-age=7200';
const WFM_ITEMS_CACHE_CONTROL = 'public, max-age=21600';
const WFM_ITEMS_CACHE_VERSION = 2;
const SUPPORTERS_CACHE_CONTROL = 'public, max-age=3600';
const SUPPORTERS_CACHE_VERSION = 1;
const TOP_TRADED_CACHE_CONTROL = 'public, max-age=3600';
const TOP_TRADED_CACHE_VERSION = 1;
const ADVERSARY_VENDORS_CACHE_CONTROL = 'public, max-age=3600';
const ADVERSARY_VENDORS_CACHE_VERSION = 1;
const RANKED_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

let rankedCatalogCache: { expiresAt: number; bySlug: Map<string, number> } | null = null;

type PublicRateLimitRoute = Parameters<typeof checkPublicRateLimit>[2];
type HydrateResult<T> =
	| { status: 'ok'; data: T; cacheHit: boolean }
	| { status: 'unavailable'; cacheHit: false }
	| { status: 'not_found'; cacheHit: boolean };
type RankedValidation = { ok: true; maxRank: number | null } | { ok: false; error?: 'catalog_unavailable' };

function parseRankFilter(url: URL): number | null {
	const rawRank = url.searchParams.get('rank');
	if (!rawRank) return null;
	return normalizeRankFilter(rawRank);
}

async function getRankedCatalogBySlug(env: Env): Promise<Map<string, number>> {
	const now = Date.now();
	if (rankedCatalogCache && rankedCatalogCache.expiresAt > now) return rankedCatalogCache.bySlug;

	const entries = await readRankedSummaryCatalogFromKv(env);
	const next = new Map<string, number>();
	for (const entry of entries) {
		next.set(entry.slug, entry.maxRank);
	}
	// An empty map already means "catalog unavailable" to callers, so caching it
	// would keep serving 503 for the whole TTL after a transient KV miss.
	if (next.size > 0) rankedCatalogCache = { expiresAt: now + RANKED_CATALOG_CACHE_TTL_MS, bySlug: next };

	return next;
}

export function resetRankedCatalogCacheForTest(): void {
	rankedCatalogCache = null;
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
	// Fail closed: required mode without a secret is a misconfiguration.
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
		return annotateResponse(jsonResponse({ ok: true, data: result.data }, req, env, 200, PUBLIC_JSON_CACHE_HEADERS), {
			cacheHit: result.cacheHit,
		});
	}
	if (result.status === 'unavailable') {
		return annotateResponse(jsonResponse({ ok: false, error: 'unavailable' }, req, env, 503), {
			cacheHit: result.cacheHit,
		});
	}
	return annotateResponse(jsonResponse({ ok: false, error: 'not_found' }, req, env, 404), {
		cacheHit: result.cacheHit,
	});
}

function excludedMarketResponse(req: Request, env: Env): Response {
	return annotateResponse(jsonResponse({ ok: false, error: 'not_found' }, req, env, 404, EXCLUDED_MARKET_HEADERS), {
		cacheHit: true,
	});
}

function notModifiedResponse(etag: string, cacheControl: string, req: Request, env: Env): Response {
	return emptyResponse(req, env, 304, { etag: etag, 'cache-control': cacheControl });
}

// The cache version is part of the tag so a payload-shape change invalidates
// client copies even when the serialized body is unchanged.
async function clientBodyEtag(body: string, cacheVersion: string | number): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
	const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `"${hash}-${cacheVersion}"`;
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
					header: BOOTSTRAP_HEADER,
					expiresAt: issued.expiresAt,
				},
			},
			req,
			env,
			200,
		);
	}

	if (req.method === 'GET' && url.pathname === '/v1/snapshot') {
		// Startup fetches this before bootstrap. Cache hits are rewrapped for the request's CORS
		// headers, and the guard still runs before every cache lookup.
		const guardResponse = await guardPublicRequest(req, env, 'snapshot');
		if (guardResponse) return guardResponse;

		// Count launches even when the snapshot is cached at the edge.
		recordActiveUser(req, env, ctx);
		routeStats.snapshotRequests += 1;
		const cacheKey = new Request(`${url.origin}/v1/snapshot?body=${WFM_SNAPSHOT_CLIENT_CACHE_VERSION}`, { method: 'GET' });
		const edgeCache = caches.default;
		const cachedResponse = await edgeCache.match(cacheKey);
		if (cachedResponse) {
			const cachedEtag = cachedResponse.headers.get('etag');
			if (requestHasMatchingEtag(req, cachedEtag)) {
				return annotateResponse(
					notModifiedResponse(cachedEtag, cachedResponse.headers.get('cache-control') || SNAPSHOT_CACHE_CONTROL, req, env),
					{ cacheHit: true },
				);
			}
			const cachedHeaders: Record<string, string> = {
				'cache-control': cachedResponse.headers.get('cache-control') || SNAPSHOT_CACHE_CONTROL,
			};
			if (cachedEtag) cachedHeaders.etag = cachedEtag;
			return annotateResponse(streamJsonResponse(cachedResponse.body, req, env, 200, cachedHeaders), { cacheHit: true });
		}
		const raw = await env.PRICE_CACHE.get(SNAPSHOT_KEY);
		if (!raw) {
			return jsonResponse({ ok: false, error: 'snapshot_not_ready' }, req, env, 503);
		}

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
		const etag = await clientBodyEtag(body, WFM_SNAPSHOT_CLIENT_CACHE_VERSION);
		if (requestHasMatchingEtag(req, etag)) {
			return annotateResponse(notModifiedResponse(etag, SNAPSHOT_CACHE_CONTROL, req, env), { cacheHit: true });
		}

		const responseHeaders: Record<string, string> = {
			'cache-control': SNAPSHOT_CACHE_CONTROL,
			etag,
		};

		const response = rawJsonResponse(body, req, env, 200, responseHeaders);

		if (ctx) {
			ctx.waitUntil(edgeCache.put(cacheKey, new Response(body, { status: 200, headers: responseHeaders })));
		}

		return annotateResponse(response, { cacheHit: false });
	}

	if (req.method === 'GET' && url.pathname === '/v1/wfm-items') {
		// WFM item catalog pass-through. Reads only: the refresh cadence stays
		// owned by the prewarm path; this route never re-fetches a present copy.
		const guardResponse = await guardPublicRequest(req, env, 'wfm-items');
		if (guardResponse) return guardResponse;

		routeStats.wfmItemsRequests += 1;
		const cacheKey = new Request(`${url.origin}/v1/wfm-items?v=${WFM_ITEMS_CACHE_VERSION}`, { method: 'GET' });
		const edgeCache = caches.default;
		const cachedResponse = await edgeCache.match(cacheKey);
		if (cachedResponse) {
			const cachedEtag = cachedResponse.headers.get('etag');
			if (requestHasMatchingEtag(req, cachedEtag)) {
				return annotateResponse(notModifiedResponse(cachedEtag, WFM_ITEMS_CACHE_CONTROL, req, env), { cacheHit: true });
			}
			const cachedHeaders: Record<string, string> = { 'cache-control': WFM_ITEMS_CACHE_CONTROL };
			if (cachedEtag) cachedHeaders.etag = cachedEtag;
			return annotateResponse(streamJsonResponse(cachedResponse.body, req, env, 200, cachedHeaders), { cacheHit: true });
		}

		let catalog = await readClientCatalogFromKv(env);
		if (!catalog) {
			// A fresh legacy slug catalog makes the normal refresh a no-op, so retry once
			// with force; empty upstream responses still cannot replace valid cache data.
			await fetchCatalogSlugs(env, false);
			catalog = await readClientCatalogFromKv(env);
			if (!catalog) {
				await fetchCatalogSlugs(env, true);
				catalog = await readClientCatalogFromKv(env);
			}
		}
		if (!catalog) {
			return annotateResponse(jsonResponse({ ok: false, error: 'catalog_not_ready' }, req, env, 503), { cacheHit: false });
		}

		const body = JSON.stringify({ ok: true, updatedAt: catalog.updatedAt, items: catalog.items });
		const etag = await clientBodyEtag(body, WFM_ITEMS_CACHE_VERSION);
		if (requestHasMatchingEtag(req, etag)) {
			return annotateResponse(notModifiedResponse(etag, WFM_ITEMS_CACHE_CONTROL, req, env), { cacheHit: true });
		}

		const responseHeaders: Record<string, string> = {
			'cache-control': WFM_ITEMS_CACHE_CONTROL,
			etag,
		};

		const response = rawJsonResponse(body, req, env, 200, responseHeaders);

		if (ctx) {
			ctx.waitUntil(edgeCache.put(cacheKey, new Response(body, { status: 200, headers: responseHeaders })));
		}

		return annotateResponse(response, { cacheHit: false });
	}

	if (req.method === 'GET' && url.pathname === '/v1/supporters') {
		// Public and bootstrap-free: the app renders this before it holds a token.
		const guardResponse = await guardPublicRequest(req, env, 'supporters');
		if (guardResponse) return guardResponse;

		routeStats.supportersRequests += 1;
		const cacheKey = new Request(`${url.origin}/v1/supporters?v=${SUPPORTERS_CACHE_VERSION}`, { method: 'GET' });
		const edgeCache = caches.default;
		const cachedResponse = await edgeCache.match(cacheKey);
		if (cachedResponse) {
			return annotateResponse(streamJsonResponse(cachedResponse.body, req, env, 200, { 'cache-control': SUPPORTERS_CACHE_CONTROL }), {
				cacheHit: true,
			});
		}

		const published = await readPublishedSupporters(env);
		const body = JSON.stringify({ ok: true, updatedAt: published.updatedAt, supporters: published.supporters });
		const responseHeaders = { 'cache-control': SUPPORTERS_CACHE_CONTROL };
		const response = rawJsonResponse(body, req, env, 200, responseHeaders);

		// An empty list is never edge-cached, so the first sync after setup shows up
		// immediately instead of an hour later.
		if (ctx && published.supporters.length > 0) {
			ctx.waitUntil(edgeCache.put(cacheKey, new Response(body, { status: 200, headers: responseHeaders })));
		}

		return annotateResponse(response, { cacheHit: false });
	}

	if (req.method === 'GET' && url.pathname === '/v1/top-traded') {
		// Public and bootstrap-free like the item catalog: one aggregate the cron owns,
		// rebuilt at most hourly, so the edge serves nearly every request.
		const guardResponse = await guardPublicRequest(req, env, 'top-traded');
		if (guardResponse) return guardResponse;

		routeStats.topTradedRequests += 1;
		const cacheKey = new Request(`${url.origin}/v1/top-traded?v=${TOP_TRADED_CACHE_VERSION}`, { method: 'GET' });
		const edgeCache = caches.default;
		const cachedResponse = await edgeCache.match(cacheKey);
		if (cachedResponse) {
			const cachedEtag = cachedResponse.headers.get('etag');
			if (requestHasMatchingEtag(req, cachedEtag)) {
				return annotateResponse(notModifiedResponse(cachedEtag, TOP_TRADED_CACHE_CONTROL, req, env), { cacheHit: true });
			}
			const cachedHeaders: Record<string, string> = { 'cache-control': TOP_TRADED_CACHE_CONTROL };
			if (cachedEtag) cachedHeaders.etag = cachedEtag;
			return annotateResponse(streamJsonResponse(cachedResponse.body, req, env, 200, cachedHeaders), { cacheHit: true });
		}

		const doc = await readTopTradedDoc(env);
		if (!doc) {
			// No pass has published yet; never cached, so the first build shows up at once.
			return annotateResponse(jsonResponse({ ok: false, error: 'top_traded_not_ready' }, req, env, 404), { cacheHit: false });
		}

		const body = JSON.stringify({
			ok: true,
			generatedAt: doc.generatedAt,
			windowDays: doc.windowDays,
			items: doc.items,
			byValue: doc.byValue,
		});
		const etag = await clientBodyEtag(body, TOP_TRADED_CACHE_VERSION);
		if (requestHasMatchingEtag(req, etag)) {
			return annotateResponse(notModifiedResponse(etag, TOP_TRADED_CACHE_CONTROL, req, env), { cacheHit: true });
		}

		const responseHeaders: Record<string, string> = {
			'cache-control': TOP_TRADED_CACHE_CONTROL,
			etag,
		};

		const response = rawJsonResponse(body, req, env, 200, responseHeaders);

		if (ctx) {
			ctx.waitUntil(edgeCache.put(cacheKey, new Response(body, { status: 200, headers: responseHeaders })));
		}

		return annotateResponse(response, { cacheHit: false });
	}

	if (req.method === 'GET' && url.pathname === '/v1/adversary-vendors') {
		// Public and bootstrap-free: the World tab renders it before it holds a token.
		const guardResponse = await guardPublicRequest(req, env, 'adversary-vendors');
		if (guardResponse) return guardResponse;

		routeStats.adversaryVendorsRequests += 1;
		const batch = codaBatchAt(Date.now());
		// The batch is part of the key, so a flip is served immediately instead of
		// waiting out the cached hour.
		const cacheKey = new Request(`${url.origin}/v1/adversary-vendors?v=${ADVERSARY_VENDORS_CACHE_VERSION}&b=${batch}`, {
			method: 'GET',
		});
		const edgeCache = caches.default;
		const cachedResponse = await edgeCache.match(cacheKey);
		if (cachedResponse) {
			const cachedEtag = cachedResponse.headers.get('etag');
			if (requestHasMatchingEtag(req, cachedEtag)) {
				return annotateResponse(notModifiedResponse(cachedEtag, ADVERSARY_VENDORS_CACHE_CONTROL, req, env), { cacheHit: true });
			}
			const cachedHeaders: Record<string, string> = { 'cache-control': ADVERSARY_VENDORS_CACHE_CONTROL };
			if (cachedEtag) cachedHeaders.etag = cachedEtag;
			return annotateResponse(streamJsonResponse(cachedResponse.body, req, env, 200, cachedHeaders), { cacheHit: true });
		}

		const doc = await readAdversaryVendorsDoc(env);
		if (!doc) {
			// Nothing published yet; never cached, so the first refresh shows up at once.
			return annotateResponse(jsonResponse({ ok: false, error: 'adversary_vendors_not_ready' }, req, env, 404), { cacheHit: false });
		}

		const other = batch === 'A' ? 'B' : 'A';
		const body = JSON.stringify({
			ok: true,
			generatedAt: doc.generatedAt,
			source: doc.source,
			coda: { batch, items: doc.coda[batch] },
			codaNext: { batch: other, items: doc.coda[other] },
			tenet: { items: doc.tenet },
		});
		const etag = await clientBodyEtag(body, `${ADVERSARY_VENDORS_CACHE_VERSION}-${batch}`);
		if (requestHasMatchingEtag(req, etag)) {
			return annotateResponse(notModifiedResponse(etag, ADVERSARY_VENDORS_CACHE_CONTROL, req, env), { cacheHit: true });
		}

		const responseHeaders: Record<string, string> = {
			'cache-control': ADVERSARY_VENDORS_CACHE_CONTROL,
			etag,
		};

		const response = rawJsonResponse(body, req, env, 200, responseHeaders);

		if (ctx) {
			ctx.waitUntil(edgeCache.put(cacheKey, new Response(body, { status: 200, headers: responseHeaders })));
		}

		return annotateResponse(response, { cacheHit: false });
	}

	const priceSlug = getSlug(url.pathname, '/v1/prices/');
	if (req.method === 'GET' && priceSlug) {
		if (isWfmExcludedSlug(priceSlug)) return excludedMarketResponse(req, env);

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
		if (isWfmExcludedSlug(metaSlug)) return excludedMarketResponse(req, env);

		const guardResponse = await guardPublicRequest(req, env, 'meta', { bootstrap: true });
		if (guardResponse) return guardResponse;

		routeStats.metaRequests += 1;
		const result = await getOrHydrateMeta(env, metaSlug, ctx);
		return respondWithStatus(result, req, env);
	}

	const orderSummarySlug = getSlug(url.pathname, '/v1/order-summary/');
	if (req.method === 'GET' && orderSummarySlug) {
		if (isWfmExcludedSlug(orderSummarySlug)) return excludedMarketResponse(req, env);

		const guardResponse = await guardPublicRequest(req, env, 'order-summary', { bootstrap: true });
		if (guardResponse) return guardResponse;

		routeStats.orderSummaryRequests += 1;
		const rawSubtype = url.searchParams.get('subtype');
		if (rawSubtype !== null) {
			// Relics are priced per refinement and never appear in the ranked catalog,
			// so the subtype path replaces rank validation instead of adding to it.
			const subtype = normalizeOrderSubtype(rawSubtype);
			if (!subtype || !isRelicSlug(orderSummarySlug)) {
				routeStats.invalidSubtypeRequests += 1;
				return jsonResponse({ ok: false, error: 'invalid_subtype' }, req, env, 400);
			}

			const subtypeResult = await getOrHydrateOrderSummaryBySubtype(env, orderSummarySlug, subtype, ctx);
			return respondWithStatus(subtypeResult, req, env);
		}

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
