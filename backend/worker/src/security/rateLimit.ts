import { jsonResponse } from './cors';
import type { Env } from '../types';
import { getWorkerConfig } from '../config';
import { clientIp } from '../utils';

type PublicRateLimitRoute = 'healthz' | 'bootstrap' | 'prices' | 'meta' | 'order-summary' | 'orders' | 'snapshot';

function publicLimiter(env: Env, route: PublicRateLimitRoute): RateLimit {
	if (route === 'healthz') return env.PUBLIC_HEALTH_RATE_LIMITER;
	if (route === 'snapshot') return env.PUBLIC_SNAPSHOT_RATE_LIMITER;
	if (route === 'bootstrap' || route === 'orders') return env.PUBLIC_LOW_RATE_LIMITER;
	return env.PUBLIC_API_RATE_LIMITER;
}

export async function checkPublicRateLimit(req: Request, env: Env, route: PublicRateLimitRoute): Promise<Response | null> {
	if (!getWorkerConfig(env).publicRateLimitEnabled) return null;

	try {
		const result = await publicLimiter(env, route).limit({ key: `${route}:${clientIp(req)}` });
		return result.success
			? null
			: jsonResponse({ ok: false, error: 'rate_limited' }, req, env, 429, { 'retry-after': '60' });
	} catch {
		return null;
	}
}

export async function checkAdminRateLimit(req: Request, env: Env): Promise<Response | null> {
	try {
		const result = await env.ADMIN_RATE_LIMITER.limit({ key: clientIp(req) });
		return result.success ? null : jsonResponse({ ok: false, error: 'rate_limited' }, req, env, 429, { 'retry-after': '60' });
	} catch {
		return jsonResponse({ ok: false, error: 'rate_limit_unavailable' }, req, env, 503);
	}
}
