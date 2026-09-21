import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { parseClientHeader } from '../src/security/client';
import type { Env } from '../src/types';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const ALLOWED_ORIGIN = 'https://wfhelper.com';

// Log entries are plain objects, so anything outside this set would be a new field
// nobody reviewed for private data.
const ALLOWED_LOG_KEYS = new Set([
	'type',
	'route',
	'method',
	'status',
	'latencyMs',
	'slug',
	'client',
	'clientVersion',
	'cacheHit',
	'count',
	'bytes',
	'error',
]);

function setVars(vars: Record<string, string>): void {
	Object.assign(env as unknown as Record<string, string>, vars);
}

function rateLimiter(maxRequests: number): RateLimit {
	let count = 0;
	return {
		limit: vi.fn(async () => ({ success: ++count <= maxRequests })),
	} as unknown as RateLimit;
}

async function send(
	path: string,
	options: { client?: string; origin?: string; method?: string; headers?: Record<string, string>; env?: Env } = {},
): Promise<Response> {
	const headers: Record<string, string> = { ...options.headers };
	if (options.client !== undefined) headers['x-wfhelper-client'] = options.client;
	if (options.origin !== undefined) headers.origin = options.origin;

	const request = new IncomingRequest(`http://example.com${path}`, { method: options.method || 'GET', headers });
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, options.env || env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

beforeEach(() => {
	setVars({
		PUBLIC_BOOTSTRAP_REQUIRED: '0',
		DAILY_BUDGET_ENABLED: '0',
		PUBLIC_RATE_LIMIT_ENABLED: '0',
		ALLOW_ORIGIN: ALLOWED_ORIGIN,
		PUBLIC_CLIENT_POLICY: 'log',
		PUBLIC_CLIENT_ALLOW: 'WFHelper',
		PUBLIC_CLIENT_DENY: '',
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	setVars({ PUBLIC_CLIENT_POLICY: 'log', PUBLIC_CLIENT_ALLOW: 'WFHelper', PUBLIC_CLIENT_DENY: '' });
});

describe('client identity header', () => {
	it('parses a product and version and rejects junk', () => {
		const identity = (value: string) =>
			parseClientHeader(new IncomingRequest('http://example.com/healthz', { headers: { 'x-wfhelper-client': value } }));

		expect(identity('WFHelper/1.4.2')).toEqual({ product: 'WFHelper', version: '1.4.2' });
		expect(identity(' PlatHelper/2.0.0-beta.1 ')).toEqual({ product: 'PlatHelper', version: '2.0.0-beta.1' });
		expect(identity('WFHelper')).toBeNull();
		expect(identity('WFHelper/')).toBeNull();
		expect(identity('WFHelper/v1.4.2')).toBeNull();
		expect(identity('<script>/1.0.0')).toBeNull();
		expect(identity(`WFHelper/${'9'.repeat(120)}`)).toBeNull();
	});

	it('blocks nothing under the log policy', async () => {
		expect((await send('/v1/supporters')).status).toBe(200);
		expect((await send('/v1/supporters', { client: 'PlatHelper/2.0.0' })).status).toBe(200);
		expect((await send('/v1/supporters', { client: 'not a client' })).status).toBe(200);
	});

	it('refuses a header-less public request under the enforce policy', async () => {
		setVars({ PUBLIC_CLIENT_POLICY: 'enforce' });

		const response = await send('/v1/supporters');
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ ok: false, error: 'forbidden_client' });

		expect((await send('/v1/feedback', { method: 'POST' })).status).toBe(403);
	});

	it('serves an allow-listed product under the enforce policy', async () => {
		setVars({ PUBLIC_CLIENT_POLICY: 'enforce' });

		expect((await send('/v1/supporters', { client: 'WFHelper/1.4.2' })).status).toBe(200);
		// The allow list is compared without case.
		expect((await send('/v1/supporters', { client: 'wfhelper/0.0.0' })).status).toBe(200);
	});

	it('refuses an unlisted product and a junk header under the enforce policy', async () => {
		setVars({ PUBLIC_CLIENT_POLICY: 'enforce' });

		expect((await send('/v1/supporters', { client: 'PlatHelper/2.0.0' })).status).toBe(403);
		expect((await send('/v1/supporters', { client: 'gibberish' })).status).toBe(403);
	});

	// A list that parses to nothing must not lock every client out.
	it('keeps the default allow list when PUBLIC_CLIENT_ALLOW is only whitespace', async () => {
		setVars({ PUBLIC_CLIENT_POLICY: 'enforce', PUBLIC_CLIENT_ALLOW: '  ,  ' });

		expect((await send('/v1/supporters', { client: 'WFHelper/1.4.2' })).status).toBe(200);
		expect((await send('/v1/supporters', { client: 'PlatHelper/2.0.0' })).status).toBe(403);
	});

	it('refuses a deny-listed product even while only logging', async () => {
		setVars({ PUBLIC_CLIENT_DENY: 'PlatHelper' });

		expect((await send('/v1/supporters', { client: 'PlatHelper/2.0.0' })).status).toBe(403);
		expect((await send('/v1/supporters', { client: 'WFHelper/1.4.2' })).status).toBe(200);
		expect((await send('/v1/supporters')).status).toBe(200);
	});

	it('exempts healthz, admin routes and allowed browser origins under enforce', async () => {
		setVars({ PUBLIC_CLIENT_POLICY: 'enforce' });

		expect((await send('/healthz')).status).toBe(200);
		expect((await send('/v1/supporters', { origin: ALLOWED_ORIGIN })).status).toBe(200);

		const adminEnv = { ...env, ADMIN_API_KEY: 'test-key', ADMIN_RATE_LIMITER: rateLimiter(10) } as unknown as Env;
		const admin = await send('/admin/prewarm/status', {
			headers: { authorization: 'Bearer test-key', 'cf-connecting-ip': '10.0.0.70' },
			env: adminEnv,
		});
		expect(admin.status).toBe(200);
	});

	it('answers a preflight without the header', async () => {
		setVars({ PUBLIC_CLIENT_POLICY: 'enforce' });
		const response = await send('/v1/supporters', { method: 'OPTIONS' });

		expect(response.status).toBe(200);
		expect(response.headers.get('access-control-allow-headers')).toContain('x-wfhelper-client');
	});

	it('logs the product and version and nothing else about the caller', async () => {
		const entries: Record<string, unknown>[] = [];
		vi.spyOn(console, 'log').mockImplementation((entry: unknown) => {
			if (entry && typeof entry === 'object') entries.push(entry as Record<string, unknown>);
		});

		await send('/v1/supporters', { client: 'WFHelper/1.4.2', headers: { 'cf-connecting-ip': '10.0.0.71' } });

		const entry = entries.find((candidate) => candidate.type === 'request');
		expect(entry).toMatchObject({ route: '/v1/supporters', client: 'WFHelper', clientVersion: '1.4.2' });
		expect(Object.keys(entry || {}).filter((key) => !ALLOWED_LOG_KEYS.has(key))).toEqual([]);
		expect(JSON.stringify(entry)).not.toContain('10.0.0.71');
	});

	it('records a header-less caller as none', async () => {
		const entries: Record<string, unknown>[] = [];
		vi.spyOn(console, 'log').mockImplementation((entry: unknown) => {
			if (entry && typeof entry === 'object') entries.push(entry as Record<string, unknown>);
		});

		await send('/v1/supporters');

		const entry = entries.find((candidate) => candidate.type === 'request');
		expect(entry?.client).toBe('none');
		expect(entry).not.toHaveProperty('clientVersion');
	});
});
