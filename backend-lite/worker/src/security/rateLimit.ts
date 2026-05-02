import { jsonResponse } from './cors';
import type { Env } from '../types';
import { getWorkerConfig } from '../config';
import { clientIp } from '../utils';

type PublicRateLimitRoute = 'healthz' | 'bootstrap' | 'prices' | 'meta' | 'order-summary' | 'orders' | 'snapshot';

// These KV counters are best-effort, not atomic: parallel requests can race
// between get() and put(). Cloudflare edge rate limiting is the primary bot
// control; these route buckets are a secondary in-Worker guardrail.
//
// The counters intentionally live in PRICE_CACHE with an `rl:` prefix. Keep the
// shared namespace unless operational noise or blast-radius pressure justifies a
// dedicated binding.
//
// 2000 req/10 min per IP per route comfortably covers a legitimate desktop user
// with a large inventory on a cold cache (~1000 requests observed), while
// refusing the 20k+ storms a scraper or runaway loop would produce. Real bot
// traffic is caught at the edge before it reaches these counters.
const PUBLIC_ROUTE_LIMITS: Record<PublicRateLimitRoute, { maxRequests: number; windowSec: number }> = {
	healthz: { maxRequests: 5, windowSec: 60 },
	bootstrap: { maxRequests: 60, windowSec: 600 },
	prices: { maxRequests: 2000, windowSec: 600 },
	meta: { maxRequests: 2000, windowSec: 600 },
	'order-summary': { maxRequests: 2000, windowSec: 600 },
	orders: { maxRequests: 60, windowSec: 600 },
	// Snapshot is a large payload (~850 KB). Edge cache absorbs nearly all real
	// traffic (cache-control: public, max-age=7200); this limit only fires on
	// cache misses or scrapers. One per ~10 min per IP is ample for legitimate use.
	snapshot: { maxRequests: 10, windowSec: 600 },
};

export async function checkPublicRateLimit(req: Request, env: Env, route: PublicRateLimitRoute): Promise<Response | null> {
	if (!getWorkerConfig(env).publicRateLimitEnabled) return null;

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
	const config = getWorkerConfig(env);
	const windowSec = config.adminRateLimitWindowSec;
	const maxRequests = config.adminRateLimitMax;
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
