import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { resetDailyBudgetTripStateForTest } from '../src/security/dailyBudget';
import { resetRankedCatalogCacheForTest } from '../src/routes/public';
import type { Env } from '../src/types';
import { buildOrderSummaryPayload, prewarmBatch, prewarmOrderSummaryCatalog } from '../src/services/prewarm';
import { fetchCatalogSlugs, resetRankedSlugCacheForTest } from '../src/services/prewarmCatalog';
import { syncSupporters } from '../src/services/supporters';
import { WFM_SNAPSHOT_CLIENT_CACHE_VERSION } from '../../../config/shared/wfmSnapshotValidation';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
	(env as unknown as Record<string, string>).PUBLIC_BOOTSTRAP_REQUIRED = '0';
	(env as unknown as Record<string, string>).DAILY_BUDGET_ENABLED = '0';
	(env as unknown as Record<string, string>).CATALOG_SLUG_GUARD_ENABLED = '0';
	(env as unknown as Record<string, string>).PUBLIC_RATE_LIMIT_ENABLED = '0';
	resetDailyBudgetTripStateForTest();
	resetRankedCatalogCacheForTest();
	resetRankedSlugCacheForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.fetch = originalFetch;
});

async function seedRankedCatalog(targetEnv: Pick<Env, 'ITEM_META'>, entries: Array<{ slug: string; maxRank: number }>): Promise<void> {
	await targetEnv.ITEM_META.put(
		'order-summary:catalog:v1',
		JSON.stringify({
			updatedAt: Date.now(),
			entries,
		}),
	);
}

async function clearSnapshotEdgeCache(): Promise<void> {
	await Promise.all([
		caches.default.delete(new Request('https://example.com/v1/snapshot')),
		caches.default.delete(new Request(`https://example.com/v1/snapshot?body=${WFM_SNAPSHOT_CLIENT_CACHE_VERSION}`)),
	]);
}

function rateLimiter(maxRequests: number): RateLimit {
	let count = 0;
	return {
		limit: vi.fn(async () => ({ success: ++count <= maxRequests })),
	} as unknown as RateLimit;
}

describe('backend worker', () => {
	it('uses the lowest sell and highest buy prices', () => {
		const payload = buildOrderSummaryPayload('primed_flow', 10, {
			slug: 'primed_flow',
			timestamp: 123,
			sell: [
				{ userName: 'SellerA', status: 'online', platinum: 90, quantity: 1, rank: 10 },
				{ userName: 'SellerB', status: 'ingame', platinum: 80, quantity: 1, rank: 10 },
			],
			buy: [
				{ userName: 'BuyerA', status: 'online', platinum: 50, quantity: 1, rank: 10 },
				{ userName: 'BuyerB', status: 'ingame', platinum: 65, quantity: 1, rank: 10 },
			],
		});

		expect(payload).toMatchObject({ wts: 80, wtb: 65 });
	});

	it('returns health status (unit style)', async () => {
		const request = new IncomingRequest('http://example.com/healthz');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = (await response.json()) as Record<string, unknown>;
		expect(json).toMatchObject({
			ok: true,
			service: 'wf-backend-lite',
		});
		expect(json.automation).toBeUndefined();
	});

	it('logs structured request events', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const request = new IncomingRequest('http://example.com/healthz');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'request',
				route: '/healthz',
				method: 'GET',
				status: 200,
				latencyMs: expect.any(Number),
			}),
		);
	});

	it('logs slug and cache hit metadata for read-through routes', async () => {
		const slug = 'wf_test_logged_cache_slug';
		await env.PRICE_CACHE.put(`price:${slug}`, JSON.stringify({ slug, median: 42, rank: null, timestamp: Date.now() }));
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/prices/${slug}`), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'request',
				route: '/v1/prices/:slug',
				method: 'GET',
				status: 200,
				slug,
				cacheHit: true,
				latencyMs: expect.any(Number),
			}),
		);
	});

	it('returns detailed health status for authorized admin requests', async () => {
		const testEnv = {
			...env,
			ADMIN_API_KEY: 'test-key',
		};
		const request = new IncomingRequest('http://example.com/healthz', {
			headers: {
				authorization: 'Bearer test-key',
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv as unknown as Env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			service: 'wf-backend-lite',
			automation: {
				enabled: true,
			},
		});
	});

	it('blocks requests from origins not in the allowlist', async () => {
		const request = new IncomingRequest('http://example.com/admin/prewarm', {
			method: 'POST',
			headers: {
				Origin: 'https://evil.example',
				authorization: 'Bearer some-key',
			},
			body: JSON.stringify({ batchSize: 1 }),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ ok: false, error: 'forbidden_origin' });
	});

	it('allows requests from the configured ALLOW_ORIGIN domain', async () => {
		const request = new IncomingRequest('http://example.com/healthz', {
			headers: { Origin: 'https://wfhelper.com' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(((await response.json()) as Record<string, unknown>).ok).toBe(true);
	});

	it('allows requests with no Origin header (Electron / curl)', async () => {
		// Electron renderer and direct curl calls never include an Origin header.
		// These should always be allowed through the origin check.
		const request = new IncomingRequest('http://example.com/healthz');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
	});

	it('returns not_found for unknown route (integration style)', async () => {
		const response = await SELF.fetch('https://example.com/unknown');
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' });
	});

	it('serves the client catalog on /v1/wfm-items', async () => {
		await caches.default.delete(new Request('http://example.com/v1/wfm-items?v=2'));
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		await env.ITEM_META.put(
			'catalog:client-items:v2',
			JSON.stringify({
				updatedAt: 1234,
				items: [{ id: 'x', slug: 'ash_prime_set', name: 'Ash Prime Set', thumb: null, icon: null, maxRank: null, gameRef: null }],
			}),
		);

		const request = new IncomingRequest('http://example.com/v1/wfm-items');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = (await response.json()) as { ok: boolean; updatedAt: number; items: Array<{ slug: string; name: string }> };
		expect(json.ok).toBe(true);
		expect(json.updatedAt).toBe(1234);
		expect(json.items).toHaveLength(1);
		expect(json.items[0]).toMatchObject({ slug: 'ash_prime_set', name: 'Ash Prime Set' });
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'request',
				route: '/v1/wfm-items',
				method: 'GET',
				status: 200,
			}),
		);
	});

	it('tags /v1/wfm-items responses with a body etag', async () => {
		await caches.default.delete(new Request('http://example.com/v1/wfm-items?v=2'));
		await env.ITEM_META.put(
			'catalog:client-items:v2',
			JSON.stringify({
				updatedAt: 4321,
				items: [{ id: 'y', slug: 'nova_prime_set', name: 'Nova Prime Set', thumb: null, icon: null, maxRank: null, gameRef: null }],
			}),
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('http://example.com/v1/wfm-items'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{64}-2"$/);
		expect(response.headers.get('cache-control')).toBe('public, max-age=21600');
		expect((await response.json()) as Record<string, unknown>).toMatchObject({ ok: true, updatedAt: 4321 });
	});

	it('serves catalog slugs that are not plain [a-z0-9_]', async () => {
		// warframe.market mints the Tektolyst arcanes with hyphens. Dropping them
		// left the client 29 items short and named every matching order unknown.
		await caches.default.delete(new Request('http://example.com/v1/wfm-items?v=2'));
		await env.ITEM_META.put(
			'catalog:client-items:v2',
			JSON.stringify({
				updatedAt: 4322,
				items: [
					{ id: 'a', slug: 'zid-an-asheir', name: 'Zid-an Asheir', thumb: null, icon: null, maxRank: 5, gameRef: null },
					{ id: 'b', slug: 'summoner’s_wrath', name: "Summoner's Wrath", thumb: null, icon: null, maxRank: 10, gameRef: null },
					{ id: 'c', slug: '../escape', name: 'Nope', thumb: null, icon: null, maxRank: null, gameRef: null },
				],
			}),
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('http://example.com/v1/wfm-items'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = (await response.json()) as { items: Array<{ slug: string }> };
		expect(json.items.map((item) => item.slug)).toEqual(['zid-an-asheir', 'summoner’s_wrath']);
	});

	it('routes read-through requests for a hyphenated slug', async () => {
		const slug = 'zid-an-asheir';
		await env.PRICE_CACHE.put(`price:${slug}`, JSON.stringify({ slug, median: 42, rank: null, timestamp: Date.now() }));

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/prices/${slug}`), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect((await response.json()) as Record<string, unknown>).toMatchObject({ ok: true, data: { slug, median: 42 } });
	});

	it('decodes a percent-encoded slug and still refuses a traversal', async () => {
		const slug = 'höllvanian_old_town_in_fall';
		await env.PRICE_CACHE.put(`price:${slug}`, JSON.stringify({ slug, median: 7, rank: null, timestamp: Date.now() }));

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/prices/${encodeURIComponent(slug)}`), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect((await response.json()) as Record<string, unknown>).toMatchObject({ ok: true, data: { slug, median: 7 } });

		const escapeCtx = createExecutionContext();
		const escaped = await worker.fetch(new IncomingRequest('https://example.com/v1/prices/..%2Fsecret'), env, escapeCtx);
		await waitOnExecutionContext(escapeCtx);
		expect(escaped.status).toBe(404);
	});

	it('honors If-None-Match on /v1/wfm-items once the catalog is edge-cached', async () => {
		await caches.default.delete(new Request('http://example.com/v1/wfm-items?v=2'));
		await env.ITEM_META.put(
			'catalog:client-items:v2',
			JSON.stringify({
				updatedAt: 4321,
				items: [{ id: 'y', slug: 'nova_prime_set', name: 'Nova Prime Set', thumb: null, icon: null, maxRank: null, gameRef: null }],
			}),
		);

		const primeCtx = createExecutionContext();
		const primeResponse = await worker.fetch(new IncomingRequest('http://example.com/v1/wfm-items'), env, primeCtx);
		await waitOnExecutionContext(primeCtx);
		expect(primeResponse.status).toBe(200);
		const etag = primeResponse.headers.get('etag');
		expect(etag).toBeTruthy();

		// Drop the KV copy so only the edge-cached entry can answer the next two requests.
		await env.ITEM_META.delete('catalog:client-items:v2');
		globalThis.fetch = vi.fn(async () => {
			throw new Error('edge-cached catalog requests should not hit WFM');
		}) as unknown as typeof fetch;

		const matchingCtx = createExecutionContext();
		const matchingResponse = await worker.fetch(
			new IncomingRequest('http://example.com/v1/wfm-items', { headers: { 'if-none-match': etag ?? '' } }),
			env,
			matchingCtx,
		);
		await waitOnExecutionContext(matchingCtx);

		const nonMatchingCtx = createExecutionContext();
		const nonMatchingResponse = await worker.fetch(
			new IncomingRequest('http://example.com/v1/wfm-items', { headers: { 'if-none-match': '"other-etag"' } }),
			env,
			nonMatchingCtx,
		);
		await waitOnExecutionContext(nonMatchingCtx);

		expect(matchingResponse.status).toBe(304);
		expect(matchingResponse.headers.get('etag')).toBe(etag);
		expect(matchingResponse.headers.get('cache-control')).toBe('public, max-age=21600');
		expect(await matchingResponse.text()).toBe('');
		expect(nonMatchingResponse.status).toBe(200);
		expect(nonMatchingResponse.headers.get('etag')).toBe(etag);
		expect((await nonMatchingResponse.json()) as Record<string, unknown>).toMatchObject({ ok: true, updatedAt: 4321 });
	});

	it('force-hydrates the client catalog when the slug catalog is fresh but the key is missing', async () => {
		await caches.default.delete(new Request('http://example.com/v1/wfm-items?v=2'));
		// Fresh slug catalog from before the client-items key existed: the
		// cadence-respecting refresh call no-ops on it.
		await env.ITEM_META.put(
			'catalog:slugs:v1',
			JSON.stringify({ updatedAt: Date.now(), slugs: ['ash_prime_set'], rankedSummaryCatalog: [] }),
		);
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: {
							items: [{ id: 'x', slug: 'ash_prime_set', i18n: { en: { name: 'Ash Prime Set', thumb: 'thumb/ash.png' } } }],
						},
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		) as typeof fetch;

		const request = new IncomingRequest('http://example.com/v1/wfm-items');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = (await response.json()) as { ok: boolean; items: Array<{ slug: string; name: string }> };
		expect(json.items[0]).toMatchObject({ slug: 'ash_prime_set', name: 'Ash Prime Set' });
	});

	it('returns catalog_not_ready when the catalog is missing and upstream fails', async () => {
		await caches.default.delete(new Request('http://example.com/v1/wfm-items?v=2'));
		globalThis.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as typeof fetch;

		const request = new IncomingRequest('http://example.com/v1/wfm-items');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ ok: false, error: 'catalog_not_ready' });
	});

	it('requires admin auth for prewarm route', async () => {
		const response = await SELF.fetch('https://example.com/admin/prewarm', {
			method: 'POST',
			body: JSON.stringify({ batchSize: 1 }),
			headers: {
				'content-type': 'application/json',
			},
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ ok: false, error: 'unauthorized' });
	});

	it('stores order summary hotset entries through admin route', async () => {
		const testEnv = {
			...env,
			ADMIN_API_KEY: 'test-key',
		};
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest('https://example.com/admin/order-summary-hotset', {
				method: 'POST',
				headers: {
					authorization: 'Bearer test-key',
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					replace: true,
					entries: [{ slug: 'primed_flow', maxRank: 10, lastSeenAt: 123456 }],
				}),
			}),
			testEnv as unknown as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			result: {
				total: 1,
			},
		});

		const stored = await testEnv.PRICE_CACHE.get('order-summary:hotset:v1');
		expect(stored).toContain('primed_flow');
	});

	it('rate limits repeated admin requests from same IP', async () => {
		const testEnv = {
			...env,
			ADMIN_API_KEY: 'test-key',
			ADMIN_RATE_LIMITER: rateLimiter(2),
		};

		const makeRequest = () =>
			new IncomingRequest('http://example.com/admin/snapshot/status', {
				headers: {
					'cf-connecting-ip': '10.0.0.44',
					authorization: 'Bearer test-key',
				},
			});

		const ctxA = createExecutionContext();
		const ctxB = createExecutionContext();
		const ctxC = createExecutionContext();
		const first = await worker.fetch(makeRequest(), testEnv as unknown as Env, ctxA);
		const second = await worker.fetch(makeRequest(), testEnv as unknown as Env, ctxB);
		const third = await worker.fetch(makeRequest(), testEnv as unknown as Env, ctxC);
		await waitOnExecutionContext(ctxA);
		await waitOnExecutionContext(ctxB);
		await waitOnExecutionContext(ctxC);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(third.status).toBe(429);
		expect(await third.json()).toEqual({ ok: false, error: 'rate_limited' });
	});

	it('rate limits repeated unauthenticated admin requests', async () => {
		const testEnv = {
			...env,
			ADMIN_API_KEY: 'test-key',
			ADMIN_RATE_LIMITER: rateLimiter(2),
		};

		const makeRequest = () =>
			new IncomingRequest('http://example.com/admin/prewarm', {
				method: 'POST',
				headers: {
					'cf-connecting-ip': '10.0.0.45',
					authorization: 'Bearer wrong-key',
				},
				body: JSON.stringify({ batchSize: 1 }),
			});

		for (let i = 0; i < 2; i += 1) {
			const ctx = createExecutionContext();
			const res = await worker.fetch(makeRequest(), testEnv as unknown as Env, ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(401);
		}

		const ctx = createExecutionContext();
		const res = await worker.fetch(makeRequest(), testEnv as unknown as Env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ ok: false, error: 'rate_limited' });
	});

	it('rate limits repeated public health requests from same IP', async () => {
		const testEnv = {
			...env,
			PUBLIC_RATE_LIMIT_ENABLED: '1',
			PUBLIC_HEALTH_RATE_LIMITER: rateLimiter(5),
		};
		const makeRequest = () =>
			new IncomingRequest('http://example.com/healthz', {
				headers: {
					'cf-connecting-ip': '10.0.0.55',
				},
			});

		const responses: Response[] = [];
		for (let i = 0; i < 6; i += 1) {
			const ctx = createExecutionContext();
			responses.push(await worker.fetch(makeRequest(), testEnv as unknown as Env, ctx));
			await waitOnExecutionContext(ctx);
		}

		expect(responses[4].status).toBe(200);
		expect(responses[5].status).toBe(429);
		expect(await responses[5].json()).toEqual({ ok: false, error: 'rate_limited' });
	});

	it('fails closed when the daily budget circuit breaker trips', async () => {
		const testEnv = {
			...env,
			DAILY_BUDGET_ENABLED: '1',
			DAILY_BUDGET_MAX_REQUESTS: '2',
			DAILY_BUDGET_SAMPLE_RATE: '1',
		};
		const makeRequest = () =>
			new IncomingRequest('http://example.com/healthz', {
				headers: {
					'cf-connecting-ip': '10.0.0.56',
				},
			});

		const ctxA = createExecutionContext();
		const ctxB = createExecutionContext();
		const first = await worker.fetch(makeRequest(), testEnv as unknown as Env, ctxA);
		const second = await worker.fetch(makeRequest(), testEnv as unknown as Env, ctxB);
		await waitOnExecutionContext(ctxA);
		await waitOnExecutionContext(ctxB);

		expect(first.status).toBe(200);
		expect(second.status).toBe(503);
		expect(second.headers.get('retry-after')).toBeTruthy();
		expect(await second.json()).toEqual({ ok: false, error: 'daily_budget_exceeded' });
	});

	it('blocks unsampled requests after the daily budget trips', async () => {
		const testEnv = {
			...env,
			DAILY_BUDGET_ENABLED: '1',
			DAILY_BUDGET_MAX_REQUESTS: '100',
			DAILY_BUDGET_SAMPLE_RATE: '100',
		};
		let randomCall = 0;
		vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
			if (!(array instanceof Uint32Array)) throw new Error('expected Uint32Array');
			array[0] = randomCall++ === 0 ? 0 : 1;
			return array;
		});

		const sampledCtx = createExecutionContext();
		const sampled = await worker.fetch(new IncomingRequest('http://example.com/healthz'), testEnv as unknown as Env, sampledCtx);
		await waitOnExecutionContext(sampledCtx);
		const unsampledCtx = createExecutionContext();
		const unsampled = await worker.fetch(new IncomingRequest('http://example.com/healthz'), testEnv as unknown as Env, unsampledCtx);
		await waitOnExecutionContext(unsampledCtx);

		expect(sampled.status).toBe(503);
		expect(unsampled.status).toBe(503);
		expect(await unsampled.json()).toEqual({ ok: false, error: 'daily_budget_exceeded' });
	});

	it('skips scheduled prewarm when the daily budget is already exceeded', async () => {
		const testEnv = {
			...env,
			DAILY_BUDGET_ENABLED: '1',
			DAILY_BUDGET_MAX_REQUESTS: '2',
			DAILY_BUDGET_SAMPLE_RATE: '1',
		};
		for (let i = 0; i < 2; i += 1) {
			const ctx = createExecutionContext();
			await worker.fetch(new IncomingRequest(`http://example.com/healthz?seed=${i}`), testEnv as unknown as Env, ctx);
			await waitOnExecutionContext(ctx);
		}
		const fetchMock = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;

		await worker.scheduled({} as ScheduledController, testEnv as unknown as Env, createExecutionContext());

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects unknown catalog slugs before WFM read-through', async () => {
		await env.ITEM_META.put(
			'catalog:slugs:v1',
			JSON.stringify({
				updatedAt: Date.now(),
				slugs: ['forma'],
			}),
		);
		(env as unknown as Record<string, string>).CATALOG_SLUG_GUARD_ENABLED = '1';
		const fetchMock = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('http://example.com/v1/prices/fake_slug_for_dos'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('issues bootstrap tokens and accepts them when bootstrap is required', async () => {
		const testEnv = {
			...env,
			BOOTSTRAP_TOKEN_SECRET: 'bootstrap-secret',
			PUBLIC_BOOTSTRAP_REQUIRED: '1',
		};

		const bootstrapCtx = createExecutionContext();
		const bootstrapResponse = await worker.fetch(
			new IncomingRequest('https://example.com/v1/bootstrap', {
				headers: {
					'cf-connecting-ip': '10.0.0.77',
					'user-agent': 'wfhelper-test',
				},
			}),
			testEnv as unknown as Env,
			bootstrapCtx,
		);
		await waitOnExecutionContext(bootstrapCtx);

		expect(bootstrapResponse.status).toBe(200);
		expect(bootstrapResponse.headers.get('cache-control')).toBe('no-store');
		const bootstrapJson = (await bootstrapResponse.json()) as {
			data?: { token?: string };
		};
		const token = bootstrapJson.data?.token;
		expect(typeof token).toBe('string');

		globalThis.fetch = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;

		const missingTokenCtx = createExecutionContext();
		const missingTokenResponse = await worker.fetch(
			new IncomingRequest('https://example.com/v1/meta/not_a_real_slug', {
				headers: {
					'cf-connecting-ip': '10.0.0.77',
					'user-agent': 'wfhelper-test',
				},
			}),
			testEnv as unknown as Env,
			missingTokenCtx,
		);
		await waitOnExecutionContext(missingTokenCtx);
		expect(missingTokenResponse.status).toBe(401);

		const tokenCtx = createExecutionContext();
		const tokenResponse = await worker.fetch(
			new IncomingRequest('https://example.com/v1/meta/not_a_real_slug', {
				headers: {
					'cf-connecting-ip': '10.0.0.77',
					'user-agent': 'wfhelper-test',
					'x-wfhelper-bootstrap': token || '',
				},
			}),
			testEnv as unknown as Env,
			tokenCtx,
		);
		await waitOnExecutionContext(tokenCtx);

		expect(tokenResponse.status).toBe(404);
	});

	it('fails closed when bootstrap is required but the secret is missing', async () => {
		const testEnv = {
			...env,
			BOOTSTRAP_TOKEN_SECRET: '',
			PUBLIC_BOOTSTRAP_REQUIRED: '1',
		};

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest('https://example.com/v1/meta/not_a_real_slug', {
				headers: {
					'cf-connecting-ip': '10.0.0.78',
					'user-agent': 'wfhelper-test',
				},
			}),
			testEnv as unknown as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(503);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({ ok: false, error: 'bootstrap_misconfigured' });
	});

	it('short-circuits known non-market scene slugs before rate-limit and marker KV reads', async () => {
		const priceGetSpy = vi.spyOn(env.PRICE_CACHE, 'get');
		const pricePutSpy = vi.spyOn(env.PRICE_CACHE, 'put');
		const metaGetSpy = vi.spyOn(env.ITEM_META, 'get');
		const fetchMock = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('https://example.com/v1/meta/gas_city_regulators_scene'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
		expect(await response.json()).toEqual({ ok: false, error: 'not_found' });
		expect(priceGetSpy).not.toHaveBeenCalled();
		expect(pricePutSpy).not.toHaveBeenCalled();
		expect(metaGetSpy).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('reuses local untradable marker hits without repeated ITEM_META reads', async () => {
		const slug = 'wf_test_untradable_marker_slug';
		await env.ITEM_META.delete(`meta:${slug}`);
		await env.ITEM_META.put(`skip:untradable:${slug}`, '1');
		const metaGetSpy = vi.spyOn(env.ITEM_META, 'get');
		const fetchMock = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;

		const firstCtx = createExecutionContext();
		const first = await worker.fetch(new IncomingRequest(`https://example.com/v1/meta/${slug}`), env, firstCtx);
		await waitOnExecutionContext(firstCtx);

		const secondCtx = createExecutionContext();
		const second = await worker.fetch(new IncomingRequest(`https://example.com/v1/meta/${slug}`), env, secondCtx);
		await waitOnExecutionContext(secondCtx);

		expect(first.status).toBe(404);
		expect(second.status).toBe(404);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(metaGetSpy.mock.calls.map((call) => call[0])).toEqual([`meta:${slug}`, `skip:untradable:${slug}`]);
	});

	it('auto-hydrates price endpoint on cache miss', async () => {
		const slug = 'wf_test_price_slug';
		await env.PRICE_CACHE.delete(`price:${slug}`);
		await env.PRICE_CACHE.delete(`miss:price:v2:${slug}`);
		await env.PRICE_CACHE.delete(`price:${slug}:r0`);
		await env.PRICE_CACHE.delete(`miss:price:v2:${slug}:r0`);

		const statsPayload = {
			payload: {
				statistics_closed: {
					'48hours': [{ order_type: 'sell', datetime: new Date().toISOString(), median: 42 }],
				},
			},
		};

		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === `https://api.warframe.market/v1/items/${slug}/statistics`) {
				return new Response(JSON.stringify(statsPayload), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected url: ${url}`);
		}) as unknown as typeof fetch;

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/prices/${slug}`), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=60');
		expect(await response.json()).toMatchObject({ ok: true, data: { slug, median: 42 } });

		const cached = await env.PRICE_CACHE.get(`price:${slug}`);
		expect(cached).toBeTruthy();
	});

	it('treats old market stats as no-data instead of caching stale prices', async () => {
		const slug = 'wf_test_inactive_price_slug';
		await env.PRICE_CACHE.delete(`price:${slug}`);
		await env.PRICE_CACHE.delete(`miss:price:v2:${slug}`);

		const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
		const statsPayload = {
			payload: {
				statistics_closed: {
					'48hours': [{ order_type: 'sell', datetime: oldDate, median: 99 }],
				},
			},
		};

		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === `https://api.warframe.market/v1/items/${slug}/statistics`) {
				return new Response(JSON.stringify(statsPayload), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected url: ${url}`);
		});
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const ctxA = createExecutionContext();
		const first = await worker.fetch(new IncomingRequest(`https://example.com/v1/prices/${slug}`), env, ctxA);
		await waitOnExecutionContext(ctxA);

		const ctxB = createExecutionContext();
		const second = await worker.fetch(new IncomingRequest(`https://example.com/v1/prices/${slug}`), env, ctxB);
		await waitOnExecutionContext(ctxB);

		expect(first.status).toBe(404);
		expect(second.status).toBe(404);
		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(await env.PRICE_CACHE.get(`price:${slug}`)).toBeNull();
		expect(await env.PRICE_CACHE.get(`miss:price:v2:${slug}`)).toBe('1');
	});

	it('supports ranked price lookups for mod and arcane stats', async () => {
		const slug = 'wf_test_ranked_price_slug';
		await seedRankedCatalog(env, [{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.delete(`price:${slug}:r0`);
		await env.PRICE_CACHE.delete(`price:${slug}:r10`);
		await env.PRICE_CACHE.delete(`miss:price:v2:${slug}:r0`);
		await env.PRICE_CACHE.delete(`miss:price:v2:${slug}:r10`);

		const statsPayload = {
			payload: {
				statistics_closed: {
					'48hours': [
						{ order_type: 'sell', datetime: new Date().toISOString(), median: 50, mod_rank: 0 },
						{ order_type: 'sell', datetime: new Date().toISOString(), median: 175, mod_rank: 10 },
					],
				},
			},
		};

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === `https://api.warframe.market/v1/items/${slug}/statistics`) {
				return new Response(JSON.stringify(statsPayload), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected url: ${url}`);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const ctxA = createExecutionContext();
		const rank10 = await worker.fetch(new IncomingRequest(`https://example.com/v1/prices/${slug}?rank=10`), env, ctxA);
		await waitOnExecutionContext(ctxA);

		expect(rank10.status).toBe(200);
		expect(await rank10.json()).toMatchObject({
			ok: true,
			data: {
				slug,
				rank: 10,
				median: 175,
			},
		});

		const ctxB = createExecutionContext();
		const rank0 = await worker.fetch(new IncomingRequest(`https://example.com/v1/prices/${slug}?rank=0`), env, ctxB);
		await waitOnExecutionContext(ctxB);

		expect(rank0.status).toBe(200);
		expect(await rank0.json()).toMatchObject({
			ok: true,
			data: {
				slug,
				rank: 0,
				median: 50,
			},
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(await env.PRICE_CACHE.get(`price:${slug}:r10`)).toBeTruthy();
		expect(await env.PRICE_CACHE.get(`price:${slug}:r0`)).toBeTruthy();
	});

	it('returns unavailable when live price hydration is transient', async () => {
		const slug = 'wf_test_transient_price_slug';
		await env.PRICE_CACHE.delete(`price:${slug}`);
		await env.PRICE_CACHE.delete(`miss:price:v2:${slug}`);

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === `https://api.warframe.market/v1/items/${slug}/statistics`) {
				return new Response('', { status: 503 });
			}
			throw new Error(`Unexpected url: ${url}`);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const ctxA = createExecutionContext();
		const first = await worker.fetch(new IncomingRequest(`https://example.com/v1/prices/${slug}`), env, ctxA);
		await waitOnExecutionContext(ctxA);
		expect(first.status).toBe(503);
		expect(await first.json()).toEqual({ ok: false, error: 'unavailable' });

		const ctxB = createExecutionContext();
		const second = await worker.fetch(new IncomingRequest(`https://example.com/v1/prices/${slug}`), env, ctxB);
		await waitOnExecutionContext(ctxB);
		expect(second.status).toBe(503);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(await env.PRICE_CACHE.get(`miss:price:v2:${slug}`)).toBeNull();
	});

	it('auto-hydrates meta endpoint on cache miss', async () => {
		const slug = 'wf_test_meta_slug';
		const metaPayload = {
			data: {
				tradable: true,
				ducats: 65,
				setRoot: false,
				i18n: { en: { thumb: 'thumb/meta.png', icon: 'icon/meta.png' } },
			},
		};

		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === `https://api.warframe.market/v2/items/${slug}`) {
				return new Response(JSON.stringify(metaPayload), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected url: ${url}`);
		}) as unknown as typeof fetch;

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/meta/${slug}`), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, data: { slug, ducats: 65 } });

		const cached = await env.ITEM_META.get(`meta:${slug}`);
		expect(cached).toBeTruthy();
	});

	it('returns unavailable when live meta hydration is transient', async () => {
		const slug = 'wf_test_transient_meta_slug';
		await env.ITEM_META.delete(`meta:${slug}`);
		await env.ITEM_META.delete(`miss:meta:${slug}`);

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === `https://api.warframe.market/v2/items/${slug}`) {
				return new Response('', { status: 503 });
			}
			throw new Error(`Unexpected url: ${url}`);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const ctxA = createExecutionContext();
		const first = await worker.fetch(new IncomingRequest(`https://example.com/v1/meta/${slug}`), env, ctxA);
		await waitOnExecutionContext(ctxA);
		expect(first.status).toBe(503);
		expect(await first.json()).toEqual({ ok: false, error: 'unavailable' });

		const ctxB = createExecutionContext();
		const second = await worker.fetch(new IncomingRequest(`https://example.com/v1/meta/${slug}`), env, ctxB);
		await waitOnExecutionContext(ctxB);
		expect(second.status).toBe(503);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(await env.ITEM_META.get(`miss:meta:${slug}`)).toBeNull();
	});

	it('keeps public full orderbook route deprecated', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('https://example.com/v1/orders/wf_test_orders_disabled_slug'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(410);
		expect(await response.json()).toEqual({ ok: false, error: 'deprecated' });
	});

	it('rejects invalid ranked slug and rank combinations before upstream fetch', async () => {
		await env.ITEM_META.put(
			'order-summary:catalog:v1',
			JSON.stringify({
				updatedAt: Date.now(),
				entries: [{ slug: 'primed_flow', maxRank: 10 }],
			}),
		);

		try {
			const fetchMock = vi.fn(async () => {
				throw new Error('should not fetch upstream for invalid rank combinations');
			});
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const ctxA = createExecutionContext();
			const missingRankResponse = await worker.fetch(new IncomingRequest('https://example.com/v1/order-summary/primed_flow'), env, ctxA);
			await waitOnExecutionContext(ctxA);

			const ctxB = createExecutionContext();
			const invalidRankResponse = await worker.fetch(new IncomingRequest('https://example.com/v1/prices/primed_flow?rank=4'), env, ctxB);
			await waitOnExecutionContext(ctxB);

			const ctxC = createExecutionContext();
			const nonRankedResponse = await worker.fetch(new IncomingRequest('https://example.com/v1/prices/ash_prime_set?rank=10'), env, ctxC);
			await waitOnExecutionContext(ctxC);

			expect(missingRankResponse.status).toBe(404);
			expect(invalidRankResponse.status).toBe(404);
			expect(nonRankedResponse.status).toBe(404);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			await env.ITEM_META.delete('order-summary:catalog:v1');
		}
	});

	it('fails closed for ranked requests when catalog is unavailable', async () => {
		await env.ITEM_META.delete('order-summary:catalog:v1');
		const fetchMock = vi.fn(async () => {
			throw new Error('should not fetch upstream when ranked catalog is unavailable');
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('https://example.com/v1/prices/primed_flow?rank=10'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ ok: false, error: 'catalog_unavailable' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('reads the ranked catalog once across back-to-back ranked requests', async () => {
		const slug = 'wf_test_ranked_catalog_cache_slug';
		await seedRankedCatalog(env, [{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.put(`price:${slug}:r10`, JSON.stringify({ slug, median: 24, rank: 10, timestamp: Date.now() }));
		const metaGet = vi.spyOn(env.ITEM_META, 'get');
		globalThis.fetch = vi.fn(async () => {
			throw new Error('cached ranked prices should not hit WFM');
		}) as unknown as typeof fetch;

		const ctxA = createExecutionContext();
		const first = await worker.fetch(new IncomingRequest(`https://example.com/v1/prices/${slug}?rank=10`), env, ctxA);
		await waitOnExecutionContext(ctxA);

		const ctxB = createExecutionContext();
		const second = await worker.fetch(new IncomingRequest(`https://example.com/v1/prices/${slug}?rank=10`), env, ctxB);
		await waitOnExecutionContext(ctxB);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(metaGet.mock.calls.filter(([key]) => key === 'order-summary:catalog:v1')).toHaveLength(1);
	});

	it('auto-hydrates order summary endpoint on cache miss', async () => {
		const slug = 'wf_test_order_summary_slug';
		await seedRankedCatalog(env, [{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.delete(`orders-summary:${slug}:r10`);
		await env.PRICE_CACHE.delete(`miss:orders-summary:v1:${slug}:r10`);

		const ordersPayload = {
			data: [
				{
					type: 'sell',
					platinum: 15,
					quantity: 1,
					rank: 10,
					visible: true,
					user: { ingameName: 'SellerA', status: 'ingame' },
				},
				{
					type: 'buy',
					platinum: 11,
					quantity: 1,
					rank: 10,
					visible: true,
					user: { ingameName: 'BuyerA', status: 'online' },
				},
			],
		};

		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === `https://api.warframe.market/v2/orders/item/${slug}`) {
				return new Response(JSON.stringify(ordersPayload), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected url: ${url}`);
		}) as unknown as typeof fetch;

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/order-summary/${slug}?rank=10`), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: {
				slug,
				rank: 10,
				wts: 15,
				wtb: 11,
			},
		});

		const cached = await env.PRICE_CACHE.get(`orders-summary:${slug}:r10`);
		expect(cached).toBeTruthy();
	});

	it('manual order summary prewarm warms hotset entries', async () => {
		await env.PRICE_CACHE.put(
			'order-summary:hotset:v1',
			JSON.stringify({
				updatedAt: Date.now(),
				entries: [{ slug: 'wf_test_hotset_slug', maxRank: 10, lastSeenAt: Date.now() }],
			}),
		);

		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === 'https://api.warframe.market/v2/orders/item/wf_test_hotset_slug') {
				return new Response(
					JSON.stringify({
						data: [
							{
								type: 'sell',
								platinum: 17,
								quantity: 1,
								rank: 0,
								visible: true,
								user: { ingameName: 'Seller0', status: 'ingame' },
							},
							{
								type: 'buy',
								platinum: 11,
								quantity: 1,
								rank: 10,
								visible: true,
								user: { ingameName: 'Buyer10', status: 'online' },
							},
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			throw new Error(`Unexpected url: ${url}`);
		}) as unknown as typeof fetch;

		const testEnv = {
			...env,
			ADMIN_API_KEY: 'test-key',
		};
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest('https://example.com/admin/prewarm/order-summaries', {
				method: 'POST',
				headers: {
					authorization: 'Bearer test-key',
					'content-type': 'application/json',
				},
				body: JSON.stringify({ source: 'hotset', batchSize: 1 }),
			}),
			testEnv as unknown as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			ok: true,
			result: {
				updated: 2,
			},
		});

		expect(await testEnv.PRICE_CACHE.get('orders-summary:wf_test_hotset_slug:r0')).toBeTruthy();
		expect(await testEnv.PRICE_CACHE.get('orders-summary:wf_test_hotset_slug:r10')).toBeTruthy();
	});

	it('manual order summary prewarm warms ranked catalog entries', async () => {
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === 'https://api.warframe.market/v2/items') {
				return new Response(
					JSON.stringify({
						data: [
							{ slug: 'primed_flow', max_rank: 10 },
							{ slug: 'arcane_energize', max_rank: 5 },
							{ slug: 'blood_for_energy', max_rank: 10 },
							{ slug: 'pistol_riven_mod_(veiled)', max_rank: 10 },
							{ slug: 'ash_prime_set' },
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.warframe.market/v2/orders/item/primed_flow') {
				return new Response(
					JSON.stringify({
						data: [
							{
								type: 'sell',
								platinum: 17,
								quantity: 1,
								rank: 0,
								visible: true,
								user: { ingameName: 'Seller0', status: 'ingame' },
							},
							{
								type: 'buy',
								platinum: 11,
								quantity: 1,
								rank: 10,
								visible: true,
								user: { ingameName: 'Buyer10', status: 'online' },
							},
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://api.warframe.market/v2/orders/item/arcane_energize') {
				return new Response(
					JSON.stringify({
						data: [
							{
								type: 'sell',
								platinum: 80,
								quantity: 1,
								rank: 0,
								visible: true,
								user: { ingameName: 'SellerA', status: 'online' },
							},
							{
								type: 'buy',
								platinum: 72,
								quantity: 1,
								rank: 5,
								visible: true,
								user: { ingameName: 'BuyerA', status: 'ingame' },
							},
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			throw new Error(`Unexpected url: ${url}`);
		}) as unknown as typeof fetch;

		const testEnv = {
			...env,
			ADMIN_API_KEY: 'test-key',
		};
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest('https://example.com/admin/prewarm/order-summaries', {
				method: 'POST',
				headers: {
					authorization: 'Bearer test-key',
					'content-type': 'application/json',
				},
				body: JSON.stringify({ source: 'catalog', batchSize: 2, resetCursor: true, refreshCatalog: true }),
			}),
			testEnv as unknown as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			ok: true,
			result: {
				source: 'catalog',
				totalEntries: 2,
				updated: 4,
			},
		});

		expect(await testEnv.PRICE_CACHE.get('orders-summary:primed_flow:r0')).toBeTruthy();
		expect(await testEnv.PRICE_CACHE.get('orders-summary:primed_flow:r10')).toBeTruthy();
		expect(await testEnv.PRICE_CACHE.get('orders-summary:arcane_energize:r0')).toBeTruthy();
		expect(await testEnv.PRICE_CACHE.get('orders-summary:arcane_energize:r5')).toBeTruthy();
	});

	it('cron prewarm skips fresh cached price and meta entries', async () => {
		const slug = 'wf_test_fresh_cron_slug';
		const now = Date.now();
		await env.ITEM_META.put(
			'catalog:slugs:v1',
			JSON.stringify({
				updatedAt: now,
				slugs: [slug],
				rankedSummaryCatalog: [],
			}),
		);
		await env.ITEM_META.put(
			`meta:${slug}`,
			JSON.stringify({ slug, tradable: true, ducats: 45, setRoot: false, thumb: null, icon: null, timestamp: now }),
		);
		await env.PRICE_CACHE.put(`price:${slug}`, JSON.stringify({ slug, median: 42, rank: null, timestamp: now }));
		await env.PRICE_CACHE.put(
			'snapshot:full:v1',
			JSON.stringify({ version: 1, generatedAt: now - 1000, prices: {}, meta: {}, orderSummaries: {} }),
		);

		const fetchMock = vi.fn(async () => {
			throw new Error('fresh cron entries should not hit WFM');
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await prewarmBatch(env, { reason: 'cron', batchSize: 1, resetCursor: true });

		expect(result.processed).toBe(1);
		expect(result.metaUpdated).toBe(0);
		expect(result.priceUpdated).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();

		const snapshot = JSON.parse(String(await env.PRICE_CACHE.get('snapshot:full:v1'))) as {
			prices?: Record<string, { status?: string; median?: number; timestamp?: number }>;
			meta?: Record<string, { slug?: string; timestamp?: number }>;
		};
		expect(snapshot.prices?.[slug]).toMatchObject({ status: 'ok', median: 42, timestamp: now });
		expect(snapshot.meta?.[slug]).toMatchObject({ slug, timestamp: now });
	});

	it('cron ranked summary prewarm patches fresh cached summaries and prices into snapshot', async () => {
		const slug = 'wf_test_fresh_summary_cron_slug';
		const now = Date.now();
		await seedRankedCatalog(env, [{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.put(
			'snapshot:full:v1',
			JSON.stringify({ version: 1, generatedAt: now - 1000, prices: {}, meta: {}, orderSummaries: {} }),
		);
		for (const rank of [0, 10]) {
			await env.PRICE_CACHE.put(
				`orders-summary:${slug}:r${rank}`,
				JSON.stringify({ slug, rank, wts: 10 + rank, wtb: 5 + rank, timestamp: now }),
			);
			await env.PRICE_CACHE.put(`price:${slug}:r${rank}`, JSON.stringify({ slug, rank, median: 20 + rank, timestamp: now }));
		}

		const fetchMock = vi.fn(async () => {
			throw new Error('fresh ranked cron entries should not hit WFM');
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await prewarmOrderSummaryCatalog(env, { reason: 'cron', batchSize: 1, resetCursor: true });

		expect(result.processed).toBe(2);
		expect(result.updated).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();

		const snapshot = JSON.parse(String(await env.PRICE_CACHE.get('snapshot:full:v1'))) as {
			prices?: Record<string, { status?: string; median?: number }>;
			orderSummaries?: Record<string, { status?: string; wts?: number; wtb?: number }>;
		};
		expect(snapshot.prices?.[`${slug}:rank-v3:r0`]).toMatchObject({ status: 'ok', median: 20 });
		expect(snapshot.prices?.[`${slug}:rank-v3:r10`]).toMatchObject({ status: 'ok', median: 30 });
		expect(snapshot.orderSummaries?.[`${slug}:r0`]).toMatchObject({ status: 'ok', wts: 10, wtb: 5 });
		expect(snapshot.orderSummaries?.[`${slug}:r10`]).toMatchObject({ status: 'ok', wts: 20, wtb: 15 });
	});

	it('cron ranked summary prewarm patches fresh cached prices while refreshing missing summaries', async () => {
		const slug = 'wf_test_mixed_summary_cron_slug';
		const now = Date.now();
		await seedRankedCatalog(env, [{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.put(
			'snapshot:full:v1',
			JSON.stringify({ version: 1, generatedAt: now - 1000, prices: {}, meta: {}, orderSummaries: {} }),
		);
		for (const rank of [0, 10]) {
			await env.PRICE_CACHE.put(`price:${slug}:r${rank}`, JSON.stringify({ slug, rank, median: 20 + rank, timestamp: now }));
		}

		const ordersPayload = {
			data: [
				{
					type: 'sell',
					platinum: 40,
					quantity: 1,
					rank: 0,
					visible: true,
					user: { ingameName: 'SellerR0', status: 'ingame' },
				},
				{
					type: 'buy',
					platinum: 30,
					quantity: 1,
					rank: 0,
					visible: true,
					user: { ingameName: 'BuyerR0', status: 'online' },
				},
				{
					type: 'sell',
					platinum: 90,
					quantity: 1,
					rank: 10,
					visible: true,
					user: { ingameName: 'SellerR10', status: 'ingame' },
				},
				{
					type: 'buy',
					platinum: 70,
					quantity: 1,
					rank: 10,
					visible: true,
					user: { ingameName: 'BuyerR10', status: 'online' },
				},
			],
		};

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === `https://api.warframe.market/v2/orders/item/${slug}`) {
				return new Response(JSON.stringify(ordersPayload), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected url: ${url}`);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await prewarmOrderSummaryCatalog(env, { reason: 'cron', batchSize: 1, resetCursor: true });

		expect(result.processed).toBe(2);
		expect(result.updated).toBe(2);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const snapshot = JSON.parse(String(await env.PRICE_CACHE.get('snapshot:full:v1'))) as {
			prices?: Record<string, { status?: string; median?: number; timestamp?: number }>;
			orderSummaries?: Record<string, { status?: string; wts?: number; wtb?: number }>;
		};
		expect(snapshot.prices?.[`${slug}:rank-v3:r0`]).toMatchObject({ status: 'ok', median: 20, timestamp: now });
		expect(snapshot.prices?.[`${slug}:rank-v3:r10`]).toMatchObject({ status: 'ok', median: 30, timestamp: now });
		expect(snapshot.orderSummaries?.[`${slug}:r0`]).toMatchObject({ status: 'ok', wts: 40, wtb: 30 });
		expect(snapshot.orderSummaries?.[`${slug}:r10`]).toMatchObject({ status: 'ok', wts: 90, wtb: 70 });
	});

	it('serves stale cached order summary during transient upstream failure', async () => {
		const slug = 'wf_test_stale_order_summary_slug';
		await seedRankedCatalog(env, [{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.put(
			`orders-summary:${slug}:r0`,
			JSON.stringify({
				slug,
				rank: 0,
				wts: 20,
				wtb: 14,
				timestamp: Date.now() - 8 * 60 * 60 * 1000,
			}),
		);

		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === `https://api.warframe.market/v2/orders/item/${slug}`) {
				return new Response('', { status: 503 });
			}
			throw new Error(`Unexpected url: ${url}`);
		}) as unknown as typeof fetch;

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/order-summary/${slug}?rank=0`), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: {
				slug,
				rank: 0,
				wts: 20,
				wtb: 14,
			},
		});
	});

	it('filters order summaries by rank and preserves offline fallback prices', async () => {
		const slug = 'wf_test_ranked_orders_slug';
		await seedRankedCatalog(env, [{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.delete(`orders-summary:${slug}:r10`);
		await env.PRICE_CACHE.delete(`miss:orders-summary:v1:${slug}:r10`);

		const ordersPayload = {
			data: [
				{
					type: 'sell',
					platinum: 80,
					quantity: 1,
					rank: 0,
					visible: true,
					user: { ingameName: 'SellerR0', status: 'online' },
				},
				{
					type: 'sell',
					platinum: 140,
					quantity: 1,
					rank: 10,
					visible: true,
					user: { ingameName: 'SellerR10', status: 'offline' },
				},
				{
					type: 'buy',
					platinum: 100,
					quantity: 1,
					rank: 10,
					visible: true,
					user: { ingameName: 'BuyerR10', status: 'invisible' },
				},
			],
		};

		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === `https://api.warframe.market/v2/orders/item/${slug}`) {
				return new Response(JSON.stringify(ordersPayload), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected url: ${url}`);
		}) as unknown as typeof fetch;

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/order-summary/${slug}?rank=10`), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: {
				slug,
				rank: 10,
				wts: 140,
				wtb: 100,
			},
		});

		expect(await env.PRICE_CACHE.get(`orders-summary:${slug}:r10`)).toBeTruthy();
	});

	it('keeps active rank order summaries even when many cheaper offline rows exist', async () => {
		const slug = 'wf_test_rank_activity_window_slug';
		await seedRankedCatalog(env, [{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.delete(`orders:${slug}:r0`);
		await env.PRICE_CACHE.delete(`miss:orders:v2:${slug}:r0`);

		const manyOfflineSellRows = Array.from({ length: 30 }, (_, index) => ({
			type: 'sell',
			platinum: 50 + index,
			quantity: 1,
			rank: 0,
			visible: true,
			user: { ingameName: `OfflineSeller${index}`, status: 'offline' },
		}));

		const ordersPayload = {
			data: [
				...manyOfflineSellRows,
				{
					type: 'sell',
					platinum: 85,
					quantity: 1,
					rank: 0,
					visible: true,
					user: { ingameName: 'ActiveSellerR0', status: 'ingame' },
				},
			],
		};

		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === `https://api.warframe.market/v2/orders/item/${slug}`) {
				return new Response(JSON.stringify(ordersPayload), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected url: ${url}`);
		}) as unknown as typeof fetch;

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/order-summary/${slug}?rank=0`), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = (await response.json()) as {
			data?: { wts?: number | null };
		};
		expect(json.data?.wts).toBe(85);
	});

	it('falls back to v1 orders endpoint when v2 endpoint is unavailable', async () => {
		const slug = 'wf_test_orders_fallback_slug';
		await seedRankedCatalog(env, [{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.delete(`orders:${slug}`);
		await env.PRICE_CACHE.delete(`miss:orders:v2:${slug}`);
		await env.PRICE_CACHE.delete(`orders-summary:${slug}:r0`);
		await env.PRICE_CACHE.delete(`miss:orders-summary:v1:${slug}:r0`);

		const v1OrdersPayload = {
			payload: {
				orders: [
					{
						order_type: 'sell',
						platinum: 9,
						quantity: 1,
						mod_rank: 0,
						visible: true,
						user: { ingame_name: 'SellerFallback', status: 'ingame' },
					},
					{
						order_type: 'buy',
						platinum: 8,
						quantity: 1,
						mod_rank: 0,
						visible: true,
						user: { ingame_name: 'BuyerFallback', status: 'online' },
					},
				],
			},
		};

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === `https://api.warframe.market/v2/orders/item/${slug}`) {
				return new Response('', { status: 403 });
			}
			if (url === `https://api.warframe.market/v1/items/${slug}/orders`) {
				return new Response(JSON.stringify(v1OrdersPayload), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected url: ${url}`);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/order-summary/${slug}?rank=0`), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: {
				slug,
				wts: 9,
				wtb: 8,
			},
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.warframe.market/v2/orders/item/${slug}`);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(`https://api.warframe.market/v1/items/${slug}/orders`);
	});

	it('returns 503 when snapshot KV key is absent', async () => {
		await env.PRICE_CACHE.delete('snapshot:full:v1');

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('https://example.com/v1/snapshot'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ ok: false, error: 'snapshot_not_ready' });
	});

	it('returns snapshot JSON with correct cache-control when KV key is present', async () => {
		const generatedAt = Date.now();
		const staleEntryTimestamp = generatedAt - 25 * 60 * 60 * 1000;
		const snapshot = {
			version: 1,
			generatedAt,
			prices: { ash_prime: { status: 'ok', median: 45, timestamp: staleEntryTimestamp } },
			meta: { ash_prime: { slug: 'ash_prime', ducats: 45, setRoot: true, thumb: null, icon: null, timestamp: staleEntryTimestamp } },
			orderSummaries: { 'ordersummary-v1:ash_prime:r0': { status: 'ok', wts: 10, wtb: 8, timestamp: staleEntryTimestamp } },
		};
		await env.PRICE_CACHE.put('snapshot:full:v1', JSON.stringify(snapshot));
		await clearSnapshotEdgeCache();

		try {
			const ctx = createExecutionContext();
			const response = await worker.fetch(
				new IncomingRequest('https://example.com/v1/snapshot', {
					headers: { Origin: 'https://wfhelper.com' },
				}),
				env,
				ctx,
			);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('application/json');
			expect(response.headers.get('cache-control')).toBe('public, max-age=7200');
			expect(response.headers.get('vary')).toBe('Origin');
			expect(response.headers.get('x-content-type-options')).toBe('nosniff');
			expect(response.headers.get('access-control-allow-origin')).toBe('https://wfhelper.com');

			const body = (await response.json()) as typeof snapshot;
			expect(body.version).toBe(1);
			expect(body.prices['ash_prime']).toMatchObject({ status: 'ok', median: 45, timestamp: staleEntryTimestamp });
			expect(body.meta['ash_prime']).toMatchObject({ slug: 'ash_prime', timestamp: staleEntryTimestamp });
			expect(body.orderSummaries['ordersummary-v1:ash_prime:r0']).toMatchObject({
				status: 'ok',
				wts: 10,
				wtb: 8,
				timestamp: staleEntryTimestamp,
				sourceTimestamp: staleEntryTimestamp,
			});
		} finally {
			await env.PRICE_CACHE.delete('snapshot:full:v1');
			await clearSnapshotEdgeCache();
		}
	});

	it('rewraps edge-cached snapshot responses with per-request CORS', async () => {
		const snapshot = { version: 1, generatedAt: Date.now(), prices: {}, meta: {}, orderSummaries: {} };
		await env.PRICE_CACHE.put('snapshot:full:v1', JSON.stringify(snapshot));
		await clearSnapshotEdgeCache();

		try {
			const primeCtx = createExecutionContext();
			const primeResponse = await worker.fetch(
				new IncomingRequest('https://example.com/v1/snapshot', {
					headers: { 'cf-connecting-ip': '10.0.1.201' },
				}),
				env,
				primeCtx,
			);
			await waitOnExecutionContext(primeCtx);
			expect(primeResponse.status).toBe(200);
			expect(primeResponse.headers.get('access-control-allow-origin')).toBeNull();
			const etag = primeResponse.headers.get('etag');
			expect(etag).toContain(`-${WFM_SNAPSHOT_CLIENT_CACHE_VERSION}"`);

			const browserCtx = createExecutionContext();
			const browserResponse = await worker.fetch(
				new IncomingRequest('https://example.com/v1/snapshot', {
					headers: {
						Origin: 'https://wfhelper.com',
						'cf-connecting-ip': '10.0.1.202',
					},
				}),
				env,
				browserCtx,
			);
			await waitOnExecutionContext(browserCtx);

			expect(browserResponse.status).toBe(200);
			expect(browserResponse.headers.get('access-control-allow-origin')).toBe('https://wfhelper.com');
			expect(browserResponse.headers.get('etag')).toBe(etag);
		} finally {
			await env.PRICE_CACHE.delete('snapshot:full:v1');
			await clearSnapshotEdgeCache();
		}
	});

	it('returns snapshot_invalid for malformed snapshot KV data', async () => {
		await env.PRICE_CACHE.put('snapshot:full:v1', '{"version":1,"prices":[]}');
		await clearSnapshotEdgeCache();

		try {
			const ctx = createExecutionContext();
			const response = await worker.fetch(
				new IncomingRequest('https://example.com/v1/snapshot', {
					headers: { 'cf-connecting-ip': '10.0.1.203' },
				}),
				env,
				ctx,
			);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(503);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(await response.json()).toEqual({ ok: false, error: 'snapshot_invalid' });
		} finally {
			await env.PRICE_CACHE.delete('snapshot:full:v1');
			await clearSnapshotEdgeCache();
		}
	});

	it('serves inactive snapshot prices as no-data markers', async () => {
		const generatedAt = Date.now();
		const snapshot = {
			version: 1,
			generatedAt,
			prices: {
				inactive_scene: {
					status: 'ok',
					median: 12,
					timestamp: generatedAt - 31 * 24 * 60 * 60 * 1000,
				},
			},
			meta: {},
			orderSummaries: {},
		};
		await env.PRICE_CACHE.put('snapshot:full:v1', JSON.stringify(snapshot));
		await clearSnapshotEdgeCache();

		try {
			const ctx = createExecutionContext();
			const response = await worker.fetch(new IncomingRequest('https://example.com/v1/snapshot'), env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get('etag')).toContain(`-${WFM_SNAPSHOT_CLIENT_CACHE_VERSION}"`);
			const body = (await response.json()) as typeof snapshot;
			expect(body.prices.inactive_scene).toEqual({
				status: 'no_data',
				median: null,
				timestamp: generatedAt,
			});

			const oldEtagCtx = createExecutionContext();
			const oldEtagResponse = await worker.fetch(
				new IncomingRequest('https://example.com/v1/snapshot', {
					headers: { 'if-none-match': '"obsolete-etag"' },
				}),
				env,
				oldEtagCtx,
			);
			await waitOnExecutionContext(oldEtagCtx);
			expect(oldEtagResponse.status).toBe(200);
		} finally {
			await env.PRICE_CACHE.delete('snapshot:full:v1');
			await clearSnapshotEdgeCache();
		}
	});

	it('honors If-None-Match when the snapshot is already edge-cached', async () => {
		const snapshot = { version: 1, generatedAt: Date.now(), prices: {}, meta: {}, orderSummaries: {} };
		await env.PRICE_CACHE.put('snapshot:full:v1', JSON.stringify(snapshot));
		await clearSnapshotEdgeCache();

		try {
			const primeCtx = createExecutionContext();
			const primeResponse = await worker.fetch(new IncomingRequest('https://example.com/v1/snapshot'), env, primeCtx);
			await waitOnExecutionContext(primeCtx);
			expect(primeResponse.status).toBe(200);
			const etag = primeResponse.headers.get('etag');
			expect(etag).toContain(`-${WFM_SNAPSHOT_CLIENT_CACHE_VERSION}"`);

			const matchingCtx = createExecutionContext();
			const matchingResponse = await worker.fetch(
				new IncomingRequest('https://example.com/v1/snapshot', {
					headers: { 'if-none-match': etag ?? '' },
				}),
				env,
				matchingCtx,
			);
			await waitOnExecutionContext(matchingCtx);

			const nonMatchingCtx = createExecutionContext();
			const nonMatchingResponse = await worker.fetch(
				new IncomingRequest('https://example.com/v1/snapshot', {
					headers: { 'if-none-match': '"other-etag"' },
				}),
				env,
				nonMatchingCtx,
			);
			await waitOnExecutionContext(nonMatchingCtx);

			expect(matchingResponse.status).toBe(304);
			expect(matchingResponse.headers.get('etag')).toBe(etag);
			expect(matchingResponse.headers.get('cache-control')).toBe('public, max-age=7200');
			expect(await matchingResponse.text()).toBe('');
			expect(nonMatchingResponse.status).toBe(200);
			expect(await nonMatchingResponse.json()).toMatchObject({ version: 1 });
		} finally {
			await env.PRICE_CACHE.delete('snapshot:full:v1');
			await clearSnapshotEdgeCache();
		}
	});

	it('rate limits repeated snapshot requests from same IP', async () => {
		const snapshot = { version: 1, generatedAt: Date.now(), prices: {}, meta: {}, orderSummaries: {} };
		await env.PRICE_CACHE.put('snapshot:full:v1', JSON.stringify(snapshot));

		// Clear any edge-cached snapshot from prior tests so every request goes
		// through the Worker and hits the rate limiter.
		await clearSnapshotEdgeCache();

		const testEnv = {
			...env,
			PUBLIC_RATE_LIMIT_ENABLED: '1',
			PUBLIC_SNAPSHOT_RATE_LIMITER: rateLimiter(2),
		};
		const makeRequest = () =>
			new IncomingRequest('https://example.com/v1/snapshot', {
				headers: { 'cf-connecting-ip': '10.0.0.99' },
			});

		const responses: Response[] = [];
		try {
			for (let i = 0; i < 3; i++) {
				await clearSnapshotEdgeCache();
				const ctx = createExecutionContext();
				responses.push(await worker.fetch(makeRequest(), testEnv as unknown as Env, ctx));
				await waitOnExecutionContext(ctx);
			}
			expect(responses[1].status).toBe(200);
			expect(responses[2].status).toBe(429);
			expect(await responses[2].json()).toEqual({ ok: false, error: 'rate_limited' });
		} finally {
			await env.PRICE_CACHE.delete('snapshot:full:v1');
			await clearSnapshotEdgeCache();
		}
	});

	it('caches negative miss for absent price data', async () => {
		const slug = 'wf_test_negative_slug';
		await env.PRICE_CACHE.delete(`price:${slug}`);
		await env.PRICE_CACHE.delete(`miss:price:v2:${slug}`);
		await env.PRICE_CACHE.delete(`miss:price:v2:${slug}:r0`);

		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === `https://api.warframe.market/v1/items/${slug}/statistics`) {
				return new Response('{}', {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected url: ${url}`);
		});
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const ctxA = createExecutionContext();
		const ctxB = createExecutionContext();
		const first = await worker.fetch(new IncomingRequest(`https://example.com/v1/prices/${slug}`), env, ctxA);
		const second = await worker.fetch(new IncomingRequest(`https://example.com/v1/prices/${slug}`), env, ctxB);
		await waitOnExecutionContext(ctxA);
		await waitOnExecutionContext(ctxB);

		expect(first.status).toBe(404);
		expect(second.status).toBe(404);
		expect(mockFetch).toHaveBeenCalledTimes(1);
		const missBase = await env.PRICE_CACHE.get(`miss:price:v2:${slug}`);
		const missRank0 = await env.PRICE_CACHE.get(`miss:price:v2:${slug}:r0`);
		expect(missBase || missRank0).toBe('1');
	});

	it('serves the stale catalog and never clobbers it when the WFM refresh fails', async () => {
		const staleUpdatedAt = Date.now() - 48 * 60 * 60 * 1000;
		const seeded = { updatedAt: staleUpdatedAt, slugs: ['primed_flow'], rankedSummaryCatalog: [] };
		await env.ITEM_META.put('catalog:slugs:v1', JSON.stringify(seeded));

		const failures: Array<() => Promise<Response>> = [
			async () => {
				throw new Error('network down');
			},
			async () => new Response('upstream sad', { status: 503 }),
			async () => new Response(JSON.stringify({ data: { items: [] } }), { status: 200 }),
		];
		for (const failure of failures) {
			globalThis.fetch = vi.fn(failure) as unknown as typeof fetch;
			const slugs = await fetchCatalogSlugs(env, false);
			expect(slugs).toEqual(['primed_flow']);
			const stored = JSON.parse(String(await env.ITEM_META.get('catalog:slugs:v1'))) as { updatedAt?: number };
			expect(stored.updatedAt).toBe(staleUpdatedAt);
		}
	});

	it('reports catalog age through the admin diagnostics route', async () => {
		const updatedAt = Date.now() - 30 * 60 * 60 * 1000;
		await env.ITEM_META.put('catalog:slugs:v1', JSON.stringify({ updatedAt, slugs: ['primed_flow', 'primed_continuity'] }));

		const ctx = createExecutionContext();
		const res = await worker.fetch(
			new IncomingRequest('http://example.com/admin/catalog/status', {
				headers: { 'cf-connecting-ip': '10.0.0.60', authorization: 'Bearer test-key' },
			}),
			{ ...env, ADMIN_API_KEY: 'test-key', ADMIN_RATE_LIMITER: rateLimiter(10) } as unknown as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { updatedAt: number; ageHours: number; stale: boolean; slugCount: number } };
		expect(body.result.updatedAt).toBe(updatedAt);
		expect(body.result.ageHours).toBeGreaterThan(29);
		expect(body.result.stale).toBe(true);
		expect(body.result.slugCount).toBe(2);
	});
});

describe('anonymous active-user counting', () => {
	const testEnv = env as unknown as Record<string, string | undefined>;

	afterEach(() => {
		delete testEnv.STATS_SALT;
	});

	async function dauKeyCount(): Promise<number> {
		const page = await (env as unknown as Env).ITEM_META.list({ prefix: 'dau:' });
		return page.keys.length;
	}

	async function requestSnapshot(ip: string): Promise<void> {
		const request = new IncomingRequest('http://example.com/v1/snapshot', {
			headers: { 'cf-connecting-ip': ip },
		});
		const ctx = createExecutionContext();
		await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
	}

	it('counts each snapshot caller once per day', async () => {
		testEnv.STATS_SALT = 'test-salt';
		await requestSnapshot('203.0.113.5');
		await requestSnapshot('203.0.113.5');
		expect(await dauKeyCount()).toBe(1);
		await requestSnapshot('203.0.113.9');
		expect(await dauKeyCount()).toBe(2);
	});

	it('records nothing while STATS_SALT is unset', async () => {
		await requestSnapshot('203.0.113.5');
		expect(await dauKeyCount()).toBe(0);
	});

	it('reports per-day unique counts on the admin route', async () => {
		testEnv.STATS_SALT = 'test-salt';
		testEnv.ADMIN_API_KEY = 'test-key';
		await requestSnapshot('203.0.113.5');
		await requestSnapshot('203.0.113.9');

		const request = new IncomingRequest('http://example.com/admin/stats/active-users?days=2', {
			headers: { authorization: 'Bearer test-key' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: boolean;
			enabled: boolean;
			result: Array<{ date: string; users: number }>;
		};
		expect(body.ok).toBe(true);
		expect(body.enabled).toBe(true);
		expect(body.result).toHaveLength(2);
		expect(body.result[0].users).toBe(2);
		expect(body.result[1].users).toBe(0);
	});
});

describe('relic order summary subtypes', () => {
	const RELIC_SLUG = 'wf_test_axi_a1_relic';

	function relicOrdersResponse(): Response {
		return new Response(
			JSON.stringify({
				data: [
					{
						type: 'sell',
						platinum: 20,
						quantity: 1,
						visible: true,
						subtype: 'radiant',
						user: { ingameName: 'RadiantSeller', status: 'ingame' },
					},
					{
						type: 'sell',
						platinum: 4,
						quantity: 1,
						visible: true,
						subtype: 'intact',
						user: { ingameName: 'IntactSeller', status: 'ingame' },
					},
					{
						type: 'buy',
						platinum: 12,
						quantity: 1,
						visible: true,
						subtype: 'radiant',
						user: { ingameName: 'RadiantBuyer', status: 'online' },
					},
					{
						type: 'buy',
						platinum: 2,
						quantity: 1,
						visible: true,
						subtype: 'intact',
						user: { ingameName: 'IntactBuyer', status: 'online' },
					},
				],
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		);
	}

	function mockRelicOrders(): ReturnType<typeof vi.fn> {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (url === `https://api.warframe.market/v2/orders/item/${RELIC_SLUG}`) return relicOrdersResponse();
			throw new Error(`Unexpected url: ${url}`);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		return fetchMock;
	}

	it('rejects an unknown subtype before any upstream fetch', async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error('should not fetch upstream for an invalid subtype');
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/order-summary/${RELIC_SLUG}?subtype=shiny`), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_subtype' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects a subtype query on a non-relic slug', async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error('should not fetch upstream for a non-relic subtype query');
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('https://example.com/v1/order-summary/primed_flow?subtype=radiant'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ ok: false, error: 'invalid_subtype' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('summarizes only orders matching the requested subtype', async () => {
		mockRelicOrders();

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest(`https://example.com/v1/order-summary/${RELIC_SLUG}?subtype=radiant`),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: { slug: RELIC_SLUG, rank: null, subtype: 'radiant', wts: 20, wtb: 12 },
		});
	});

	it('caches each subtype under its own key', async () => {
		mockRelicOrders();

		const radiantCtx = createExecutionContext();
		await worker.fetch(new IncomingRequest(`https://example.com/v1/order-summary/${RELIC_SLUG}?subtype=radiant`), env, radiantCtx);
		await waitOnExecutionContext(radiantCtx);

		const intactCtx = createExecutionContext();
		const intact = await worker.fetch(
			new IncomingRequest(`https://example.com/v1/order-summary/${RELIC_SLUG}?subtype=intact`),
			env,
			intactCtx,
		);
		await waitOnExecutionContext(intactCtx);

		expect(await intact.json()).toMatchObject({ ok: true, data: { subtype: 'intact', wts: 4, wtb: 2 } });

		const radiantCached = JSON.parse(String(await env.PRICE_CACHE.get(`orders-summary:${RELIC_SLUG}:sradiant`))) as Record<string, unknown>;
		const intactCached = JSON.parse(String(await env.PRICE_CACHE.get(`orders-summary:${RELIC_SLUG}:sintact`))) as Record<string, unknown>;
		expect(radiantCached).toMatchObject({ subtype: 'radiant', wts: 20 });
		expect(intactCached).toMatchObject({ subtype: 'intact', wts: 4 });
		// The ranked family must stay untouched by subtype writes.
		expect(await env.PRICE_CACHE.get(`orders-summary:${RELIC_SLUG}`)).toBeNull();
	});

	it('serves a cached subtype summary without re-fetching', async () => {
		await env.PRICE_CACHE.put(
			`orders-summary:${RELIC_SLUG}:sradiant`,
			JSON.stringify({ slug: RELIC_SLUG, rank: null, subtype: 'radiant', wts: 999, wtb: 111, timestamp: Date.now() }),
		);
		const fetchMock = vi.fn(async () => {
			throw new Error('cached subtype summaries should not hit WFM');
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest(`https://example.com/v1/order-summary/${RELIC_SLUG}?subtype=radiant`),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, data: { wts: 999, wtb: 111 } });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('leaves bare relic requests on the ranked path', async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error('rank-less order summaries must fail validation before upstream');
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/order-summary/${RELIC_SLUG}`), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('discord supporters', () => {
	const ROLE_MAP = JSON.stringify({ r_basic: 'basic', r_big: 'big', r_biggest: 'biggest' });
	const MEMBERS_URL = 'https://discord.com/api/v10/guilds/guild-1/members';

	function discordEnv(overrides: Record<string, string> = {}): Env {
		return {
			...env,
			DISCORD_GUILD_ID: 'guild-1',
			DISCORD_BOT_TOKEN: 'bot-token',
			DISCORD_ROLE_TIER_MAP: ROLE_MAP,
			...overrides,
		} as unknown as Env;
	}

	function guildMember(
		id: string,
		roles: string[],
		names: { nick?: string | null; globalName?: string | null; username?: string; bot?: boolean } = {},
	): Record<string, unknown> {
		return {
			nick: names.nick ?? null,
			roles,
			user: {
				id,
				username: names.username ?? `user-${id}`,
				global_name: names.globalName ?? null,
				bot: names.bot === true,
			},
		};
	}

	function jsonPage(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	}

	async function storedSupporters(): Promise<{ updatedAt?: unknown; supporters?: Array<{ name: string; tier: string }> }> {
		const raw = await env.ITEM_META.get('supporters:discord:v1');
		return raw ? (JSON.parse(raw) as { updatedAt?: unknown; supporters?: Array<{ name: string; tier: string }> }) : {};
	}

	beforeEach(async () => {
		await caches.default.delete(new Request('https://example.com/v1/supporters?v=1'));
	});

	it('publishes only human members holding a mapped role, at their highest tier', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonPage([
				guildMember('1', ['r_basic'], { nick: 'Basic Betty' }),
				guildMember('2', ['r_basic', 'r_biggest', 'r_big'], { nick: 'Multi Mike' }),
				guildMember('3', ['r_unknown'], { nick: 'Roleless Rita' }),
				guildMember('4', [], { nick: 'Plain Pam' }),
				guildMember('5', ['r_biggest'], { nick: 'Bot Bert', bot: true }),
			]),
		) as unknown as typeof fetch;

		const result = await syncSupporters(discordEnv(), 'manual');

		expect(result).toEqual({ ok: true, status: 'synced', count: 2 });
		const stored = await storedSupporters();
		expect(stored.supporters).toEqual([
			{ name: 'Multi Mike', tier: 'biggest' },
			{ name: 'Basic Betty', tier: 'basic' },
		]);
		expect(typeof stored.updatedAt).toBe('string');
	});

	it('prefers the server nickname, then the global name, then the username', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonPage([
				guildMember('1', ['r_basic'], { nick: 'Chosen Nick', globalName: 'Global One', username: 'raw1' }),
				guildMember('2', ['r_basic'], { globalName: 'Global Gal', username: 'raw2' }),
				guildMember('3', ['r_basic'], { username: 'Raw Handle' }),
			]),
		) as unknown as typeof fetch;

		const result = await syncSupporters(discordEnv(), 'manual');

		expect(result).toMatchObject({ ok: true, count: 3 });
		expect((await storedSupporters()).supporters).toEqual([
			{ name: 'Chosen Nick', tier: 'basic' },
			{ name: 'Global Gal', tier: 'basic' },
			{ name: 'Raw Handle', tier: 'basic' },
		]);
	});

	it('pages with after until a short page arrives', async () => {
		const firstPage = Array.from({ length: 1000 }, (_, index) =>
			guildMember(String(index + 1), index === 0 ? ['r_basic'] : [], { nick: `Member ${index + 1}` }),
		);
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
			if (!url.startsWith(MEMBERS_URL)) throw new Error(`Unexpected url: ${url}`);
			if (url.includes('after=1000')) {
				return jsonPage([guildMember('1001', ['r_big'], { nick: 'Page Two Pat' })]);
			}
			return jsonPage(firstPage);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await syncSupporters(discordEnv(), 'manual');

		expect(result).toMatchObject({ ok: true, count: 2 });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect((await storedSupporters()).supporters).toEqual([
			{ name: 'Page Two Pat', tier: 'big' },
			{ name: 'Member 1', tier: 'basic' },
		]);
	});

	it('drops supporters excluded by user id or by case-insensitive name', async () => {
		await env.ITEM_META.put('supporters:exclusions:v1', JSON.stringify(['2', '  bIg SpEnDeR  ']));
		globalThis.fetch = vi.fn(async () =>
			jsonPage([
				guildMember('1', ['r_basic'], { nick: 'Visible Vic' }),
				guildMember('2', ['r_big'], { nick: 'Hidden By Id' }),
				guildMember('3', ['r_biggest'], { nick: 'Big Spender' }),
			]),
		) as unknown as typeof fetch;

		const result = await syncSupporters(discordEnv(), 'manual');

		expect(result).toMatchObject({ ok: true, count: 1 });
		expect((await storedSupporters()).supporters).toEqual([{ name: 'Visible Vic', tier: 'basic' }]);
	});

	it('fails closed on Discord auth and permission errors', async () => {
		globalThis.fetch = vi.fn(async () => jsonPage({ message: '401: Unauthorized' }, 401)) as unknown as typeof fetch;
		expect(await syncSupporters(discordEnv(), 'manual')).toEqual({ ok: false, error: 'discord_unauthorized' });

		globalThis.fetch = vi.fn(async () => jsonPage({ message: 'Missing Access' }, 403)) as unknown as typeof fetch;
		expect(await syncSupporters(discordEnv(), 'manual')).toEqual({ ok: false, error: 'discord_http_403' });
	});

	it('no-ops without a guild id, bot token, or role map', async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error('unconfigured supporter sync must not call upstream');
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const notConfigured = { ok: true, status: 'not_configured', count: 0 };
		expect(await syncSupporters(discordEnv({ DISCORD_GUILD_ID: '' }), 'cron')).toEqual(notConfigured);
		expect(await syncSupporters(discordEnv({ DISCORD_BOT_TOKEN: '' }), 'cron')).toEqual(notConfigured);
		expect(await syncSupporters(discordEnv({ DISCORD_ROLE_TIER_MAP: '' }), 'cron')).toEqual(notConfigured);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('purges the legacy Patreon KV keys on sync', async () => {
		await env.ITEM_META.put('patreon:supporters:v1', JSON.stringify({ supporters: [{ name: 'Real Name', tier: 'basic' }] }));
		await env.ITEM_META.put('patreon:tokens:v1', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }));
		await env.ITEM_META.put('patreon:exclusions:v1', JSON.stringify(['old']));
		globalThis.fetch = vi.fn(async () => jsonPage([guildMember('1', ['r_basic'], { nick: 'New Nick' })])) as unknown as typeof fetch;

		const result = await syncSupporters(discordEnv(), 'manual');

		expect(result).toMatchObject({ ok: true, count: 1 });
		expect(await env.ITEM_META.get('patreon:supporters:v1')).toBeNull();
		expect(await env.ITEM_META.get('patreon:tokens:v1')).toBeNull();
		expect(await env.ITEM_META.get('patreon:exclusions:v1')).toBeNull();
	});

	it('serves an empty supporters payload when the key is missing', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('https://example.com/v1/supporters'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, updatedAt: null, supporters: [] });
	});

	it('serves the published supporters with an hour of edge cache', async () => {
		await env.ITEM_META.put(
			'supporters:discord:v1',
			JSON.stringify({
				updatedAt: '2026-08-25T00:00:00.000Z',
				supporters: [
					{ name: 'Biggest Bea', tier: 'biggest' },
					{ name: 'Basic Bob', tier: 'basic' },
					{ name: '', tier: 'big' },
					{ name: 'Bogus Tier', tier: 'platinum' },
				],
			}),
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('https://example.com/v1/supporters'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
		expect(await response.json()).toEqual({
			ok: true,
			updatedAt: '2026-08-25T00:00:00.000Z',
			supporters: [
				{ name: 'Biggest Bea', tier: 'biggest' },
				{ name: 'Basic Bob', tier: 'basic' },
			],
		});
	});

	it('never serves names left behind by the retired Patreon pipeline', async () => {
		await env.ITEM_META.put(
			'patreon:supporters:v1',
			JSON.stringify({ updatedAt: '2026-08-25T00:00:00.000Z', supporters: [{ name: 'Real Name', tier: 'biggest' }] }),
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('https://example.com/v1/supporters'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, updatedAt: null, supporters: [] });
	});

	it('replaces the exclusion list and hides matching names immediately', async () => {
		await env.ITEM_META.put(
			'supporters:discord:v1',
			JSON.stringify({
				updatedAt: '2026-08-25T00:00:00.000Z',
				supporters: [
					{ name: 'Stays Steve', tier: 'big' },
					{ name: 'Leaves Lena', tier: 'basic' },
				],
			}),
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest('https://example.com/admin/supporters/exclusions', {
				method: 'POST',
				headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
				body: JSON.stringify({ set: ['leaves lena', '99', '', '99'] }),
			}),
			{ ...env, ADMIN_API_KEY: 'test-key' } as unknown as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, result: { exclusions: 2, removed: 1 } });
		expect(JSON.parse(String(await env.ITEM_META.get('supporters:exclusions:v1')))).toEqual(['leaves lena', '99']);
		expect((await storedSupporters()).supporters).toEqual([{ name: 'Stays Steve', tier: 'big' }]);
	});

	it('runs the sync from the admin route', async () => {
		globalThis.fetch = vi.fn(async () => jsonPage([guildMember('1', ['r_biggest'], { nick: 'Admin Amy' })])) as unknown as typeof fetch;

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest('https://example.com/admin/supporters/sync', {
				method: 'POST',
				headers: { authorization: 'Bearer test-key' },
			}),
			discordEnv({ ADMIN_API_KEY: 'test-key' }),
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, count: 1, status: 'synced' });
	});

	it('runs the supporter sync on the daily cron only', async () => {
		// The daily tick also archives Baro from the DE world state; nothing else may go upstream.
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.startsWith('https://api.warframe.com/cdn/worldState.php')) {
				return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
			}
			throw new Error(`unexpected daily cron request: ${url}`);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

		const ctx = createExecutionContext();
		await worker.scheduled({ cron: '0 4 * * *', scheduledTime: Date.now(), noRetry: () => undefined }, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'cron', route: 'supporters:sync', status: 204 }));
		expect(fetchMock.mock.calls.every(([input]) => String(input).startsWith('https://api.warframe.com/cdn/worldState.php'))).toBe(true);
	});
});

describe('relic subtype fallback', () => {
	const RELIC_SLUG = 'wf_test_lith_b1_relic';

	it('counts an order with no subtype as intact', async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ type: 'sell', platinum: 7, quantity: 1, visible: true, user: { ingameName: 'LegacySeller', status: 'ingame' } },
							{
								type: 'sell',
								platinum: 30,
								quantity: 1,
								visible: true,
								subtype: 'radiant',
								user: { ingameName: 'RadiantSeller', status: 'ingame' },
							},
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		) as unknown as typeof fetch;

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/order-summary/${RELIC_SLUG}?subtype=intact`), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, data: { subtype: 'intact', wts: 7 } });
	});
});
