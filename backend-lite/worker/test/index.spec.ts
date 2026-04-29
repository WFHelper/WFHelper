import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
	(env as unknown as Record<string, string>).PUBLIC_BOOTSTRAP_REQUIRED = '0';
});

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.fetch = originalFetch;
});

describe('backend-lite worker', () => {
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
		expect((await response.json() as Record<string, unknown>).ok).toBe(true);
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

	it('auto-hydrates price endpoint on cache miss', async () => {
		const slug = 'wf_test_price_slug';
		await env.PRICE_CACHE.delete(`price:${slug}`);
		await env.PRICE_CACHE.delete(`miss:price:v2:${slug}`);
		await env.PRICE_CACHE.delete(`price:${slug}:r0`);
		await env.PRICE_CACHE.delete(`miss:price:v2:${slug}:r0`);

		const statsPayload = {
			payload: {
				statistics_closed: {
					'48hours': [{ order_type: 'sell', datetime: '2026-03-01T00:00:00.000Z', median: 42 }],
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

	it('supports ranked price lookups for mod and arcane stats', async () => {
		const slug = 'wf_test_ranked_price_slug';
		await env.PRICE_CACHE.delete(`price:${slug}:r0`);
		await env.PRICE_CACHE.delete(`price:${slug}:r10`);
		await env.PRICE_CACHE.delete(`miss:price:v2:${slug}:r0`);
		await env.PRICE_CACHE.delete(`miss:price:v2:${slug}:r10`);

		const statsPayload = {
			payload: {
				statistics_closed: {
					'48hours': [
						{ order_type: 'sell', datetime: '2026-03-01T00:00:00.000Z', median: 50, mod_rank: 0 },
						{ order_type: 'sell', datetime: '2026-03-01T01:00:00.000Z', median: 175, mod_rank: 10 },
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

	it('auto-hydrates orders endpoint on cache miss', async () => {
		const slug = 'wf_test_orders_slug';
		await env.PRICE_CACHE.delete(`orders:${slug}`);
		await env.PRICE_CACHE.delete(`miss:orders:v2:${slug}`);

		const ordersPayload = {
			data: [
				{
					type: 'sell',
					platinum: 4,
					quantity: 2,
					rank: 10,
					visible: true,
					user: { ingameName: 'SellerA', status: 'ingame' },
				},
				{
					type: 'buy',
					platinum: 3,
					quantity: 1,
					rank: 10,
					visible: true,
					user: { ingameName: 'BuyerA', status: 'online' },
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

		const enabledOrdersEnv = {
			...env,
			ENABLE_PUBLIC_ORDERS_ROUTE: '1',
		};
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest(`https://example.com/v1/orders/${slug}`),
			enabledOrdersEnv as unknown as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: {
				slug,
				sell: [{ userName: 'SellerA', platinum: 4, quantity: 2, rank: 10 }],
				buy: [{ userName: 'BuyerA', platinum: 3, quantity: 1, rank: 10 }],
			},
		});

		const cached = await env.PRICE_CACHE.get(`orders:${slug}`);
		expect(cached).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.warframe.market/v2/orders/item/${slug}`);
	});

	it('deprecates public full orderbook route by default', async () => {
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

	it('auto-hydrates order summary endpoint on cache miss', async () => {
		const slug = 'wf_test_order_summary_slug';
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

	it('serves stale cached order summary during transient upstream failure', async () => {
		const slug = 'wf_test_stale_order_summary_slug';
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

	it('filters orders by rank and preserves offline statuses', async () => {
		const slug = 'wf_test_ranked_orders_slug';
		await env.PRICE_CACHE.delete(`orders:${slug}:r10`);
		await env.PRICE_CACHE.delete(`miss:orders:v2:${slug}:r10`);

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

		const enabledOrdersEnv = {
			...env,
			ENABLE_PUBLIC_ORDERS_ROUTE: '1',
		};
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest(`https://example.com/v1/orders/${slug}?rank=10`),
			enabledOrdersEnv as unknown as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: {
				slug,
				rank: 10,
				sell: [{ userName: 'SellerR10', platinum: 140, rank: 10, status: 'offline' }],
				buy: [{ userName: 'BuyerR10', platinum: 100, rank: 10, status: 'invisible' }],
			},
		});

		expect(await env.PRICE_CACHE.get(`orders:${slug}:r10`)).toBeTruthy();
	});

	it('keeps active rank orders even when many cheaper offline rows exist', async () => {
		const slug = 'wf_test_rank_activity_window_slug';
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

		const enabledOrdersEnv = {
			...env,
			ENABLE_PUBLIC_ORDERS_ROUTE: '1',
		};
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest(`https://example.com/v1/orders/${slug}?rank=0`),
			enabledOrdersEnv as unknown as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = (await response.json()) as {
			data?: { sell?: Array<{ userName?: string; status?: string }> };
		};
		const sellRows = Array.isArray(json?.data?.sell) ? json.data.sell : [];
		expect(sellRows.some((row) => row.userName === 'ActiveSellerR0' && row.status === 'ingame')).toBe(true);
	});

	it('falls back to v1 orders endpoint when v2 endpoint is unavailable', async () => {
		const slug = 'wf_test_orders_fallback_slug';
		await env.PRICE_CACHE.delete(`orders:${slug}`);
		await env.PRICE_CACHE.delete(`miss:orders:v2:${slug}`);

		const v1OrdersPayload = {
			payload: {
				orders: [
					{
						order_type: 'sell',
						platinum: 9,
						quantity: 1,
						visible: true,
						user: { ingame_name: 'SellerFallback', status: 'ingame' },
					},
					{
						order_type: 'buy',
						platinum: 8,
						quantity: 1,
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

		const enabledOrdersEnv = {
			...env,
			ENABLE_PUBLIC_ORDERS_ROUTE: '1',
		};
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest(`https://example.com/v1/orders/${slug}`),
			enabledOrdersEnv as unknown as Env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			data: {
				slug,
				sell: [{ userName: 'SellerFallback', platinum: 9, quantity: 1 }],
				buy: [{ userName: 'BuyerFallback', platinum: 8, quantity: 1 }],
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
		const snapshot = {
			version: 1,
			generatedAt: Date.now(),
			prices: { ash_prime: { status: 'ok', median: 45, timestamp: Date.now() } },
			meta: { ash_prime: { slug: 'ash_prime', ducats: 45, setRoot: true, thumb: null, icon: null, timestamp: Date.now() } },
			orderSummaries: {},
		};
		await env.PRICE_CACHE.put('snapshot:full:v1', JSON.stringify(snapshot));
		await caches.default.delete(new Request('https://example.com/v1/snapshot'));

		try {
			const ctx = createExecutionContext();
			const response = await worker.fetch(new IncomingRequest('https://example.com/v1/snapshot'), env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('application/json');
			expect(response.headers.get('cache-control')).toBe('public, max-age=7200');

			const body = (await response.json()) as typeof snapshot;
			expect(body.version).toBe(1);
			expect(body.prices['ash_prime']).toMatchObject({ status: 'ok', median: 45 });
		} finally {
			await env.PRICE_CACHE.delete('snapshot:full:v1');
			await caches.default.delete(new Request('https://example.com/v1/snapshot'));
		}
	});

	it('honors If-None-Match when the snapshot is already edge-cached', async () => {
		const snapshot = { version: 1, generatedAt: Date.now(), prices: {}, meta: {}, orderSummaries: {} };
		await env.PRICE_CACHE.put('snapshot:full:v1', JSON.stringify(snapshot));
		await env.PRICE_CACHE.put('snapshot:etag:v1', '"snapshot-test-etag"');
		await caches.default.delete(new Request('https://example.com/v1/snapshot'));

		try {
			const primeCtx = createExecutionContext();
			const primeResponse = await worker.fetch(new IncomingRequest('https://example.com/v1/snapshot'), env, primeCtx);
			await waitOnExecutionContext(primeCtx);
			expect(primeResponse.status).toBe(200);
			expect(primeResponse.headers.get('etag')).toBe('"snapshot-test-etag"');

			const matchingCtx = createExecutionContext();
			const matchingResponse = await worker.fetch(
				new IncomingRequest('https://example.com/v1/snapshot', {
					headers: { 'if-none-match': '"snapshot-test-etag"' },
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
			expect(matchingResponse.headers.get('etag')).toBe('"snapshot-test-etag"');
			expect(matchingResponse.headers.get('cache-control')).toBe('public, max-age=7200');
			expect(await matchingResponse.text()).toBe('');
			expect(nonMatchingResponse.status).toBe(200);
			expect(await nonMatchingResponse.json()).toMatchObject({ version: 1 });
		} finally {
			await env.PRICE_CACHE.delete('snapshot:full:v1');
			await env.PRICE_CACHE.delete('snapshot:etag:v1');
			await caches.default.delete(new Request('https://example.com/v1/snapshot'));
		}
	});

	it('rate limits repeated snapshot requests from same IP', async () => {
		const snapshot = { version: 1, generatedAt: Date.now(), prices: {}, meta: {}, orderSummaries: {} };
		await env.PRICE_CACHE.put('snapshot:full:v1', JSON.stringify(snapshot));

		// Clear any edge-cached snapshot from prior tests so every request goes
		// through the Worker and hits the rate limiter.
		await caches.default.delete(new Request('https://example.com/v1/snapshot'));

		const testEnv = { ...env, PUBLIC_RATE_LIMIT_ENABLED: '1' };
		const makeRequest = () =>
			new IncomingRequest('https://example.com/v1/snapshot', {
				headers: { 'cf-connecting-ip': '10.0.0.99' },
			});

		const responses: Response[] = [];
		try {
			for (let i = 0; i < 11; i++) {
				// Clear edge cache before each request so every iteration hits the Worker.
				await caches.default.delete(new Request('https://example.com/v1/snapshot'));
				const ctx = createExecutionContext();
				responses.push(await worker.fetch(makeRequest(), testEnv as unknown as Env, ctx));
				await waitOnExecutionContext(ctx);
			}
			expect(responses[9].status).toBe(200);
			expect(responses[10].status).toBe(429);
			expect(await responses[10].json()).toEqual({ ok: false, error: 'rate_limited' });
		} finally {
			await env.PRICE_CACHE.delete('snapshot:full:v1');
			await caches.default.delete(new Request('https://example.com/v1/snapshot'));
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
