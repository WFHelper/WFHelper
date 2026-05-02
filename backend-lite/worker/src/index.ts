import { handleAdminRoutes } from './routes/admin';
import { handlePublicRoutes } from './routes/public';
import { prewarmBatch, prewarmOrderSummaryCatalog } from './services/prewarm';
import { jsonResponse, originIsAllowed } from './security/cors';
import type { Env } from './types';
import { getWorkerConfig } from './config';

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
			console.error('[worker] Unhandled error:', err);
			return jsonResponse({ ok: false, error: 'internal_error' }, req, env, 500);
		}
	},

	async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		const config = getWorkerConfig(env);
		await prewarmBatch(env, {
			reason: 'cron',
			batchSize: config.prewarmBatchSize,
			refreshCatalog: false,
			resetCursor: false,
		});
		await prewarmOrderSummaryCatalog(env, {
			reason: 'cron',
			batchSize: config.orderSummaryPrewarmBatchSize,
			refreshCatalog: false,
		});
		// The snapshot is maintained incrementally: patchSnapshot() is called at the end of every
		// prewarmBatch and prewarmOrderSummaryCatalog tick, so after one full cursor pass (~1-2 hours)
		// the snapshot contains 100% of catalog items with no per-invocation subrequest cap.
		// buildFullSnapshot() is kept only as an admin-triggered cold-boot seed — do NOT call it here.
	},
} satisfies ExportedHandler<Env>;
