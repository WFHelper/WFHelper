import type { Env } from '../types';

function requestOrigin(req: Request): string {
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

function responseHeaders(req: Request, env: Env, extraHeaders?: Record<string, string>): Record<string, string> {
	const headers: Record<string, string> = {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
		'referrer-policy': 'no-referrer',
		'strict-transport-security': 'max-age=31536000; includeSubDomains',
		'x-content-type-options': 'nosniff',
		'x-frame-options': 'DENY',
		'access-control-allow-methods': 'GET,POST,OPTIONS',
		'access-control-allow-headers': 'content-type,authorization,x-wfhelper-bootstrap',
		vary: 'Origin',
		...(extraHeaders || {}),
	};

	const origin = requestOrigin(req);
	if (origin && originIsAllowed(req, env)) {
		headers['access-control-allow-origin'] = origin;
	}

	return headers;
}

export function jsonResponse(data: unknown, req: Request, env: Env, status = 200, extraHeaders?: Record<string, string>): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: responseHeaders(req, env, extraHeaders),
	});
}

export function rawJsonResponse(raw: string, req: Request, env: Env, status = 200, extraHeaders?: Record<string, string>): Response {
	return new Response(raw, {
		status,
		headers: responseHeaders(req, env, extraHeaders),
	});
}

export function emptyResponse(req: Request, env: Env, status = 204, extraHeaders?: Record<string, string>): Response {
	const headers = responseHeaders(req, env, extraHeaders);
	delete headers['content-type'];
	return new Response(null, {
		status,
		headers,
	});
}
