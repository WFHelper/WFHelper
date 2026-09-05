import { handleAdminRoutes } from './routes/admin';
import { handlePublicRoutes } from './routes/public';
import { jsonResponse, originIsAllowed } from './security/cors';
import { checkDailyBudget, isDailyBudgetExceeded } from './security/dailyBudget';
import { getWorkerConfig } from './config';
import { refreshAdversaryVendors } from './services/adversaryVendors';
import { archiveBaroVisit, archiveDailyPrices, sweepRivenArchive } from './services/history';
import { logEvent, takeResponseLogFields } from './services/logging';
import { prewarmBatch, prewarmOrderSummaryCatalog } from './services/prewarm';
import { seedPriceHistory } from './services/priceHistorySeed';
import { syncSupporters } from './services/supporters';
import { sweepTopTraded } from './services/topTraded';
import type { Env } from './types';

// Must match the daily trigger in wrangler.jsonc; every other cron tick prewarms. The
// daily tick owns the supporter sync plus the price and Baro archives.
const DAILY_CRON = '0 4 * * *';

/** UTC time of a fixed-time daily cron ("M H * * *"), or null for any other shape. */
function dailyCronUtcTime(cron: string): { hour: number; minute: number } | null {
	const [minute, hour, ...rest] = cron.split(' ');
	if (rest.join(' ') !== '* * *') return null;
	const h = Number(hour);
	const m = Number(minute);
	if (!Number.isInteger(h) || h < 0 || h > 23) return null;
	if (!Number.isInteger(m) || m < 0 || m > 59) return null;
	return { hour: h, minute: m };
}

// Read off the cron so moving the daily trigger moves the guard with it.
const DAILY_CRON_UTC_TIME = dailyCronUtcTime(DAILY_CRON);
if (!DAILY_CRON_UTC_TIME) {
	logEvent({ type: 'error', route: 'cron:price-archive', status: 500, error: 'daily_cron_unparseable' });
}

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
	if (pathname === '/v1/wfm-items') return { type: 'request', route: '/v1/wfm-items' };
	if (pathname === '/v1/supporters') return { type: 'request', route: '/v1/supporters' };
	if (pathname === '/v1/top-traded') return { type: 'request', route: '/v1/top-traded' };
	if (pathname === '/v1/adversary-vendors') return { type: 'request', route: '/v1/adversary-vendors' };

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

/** A daily cron this cannot read names no free minute, so every tick defers
 *  rather than racing the daily invocation on the shared archive index. */
export function sharesTheDailyCronMinute(
	scheduledTime: number | undefined,
	dailyTime: { hour: number; minute: number } | null = DAILY_CRON_UTC_TIME,
): boolean {
	if (!dailyTime) return true;
	if (typeof scheduledTime !== 'number' || !Number.isFinite(scheduledTime)) return false;
	const at = new Date(scheduledTime);
	return at.getUTCHours() === dailyTime.hour && at.getUTCMinutes() === dailyTime.minute;
}

// Each cron stage is isolated: one throwing upstream call must not cost the
// remaining stages their tick.
async function runCronStage(route: string, stage: () => Promise<unknown>): Promise<void> {
	const start = performance.now();
	try {
		await stage();
	} catch (err) {
		logEvent({
			type: 'error',
			route,
			status: 500,
			latencyMs: Math.round(performance.now() - start),
			error: err instanceof Error ? err.message : 'unknown_error',
		});
	}
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
		const daily = controller.cron === DAILY_CRON;
		// Cloudflare fires both triggers on the daily minute as two concurrent
		// invocations, and both price stages read-modify-write the same archive index,
		// so the quarter-hour tick that lands there defers them to its next tick.
		const priceArchiveDeferred = !daily && sharesTheDailyCronMinute(controller.scheduledTime);
		try {
			// Copies medians the worker already holds and makes no upstream request, so
			// it runs ahead of the budget gate and of every stage that can throw.
			if (daily) await runCronStage('cron:prices', () => archiveDailyPrices(env));

			if (await isDailyBudgetExceeded(env)) {
				logEvent({
					type: 'cron',
					route,
					status: 204,
					latencyMs: Math.round(performance.now() - start),
				});
				return;
			}

			if (daily) {
				await runCronStage('cron:supporters', () => syncSupporters(env, 'cron'));
				await runCronStage('cron:baro', () => archiveBaroVisit(env));
				logEvent({
					type: 'cron',
					route,
					status: 200,
					latencyMs: Math.round(performance.now() - start),
				});
				return;
			}

			const config = getWorkerConfig(env);
			await runCronStage('cron:prewarm', () =>
				prewarmBatch(env, {
					reason: 'cron',
					batchSize: config.prewarmBatchSize,
					refreshCatalog: false,
					resetCursor: false,
				}),
			);
			await runCronStage('cron:order-summary', () =>
				prewarmOrderSummaryCatalog(env, {
					reason: 'cron',
					batchSize: config.orderSummaryPrewarmBatchSize,
					refreshCatalog: false,
				}),
			);
			await runCronStage('cron:rivens', () => sweepRivenArchive(env));
			if (priceArchiveDeferred) {
				logEvent({ type: 'cron', route: 'cron:price-archive', status: 204, error: 'deferred_to_next_tick' });
			} else {
				await runCronStage('cron:price-seed', () => seedPriceHistory(env));
				await runCronStage('cron:top-traded', () => sweepTopTraded(env));
			}
			await runCronStage('cron:adversary-vendors', () => refreshAdversaryVendors(env));
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
