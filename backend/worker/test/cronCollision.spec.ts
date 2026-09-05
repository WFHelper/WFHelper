import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { sharesTheDailyCronMinute } from '../src/index';

const originalFetch = globalThis.fetch;

/** The daily trigger the worker guards against; edit it here and in src/index.ts together. */
const DAILY_CRON = '0 4 * * *';

function quarterHourTickAt(scheduledTime: number): ScheduledController {
	return { cron: '*/15 * * * *', scheduledTime, noRetry: () => undefined } as ScheduledController;
}

function quarterHourTick(iso: string): ScheduledController {
	return quarterHourTickAt(Date.parse(iso));
}

async function runTick(controller: ScheduledController): Promise<unknown[]> {
	const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
	const ctx = createExecutionContext();
	await worker.scheduled(controller, env, ctx);
	await waitOnExecutionContext(ctx);
	const entries = logSpy.mock.calls.map(([entry]) => entry);
	logSpy.mockRestore();
	return entries;
}

describe('cron collision at 04:00 UTC', () => {
	beforeEach(() => {
		(env as unknown as Record<string, string>).DAILY_BUDGET_ENABLED = '0';
		globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		globalThis.fetch = originalFetch;
	});

	it('runs the price archive stages on an ordinary quarter-hour tick', async () => {
		const entries = await runTick(quarterHourTick('2026-09-05T04:15:00.000Z'));

		expect(entries).toContainEqual(expect.objectContaining({ route: 'archive:price-seed' }));
		expect(entries).toContainEqual(expect.objectContaining({ route: 'top-traded:sweep' }));
	});

	// Both triggers fire at 04:00 as separate concurrent invocations, and the daily
	// one archives the day's prices; a second writer would lose the index update.
	it('leaves the price archive to the daily tick on the minute they share', async () => {
		const entries = await runTick(quarterHourTick('2026-09-05T04:00:00.000Z'));

		expect(entries).toContainEqual(expect.objectContaining({ route: 'cron:price-archive', status: 204, error: 'deferred_to_next_tick' }));
		expect(entries).not.toContainEqual(expect.objectContaining({ route: 'archive:price-seed' }));
		expect(entries).not.toContainEqual(expect.objectContaining({ route: 'top-traded:sweep' }));
	});

	// The guard reads its hour and minute off the daily cron string, so moving the
	// trigger moves the shared minute instead of silently disarming the guard.
	it('holds the archive on the minute the daily cron names, and only there', async () => {
		const [minute, hour] = DAILY_CRON.split(' ').map(Number);
		const shared = Date.UTC(2026, 8, 5, hour, minute);

		const onTheMinute = await runTick(quarterHourTickAt(shared));
		const anHourLater = await runTick(quarterHourTickAt(shared + 60 * 60 * 1000));

		expect(onTheMinute).toContainEqual(expect.objectContaining({ route: 'cron:price-archive', status: 204 }));
		expect(anHourLater).toContainEqual(expect.objectContaining({ route: 'archive:price-seed' }));
		expect(anHourLater).not.toContainEqual(expect.objectContaining({ route: 'cron:price-archive' }));
	});

	// An unreadable daily cron cannot name the shared minute, and guessing "not
	// this one" is the failure the guard exists to prevent.
	it('defers on every tick when the daily cron cannot be parsed', () => {
		const [minute, hour] = DAILY_CRON.split(' ').map(Number);
		const noon = Date.UTC(2026, 8, 5, 12, 30);

		expect(sharesTheDailyCronMinute(noon, null)).toBe(true);
		expect(sharesTheDailyCronMinute(noon, { hour, minute })).toBe(false);
		expect(sharesTheDailyCronMinute(Date.UTC(2026, 8, 5, hour, minute), { hour, minute })).toBe(true);
	});

	it('keeps the daily tick itself archiving on the shared minute', async () => {
		await env.PRICE_CACHE.put(
			'snapshot:full:v1',
			JSON.stringify({
				version: 1,
				generatedAt: Date.parse('2026-09-05T04:00:00.000Z'),
				prices: { ash_prime_set: { status: 'ok', median: 120 } },
				meta: {},
				orderSummaries: {},
			}),
		);
		const controller = {
			cron: DAILY_CRON,
			scheduledTime: Date.parse('2026-09-05T04:00:00.000Z'),
			noRetry: () => undefined,
		} as ScheduledController;

		const entries = await runTick(controller);

		expect(entries).toContainEqual(expect.objectContaining({ route: 'archive:prices', status: 200 }));
	});
});
