import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { prewarmBatch, prewarmOrderSummaryCatalog } from '../src/services/prewarm';
import { WFM_SNAPSHOT_CLIENT_CACHE_VERSION } from '../../../config/shared/wfmSnapshotValidation';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
	(env as unknown as Record<string, string>).PUBLIC_BOOTSTRAP_REQUIRED = '0';
	(env as unknown as Record<string, string>).DAILY_BUDGET_ENABLED = '0';
	(env as unknown as Record<string, string>).CATALOG_SLUG_GUARD_ENABLED = '0';
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

describe('backend worker', () => {
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
		// Only origins listed in ALLOW_ORIGIN (wrangler.jsonc default: https://wfhelper.com)
		// are permitted from browser contexts. Requests from other origins are rejected
		// with 403 regardless of whether they carry auth credentials.
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
		// The desktop app itself runs as a file:// or app:// origin and doesn't send
		// an Origin header, but browser-based integrations using https://wfhelper.com
		// should be served normally.
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
			ADMIN_RATE_LIMIT_MAX: '2',
			ADMIN_RATE_LIMIT_WINDOW_SEC: '120',
		};

		const makeRequest = () =>
			new IncomingRequest('http://example.com/admin/prewarm', {
				method: 'POST',
				headers: {
					'cf-connecting-ip': '10.0.0.44',
					authorization: 'Bearer test-key',
				},
				body: JSON.stringify({ batchSize: 1 }),
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

		// The first two authed calls succeed (202), then the shared admin bucket
		// rejects the third request.
		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		expect(third.status).toBe(429);
		expect(await third.json()).toEqual({ ok: false, error: 'rate_limited' });
	});

	it('rate limits repeated unauthenticated admin requests', async () => {
		const testEnv = {
			...env,
			ADMIN_API_KEY: 'test-key',
			ADMIN_RATE_LIMIT_MAX: '2',
			ADMIN_RATE_LIMIT_WINDOW_SEC: '120',
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

		// The shared admin bucket is consumed before auth, so repeated failed
		// bearer attempts are rate-limited instead of getting unlimited 401s.
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
		const makeRequest = () =>
			new IncomingRequest('http://example.com/healthz', {
				headers: {
					'cf-connecting-ip': '10.0.0.55',
				},
			});

		const responses: Response[] = [];
		for (let i = 0; i < 6; i += 1) {
			const ctx = createExecutionContext();
			responses.push(await worker.fetch(makeRequest(), env, ctx));
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
			DAILY_BUDGET_SYNC_INTERVAL_SEC: '5',
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

	it('skips scheduled prewarm when the daily budget is already exceeded', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const testEnv = {
			...env,
			DAILY_BUDGET_ENABLED: '1',
			DAILY_BUDGET_MAX_REQUESTS: '2',
			DAILY_BUDGET_SAMPLE_RATE: '1',
			DAILY_BUDGET_SYNC_INTERVAL_SEC: '5',
		};
		await testEnv.PRICE_CACHE.put(`budget:requests:v1:${today}`, '2');
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
		await env.PRICE_CACHE.put('snapshot:etag:v1', '"snapshot-cors-test"');
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
			expect(browserResponse.headers.get('etag')).toBe(`"snapshot-cors-test-${WFM_SNAPSHOT_CLIENT_CACHE_VERSION}"`);
		} finally {
			await env.PRICE_CACHE.delete('snapshot:full:v1');
			await env.PRICE_CACHE.delete('snapshot:etag:v1');
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
		await env.PRICE_CACHE.put('snapshot:etag:v1', '"inactive-snapshot-test"');
		await clearSnapshotEdgeCache();

		try {
			const ctx = createExecutionContext();
			const response = await worker.fetch(new IncomingRequest('https://example.com/v1/snapshot'), env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get('etag')).toBe(`"inactive-snapshot-test-${WFM_SNAPSHOT_CLIENT_CACHE_VERSION}"`);
			const body = (await response.json()) as typeof snapshot;
			expect(body.prices.inactive_scene).toEqual({
				status: 'no_data',
				median: null,
				timestamp: generatedAt,
			});

			const oldEtagCtx = createExecutionContext();
			const oldEtagResponse = await worker.fetch(
				new IncomingRequest('https://example.com/v1/snapshot', {
					headers: { 'if-none-match': '"inactive-snapshot-test"' },
				}),
				env,
				oldEtagCtx,
			);
			await waitOnExecutionContext(oldEtagCtx);
			expect(oldEtagResponse.status).toBe(200);
		} finally {
			await env.PRICE_CACHE.delete('snapshot:full:v1');
			await env.PRICE_CACHE.delete('snapshot:etag:v1');
			await clearSnapshotEdgeCache();
		}
	});

	it('honors If-None-Match when the snapshot is already edge-cached', async () => {
		const snapshot = { version: 1, generatedAt: Date.now(), prices: {}, meta: {}, orderSummaries: {} };
		await env.PRICE_CACHE.put('snapshot:full:v1', JSON.stringify(snapshot));
		await env.PRICE_CACHE.put('snapshot:etag:v1', '"snapshot-test-etag"');
		await clearSnapshotEdgeCache();

		try {
			const primeCtx = createExecutionContext();
			const primeResponse = await worker.fetch(new IncomingRequest('https://example.com/v1/snapshot'), env, primeCtx);
			await waitOnExecutionContext(primeCtx);
			expect(primeResponse.status).toBe(200);
			expect(primeResponse.headers.get('etag')).toBe(`"snapshot-test-etag-${WFM_SNAPSHOT_CLIENT_CACHE_VERSION}"`);

			const matchingCtx = createExecutionContext();
			const matchingResponse = await worker.fetch(
				new IncomingRequest('https://example.com/v1/snapshot', {
					headers: { 'if-none-match': `"snapshot-test-etag-${WFM_SNAPSHOT_CLIENT_CACHE_VERSION}"` },
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
			expect(matchingResponse.headers.get('etag')).toBe(`"snapshot-test-etag-${WFM_SNAPSHOT_CLIENT_CACHE_VERSION}"`);
			expect(matchingResponse.headers.get('cache-control')).toBe('public, max-age=7200');
			expect(await matchingResponse.text()).toBe('');
			expect(nonMatchingResponse.status).toBe(200);
			expect(await nonMatchingResponse.json()).toMatchObject({ version: 1 });
		} finally {
			await env.PRICE_CACHE.delete('snapshot:full:v1');
			await env.PRICE_CACHE.delete('snapshot:etag:v1');
			await clearSnapshotEdgeCache();
		}
	});

	it('rate limits repeated snapshot requests from same IP', async () => {
		const snapshot = { version: 1, generatedAt: Date.now(), prices: {}, meta: {}, orderSummaries: {} };
		await env.PRICE_CACHE.put('snapshot:full:v1', JSON.stringify(snapshot));

		// Clear any edge-cached snapshot from prior tests so every request goes
		// through the Worker and hits the rate limiter.
		await clearSnapshotEdgeCache();

		const testEnv = { ...env, PUBLIC_RATE_LIMIT_ENABLED: '1' };
		const makeRequest = () =>
			new IncomingRequest('https://example.com/v1/snapshot', {
				headers: { 'cf-connecting-ip': '10.0.0.99' },
			});

		const responses: Response[] = [];
		try {
			for (let i = 0; i < 11; i++) {
				// Clear edge cache before each request so every iteration hits the Worker.
				await clearSnapshotEdgeCache();
				const ctx = createExecutionContext();
				responses.push(await worker.fetch(makeRequest(), testEnv as unknown as Env, ctx));
				await waitOnExecutionContext(ctx);
			}
			expect(responses[9].status).toBe(200);
			expect(responses[10].status).toBe(429);
			expect(await responses[10].json()).toEqual({ ok: false, error: 'rate_limited' });
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
});
