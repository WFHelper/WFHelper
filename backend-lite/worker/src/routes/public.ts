import { PREWARM_LAST_RUN_KEY } from '../constants';
import { jsonResponse } from '../security/cors';
import { getAutoCacheConfig, getAutoCacheStats, getOrHydrateMeta, getOrHydratePrice } from '../services/readThrough';
import type { Env } from '../types';
import { getJsonFromKv, getSlug } from '../utils';

export async function handlePublicRoutes(req: Request, url: URL, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
	if (url.pathname === '/healthz' && req.method === 'GET') {
		const prewarmState = await getJsonFromKv(env.PRICE_CACHE, PREWARM_LAST_RUN_KEY);
		return jsonResponse(
			{
				ok: true,
				service: 'wf-backend-lite',
				ts: Date.now(),
				automation: {
					enabled: true,
					config: getAutoCacheConfig(env),
					stats: getAutoCacheStats(),
				},
				prewarm: prewarmState,
			},
			req,
			env,
			200,
		);
	}

	const priceSlug = getSlug(url.pathname, '/v1/prices/');
	if (req.method === 'GET' && priceSlug) {
		const data = await getOrHydratePrice(env, priceSlug, ctx);
		if (!data) return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
		return jsonResponse({ ok: true, data }, req, env, 200);
	}

	const metaSlug = getSlug(url.pathname, '/v1/meta/');
	if (req.method === 'GET' && metaSlug) {
		const data = await getOrHydrateMeta(env, metaSlug, ctx);
		if (!data) return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
		return jsonResponse({ ok: true, data }, req, env, 200);
	}

	return null;
}
