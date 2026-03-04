import { jsonResponse } from './cors';
import type { Env } from '../types';
import { clamp, parsePositiveInt } from '../utils';

function clientIp(req: Request): string {
	const cfIp = req.headers.get('cf-connecting-ip');
	if (cfIp) return cfIp;

	const xff = req.headers.get('x-forwarded-for');
	if (!xff) return 'unknown';
	return xff.split(',')[0].trim() || 'unknown';
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
