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
	if (!origin) return true;

	const allowList = allowedOrigins(env);
	if (allowList.includes('*')) return true;
	return allowList.includes(origin);
}

export function jsonResponse(data: unknown, req: Request, env: Env, status = 200): Response {
	const headers: Record<string, string> = {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'public, max-age=60',
		'x-content-type-options': 'nosniff',
		'access-control-allow-methods': 'GET,POST,OPTIONS',
		'access-control-allow-headers': 'content-type,authorization',
		vary: 'Origin',
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
