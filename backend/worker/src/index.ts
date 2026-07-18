import { handleAdminRoutes } from './routes/admin';
import { handlePublicRoutes } from './routes/public';
import { jsonResponse, originIsAllowed } from './security/cors';
import { checkDailyBudget, isDailyBudgetExceeded } from './security/dailyBudget';
import { getWorkerConfig } from './config';
import { logEvent, takeResponseLogFields } from './services/logging';
import { prewarmBatch, prewarmOrderSummaryCatalog } from './services/prewarm';
import type { Env } from './types';

export { DailyBudgetCounter } from './security/dailyBudget';
export { SnapshotCoordinator } from './services/prewarm';

type RouteMetadata = {
	type: 'request' | 'admin';
	route: string;
	slug?: string;
};

function routeMetadata(req: Request): RouteMetadata {
	const url = new URL(req.url);
	const pathname = url.pathname;

	if (req.method === 'OPTIONS') return { type: 'request', route: 'options' };
	if (pathname === '/healthz') return { type: 'request', route: '/healthz' };
	if (pathname === '/v1/bootstrap') return { type: 'request', route: '/v1/bootstrap' };
	if (pathname === '/v1/snapshot') return { type: 'request', route: '/v1/snapshot' };

	const publicSlugRoutes = [
		['/v1/prices/', '/v1/prices/:slug'],
		['/v1/meta/', '/v1/meta/:slug'],
		['/v1/order-summary/', '/v1/order-summary/:slug'],
		['/v1/orders/', '/v1/orders/:slug'],
	] as const;
	for (const [prefix, route] of publicSlugRoutes) {
		if (pathname.startsWith(prefix)) {
			return { type: 'request', route, slug: pathname.slice(prefix.length) || undefined };
		}
	}

	if (pathname.startsWith('/admin/')) return { type: 'admin', route: pathname };
	return { type: 'request', route: 'not_found' };
}

async function handleFetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(req.url);

	if (!originIsAllowed(req, env)) {
		return jsonResponse({ ok: false, error: 'forbidden_origin' }, req, env, 403);
	}

	if (req.method === 'OPTIONS') {
		return jsonResponse({ ok: true }, req, env, 200);
	}

	const budgetResponse = await checkDailyBudget(req, env);
	if (budgetResponse) return budgetResponse;

	const publicRouteResponse = await handlePublicRoutes(req, url, env, ctx);
	if (publicRouteResponse) return publicRouteResponse;

	const adminRouteResponse = await handleAdminRoutes(req, url, env);
	if (adminRouteResponse) return adminRouteResponse;

	return jsonResponse({ ok: false, error: 'not_found' }, req, env, 404);
}

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const start = performance.now();
		const route = routeMetadata(req);
		try {
			const response = await handleFetch(req, env, ctx);
			logEvent({
				...takeResponseLogFields(response),
				type: route.type,
				route: route.route,
				method: req.method,
				status: response.status,
				latencyMs: Math.round(performance.now() - start),
				slug: route.slug,
			});
			return response;
		} catch (err) {
			logEvent({
				type: 'error',
				route: route.route,
				method: req.method,
				status: 500,
				latencyMs: Math.round(performance.now() - start),
				slug: route.slug,
				error: err instanceof Error ? err.message : 'unknown_error',
			});
			return jsonResponse({ ok: false, error: 'internal_error' }, req, env, 500);
		}
	},

	async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		const start = performance.now();
		const route = controller.cron || 'scheduled';
		try {
			if (await isDailyBudgetExceeded(env)) {
				logEvent({
					type: 'cron',
					route,
					status: 204,
					latencyMs: Math.round(performance.now() - start),
				});
				return;
			}

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
			logEvent({
				type: 'cron',
				route,
				status: 200,
				latencyMs: Math.round(performance.now() - start),
			});
			// One full cursor pass gradually refreshes the complete snapshot.
		} catch (err) {
			logEvent({
				type: 'error',
				route,
				status: 500,
				latencyMs: Math.round(performance.now() - start),
				error: err instanceof Error ? err.message : 'unknown_error',
			});
			throw err;
		}
	},
} satisfies ExportedHandler<Env>;
