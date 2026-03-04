import { PREWARM_LAST_RUN_KEY } from '../constants';
import { prewarmBatch } from '../services/prewarm';
import { jsonResponse } from '../security/cors';
import { checkAdminRateLimit } from '../security/rateLimit';
import type { Env } from '../types';
import { getJsonFromKv, parseJsonBody, parsePositiveInt } from '../utils';

function isAdminAuthorized(req: Request, env: Env): boolean {
	const auth = req.headers.get('authorization') || '';
	return Boolean(env.ADMIN_API_KEY) && auth === `Bearer ${env.ADMIN_API_KEY}`;
}

export async function handleAdminRoutes(req: Request, url: URL, env: Env): Promise<Response | null> {
	if (req.method === 'POST' && url.pathname === '/admin/prewarm') {
		const rateLimited = await checkAdminRateLimit(req, env);
		if (rateLimited) return rateLimited;

		if (!isAdminAuthorized(req, env)) {
			return jsonResponse({ ok: false, error: 'unauthorized' }, req, env, 401);
		}

		const body = parseJsonBody(await req.text());
		const result = await prewarmBatch(env, {
			reason: 'manual',
			batchSize: parsePositiveInt(String(body.batchSize || ''), parsePositiveInt(env.PREWARM_BATCH_SIZE, 8)),
			resetCursor: Boolean(body.resetCursor),
			refreshCatalog: Boolean(body.refreshCatalog),
		});

		return jsonResponse({ ok: true, result }, req, env, 202);
	}

	if (req.method === 'GET' && url.pathname === '/admin/prewarm/status') {
		if (!isAdminAuthorized(req, env)) {
			return jsonResponse({ ok: false, error: 'unauthorized' }, req, env, 401);
		}

		const result = await getJsonFromKv(env.PRICE_CACHE, PREWARM_LAST_RUN_KEY);
		return jsonResponse({ ok: true, result }, req, env, 200);
	}

	return null;
}
