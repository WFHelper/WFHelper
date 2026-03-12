import { handleAdminRoutes } from './routes/admin';
import { handlePublicRoutes } from './routes/public';
import { buildFullSnapshot, prewarmBatch, prewarmOrderSummaryCatalog } from './services/prewarm';
import { jsonResponse, originIsAllowed } from './security/cors';
import { SNAPSHOT_LAST_GEN_KEY } from './constants';
import type { Env } from './types';
import { parsePositiveInt } from './utils';

async function handleFetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(req.url);

	if (!originIsAllowed(req, env)) {
		return jsonResponse({ ok: false, error: 'forbidden_origin' }, req, env, 403);
	}

	if (req.method === 'OPTIONS') {
		return jsonResponse({ ok: true }, req, env, 200);
	}

	const publicRouteResponse = await handlePublicRoutes(req, url, env, ctx);
	if (publicRouteResponse) return publicRouteResponse;

	const adminRouteResponse = await handleAdminRoutes(req, url, env);
	if (adminRouteResponse) return adminRouteResponse;

	return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
}

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			return await handleFetch(req, env, ctx);
		} catch (err) {
			return jsonResponse({ ok: false, error: 'internal_error', detail: String(err) }, req, env, 500);
		}
	},

	async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		await prewarmBatch(env, {
			reason: 'cron',
			batchSize: parsePositiveInt(env.PREWARM_BATCH_SIZE, 8),
			refreshCatalog: false,
			resetCursor: false,
		});
		await prewarmOrderSummaryCatalog(env, {
			reason: 'cron',
			batchSize: parsePositiveInt(env.ORDER_SUMMARY_PREWARM_BATCH_SIZE, 12),
			refreshCatalog: false,
		});

		// Rebuild the full snapshot blob at most once per SNAPSHOT_REFRESH_INTERVAL_SEC.
		const snapshotRefreshMs = parsePositiveInt(env.SNAPSHOT_REFRESH_INTERVAL_SEC, 7200) * 1000;
		const lastGenRaw = await env.PRICE_CACHE.get(SNAPSHOT_LAST_GEN_KEY);
		const lastGen = lastGenRaw ? parseInt(lastGenRaw, 10) : 0;
		if (Date.now() - lastGen > snapshotRefreshMs) {
			await buildFullSnapshot(env);
		}
	},
} satisfies ExportedHandler<Env>;
