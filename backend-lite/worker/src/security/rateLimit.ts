import { jsonResponse } from './cors';
import type { Env } from '../types';
import { clamp, clientIp, parsePositiveInt } from '../utils';

type PublicRateLimitRoute = 'healthz' | 'bootstrap' | 'prices' | 'meta' | 'order-summary' | 'orders';

const PUBLIC_ROUTE_LIMITS: Record<PublicRateLimitRoute, { maxRequests: number; windowSec: number }> = {
	healthz: { maxRequests: 5, windowSec: 60 },
	bootstrap: { maxRequests: 60, windowSec: 600 },
	prices: { maxRequests: 900, windowSec: 600 },
	meta: { maxRequests: 900, windowSec: 600 },
	'order-summary': { maxRequests: 500, windowSec: 600 },
	orders: { maxRequests: 60, windowSec: 600 },
};

export async function checkPublicRateLimit(req: Request, env: Env, route: PublicRateLimitRoute): Promise<Response | null> {
	if ((env.PUBLIC_RATE_LIMIT_ENABLED || '1').trim() === '0') return null;

	const config = PUBLIC_ROUTE_LIMITS[route];
	const windowSec = config.windowSec;
	const bucket = Math.floor(Date.now() / 1000 / windowSec);
	const key = `rl:public:${route}:${clientIp(req)}:${bucket}`;

	const currentCount = Number((await env.PRICE_CACHE.get(key)) || '0');
	if (Number.isFinite(currentCount) && currentCount >= config.maxRequests) {
		return jsonResponse({ ok: false, error: 'rate_limited' }, req, env, 429, { 'retry-after': String(windowSec) });
	}

	await env.PRICE_CACHE.put(key, String((Number.isFinite(currentCount) ? currentCount : 0) + 1), {
		expirationTtl: windowSec + 5,
	});

	return null;
}

export async function checkAdminRateLimit(req: Request, env: Env): Promise<Response | null> {
	const windowSec = clamp(parsePositiveInt(env.ADMIN_RATE_LIMIT_WINDOW_SEC, 60), 10, 3600);
	const maxRequests = clamp(parsePositiveInt(env.ADMIN_RATE_LIMIT_MAX, 12), 1, 500);
	const bucket = Math.floor(Date.now() / 1000 / windowSec);
	const key = `rl:admin:${clientIp(req)}:${bucket}`;

	const currentCount = Number((await env.PRICE_CACHE.get(key)) || '0');
	if (Number.isFinite(currentCount) && currentCount >= maxRequests) {
		return jsonResponse({ ok: false, error: 'rate_limited' }, req, env, 429);
	}

	await env.PRICE_CACHE.put(key, String((Number.isFinite(currentCount) ? currentCount : 0) + 1), {
		expirationTtl: windowSec + 5,
	});

	return null;
}
