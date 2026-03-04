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

	it('blocks disallowed origins', async () => {
		const request = new IncomingRequest('http://example.com/healthz', {
			headers: {
				Origin: 'https://evil.example',
			},
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
					Origin: 'http://localhost:5173',
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

	it('caches negative miss for absent price data', async () => {
		const slug = 'wf_test_negative_slug';

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
		expect(await env.PRICE_CACHE.get(`miss:price:${slug}`)).toBe('1');
	});
});
