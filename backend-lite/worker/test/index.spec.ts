import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const originalFetch = globalThis.fetch;

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
		expect(await response.json()).toMatchObject({
			ok: true,
			service: 'wf-backend-lite',
		});
	});

	it('blocks credentialed wildcard-origin requests', async () => {
		// With ALLOW_ORIGIN=*, credentialed requests (Authorization header)
		// from browser origins must be blocked per CORS spec.
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
					authorization: 'Bearer wrong-key',
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

		expect(first.status).toBe(401);
		expect(second.status).toBe(401);
		expect(third.status).toBe(429);
		expect(await third.json()).toEqual({ ok: false, error: 'rate_limited' });
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

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/orders/${slug}`), env, ctx);
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
				body: JSON.stringify({ batchSize: 1 }),
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

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/orders/${slug}?rank=10`), env, ctx);
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

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/orders/${slug}?rank=0`), env, ctx);
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

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(`https://example.com/v1/orders/${slug}`), env, ctx);
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
