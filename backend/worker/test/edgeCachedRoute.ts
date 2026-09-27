import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { expect } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const ORIGIN = 'https://wfhelper.com';
const STALE_ETAG = '"stale-0"';
const CACHE_CONTROL = 'public, max-age=3600';
const testEnv = env as unknown as Env;

async function get(path: string, headers: Record<string, string>): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new IncomingRequest(`http://example.com${path}`, { headers }), testEnv, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

// Cron-owned document routes share one edge-cache contract; the KV doc is deleted
// before the cache-hit requests so only the edge copy can answer them.
export async function expectEdgeCachedDocRoute(path: string, cacheKey: string, docKey: string): Promise<void> {
	const miss = await get(path, { origin: ORIGIN, 'if-none-match': STALE_ETAG });
	expect(miss.status).toBe(200);
	expect(miss.headers.get('access-control-allow-origin')).toBe(ORIGIN);
	expect(miss.headers.get('cache-control')).toBe(CACHE_CONTROL);
	const etag = miss.headers.get('etag') ?? '';
	expect(etag).toMatch(/^".+"$/);
	const body = await miss.text();
	const stored = await caches.default.match(cacheKey);
	expect(stored?.headers.get('etag')).toBe(etag);
	expect(stored?.headers.get('cache-control')).toBe(CACHE_CONTROL);
	expect(await stored?.text()).toBe(body);

	await caches.default.delete(cacheKey);
	const revalidated = await get(path, { 'if-none-match': etag });
	expect(revalidated.status).toBe(304);
	expect(revalidated.headers.get('etag')).toBe(etag);
	expect(revalidated.headers.get('cache-control')).toBe(CACHE_CONTROL);
	expect(revalidated.headers.get('access-control-allow-origin')).toBeNull();
	expect(await revalidated.text()).toBe('');
	expect(await caches.default.match(cacheKey)).toBeUndefined();

	expect((await get(path, {})).status).toBe(200);
	await env.ITEM_META.delete(docKey);

	const cachedMatch = await get(path, { origin: ORIGIN, 'if-none-match': etag });
	expect(cachedMatch.status).toBe(304);
	expect(cachedMatch.headers.get('etag')).toBe(etag);
	expect(cachedMatch.headers.get('cache-control')).toBe(CACHE_CONTROL);
	expect(cachedMatch.headers.get('access-control-allow-origin')).toBe(ORIGIN);
	expect(await cachedMatch.text()).toBe('');

	const cached = await get(path, { origin: ORIGIN, 'if-none-match': STALE_ETAG });
	expect(cached.status).toBe(200);
	expect(cached.headers.get('etag')).toBe(etag);
	expect(cached.headers.get('cache-control')).toBe(CACHE_CONTROL);
	expect(cached.headers.get('content-type')).toBe('application/json; charset=utf-8');
	expect(cached.headers.get('access-control-allow-origin')).toBe(ORIGIN);
	expect(await cached.text()).toBe(body);
}
