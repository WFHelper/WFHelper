import type { Env } from '../types';

export function requestOrigin(req: Request): string {
	return req.headers.get('origin') || '';
}

function allowedOrigins(env: Env): string[] {
	return (env.ALLOW_ORIGIN || '')
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean);
}

export function originIsAllowed(req: Request, env: Env): boolean {
	const origin = requestOrigin(req);
	// No Origin header → non-browser client (Electron, curl, Worker-to-Worker).
	// CORS only guards cross-site browser requests, so these are unaffected.
	if (!origin) return true;

	const allowList = allowedOrigins(env);
	// Wildcard is intentionally NOT supported. A misconfigured "*" in production
	// would allow any site to read authenticated responses. Browser clients must
	// come from an explicitly listed origin; all other clients pass the !origin
	// check above.
	return allowList.includes(origin);
}

export function jsonResponse(data: unknown, req: Request, env: Env, status = 200, extraHeaders?: Record<string, string>): Response {
	const headers: Record<string, string> = {
		'content-type': 'application/json; charset=utf-8',
		// Only allow CDN/browser caching for successful responses.
		// Error responses (4xx, 5xx) must never be cached: a cached 429 would
		// make legitimate clients look rate-limited, and a cached 403 / 401
		// would silently block users even after the condition is resolved.
		'cache-control': status === 200 ? 'public, max-age=60' : 'no-store',
		'x-content-type-options': 'nosniff',
		'access-control-allow-methods': 'GET,POST,OPTIONS',
		'access-control-allow-headers': 'content-type,authorization,x-wfhelper-bootstrap',
		vary: 'Origin',
		...(extraHeaders || {}),
	};

	const origin = requestOrigin(req);
	if (origin && originIsAllowed(req, env)) {
		headers['access-control-allow-origin'] = origin;
	}

	return new Response(JSON.stringify(data), {
		status,
		headers,
	});
}
