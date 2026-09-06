import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { resetRankedCatalogCacheForTest } from '../src/routes/public';
import { resetRankedSlugCacheForTest } from '../src/services/prewarmCatalog';
import { buildTopTraded, sweepTopTraded } from '../src/services/topTraded';
import type { Env } from '../src/types';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const CATALOG_SLUGS_KEY = 'catalog:slugs:v1';
const CLIENT_CATALOG_KEY = 'catalog:client-items:v2';
const RANKED_CATALOG_KEY = 'order-summary:catalog:v1';
const SWEEP_KEY = 'top-traded:sweep:v1';
const DOC_KEY = 'top-traded:v1';
const NOW = Date.parse('2026-09-02T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const originalFetch = globalThis.fetch;

interface StatsRow {
	daysAgo: number;
	median: number;
	volume?: number;
	rank?: number;
}

beforeEach(() => {
	(env as unknown as Record<string, string>).HISTORY_ARCHIVE_ENABLED = '1';
	(env as unknown as Record<string, string>).HISTORY_RETENTION_DAYS = '730';
	(env as unknown as Record<string, string>).TOP_TRADED_ENABLED = '1';
	(env as unknown as Record<string, string>).TOP_TRADED_BATCH_SIZE = '150';
	(env as unknown as Record<string, string>).PUBLIC_BOOTSTRAP_REQUIRED = '0';
	(env as unknown as Record<string, string>).DAILY_BUDGET_ENABLED = '0';
	(env as unknown as Record<string, string>).PUBLIC_RATE_LIMIT_ENABLED = '0';
	resetRankedCatalogCacheForTest();
	resetRankedSlugCacheForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.fetch = originalFetch;
});

function testEnv(overrides: Record<string, string> = {}): Env {
	return { ...env, ...overrides } as unknown as Env;
}

function jsonOk(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function dateFor(daysAgo: number): string {
	return new Date(NOW - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

async function readJson(key: string): Promise<Record<string, unknown> | null> {
	const raw = await env.ITEM_META.get(key);
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

async function seedCatalog(slugs: string[]): Promise<void> {
	await env.ITEM_META.put(CATALOG_SLUGS_KEY, JSON.stringify({ updatedAt: Date.now(), slugs, rankedSummaryCatalog: [] }));
}

async function seedRankedCatalog(entries: Array<{ slug: string; maxRank: number }>): Promise<void> {
	await env.ITEM_META.put(RANKED_CATALOG_KEY, JSON.stringify({ updatedAt: Date.now(), entries }));
}

async function seedDay(date: string, rows: unknown[], extra: Record<string, unknown> = {}): Promise<void> {
	await env.ITEM_META.put(
		`archive:prices:${date}`,
		JSON.stringify({ v: 1, date, generatedAt: 111, source: 'snapshot', columns: ['key', 'median', 'volume'], rows, ...extra }),
	);
}

function statsPayload(rows: StatsRow[]): unknown {
	return {
		payload: {
			statistics_closed: {
				'90days': rows.map((row) => ({
					datetime: `${dateFor(row.daysAgo)}T00:00:00.000+00:00`,
					median: row.median,
					...(row.volume == null ? {} : { volume: row.volume }),
					...(row.rank == null ? {} : { mod_rank: row.rank }),
				})),
			},
		},
	};
}

function mockStatistics(stats: Record<string, unknown | Response>): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		const match = /^https:\/\/api\.warframe\.market\/v1\/items\/([^/]+)\/statistics$/.exec(url);
		if (match) {
			const result = stats[decodeURIComponent(match[1])];
			if (result === undefined) throw new Error(`Unexpected slug: ${match[1]}`);
			return result instanceof Response ? result : jsonOk(result);
		}
		throw new Error(`Unexpected url: ${url}`);
	});
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

describe('top traded volume sweep', () => {
	it('walks the catalog in batches and wraps the cursor at the end of a pass', async () => {
		await seedCatalog(['alpha', 'beta', 'gamma']);
		await seedRankedCatalog([]);
		await seedDay(dateFor(1), [['alpha', 100]]);
		await seedDay(dateFor(2), [['beta', 50]]);
		mockStatistics({
			alpha: statsPayload([{ daysAgo: 1, median: 100, volume: 12 }]),
			beta: statsPayload([{ daysAgo: 2, median: 50, volume: 4 }]),
			gamma: statsPayload([{ daysAgo: 1, median: 30, volume: 9 }]),
		});
		const sweepEnv = testEnv({ TOP_TRADED_BATCH_SIZE: '2' });

		const first = await sweepTopTraded(sweepEnv, { now: NOW });
		expect(first).toMatchObject({ status: 'progress', slugs: 3, cursorBefore: 0, cursorAfter: 2, processed: 2, failures: 0 });
		expect(await readJson(SWEEP_KEY)).toMatchObject({ cursor: 2, lastCompletedAt: 0 });

		const second = await sweepTopTraded(sweepEnv, { now: NOW + 900_000 });
		expect(second).toMatchObject({ status: 'complete', cursorBefore: 2, cursorAfter: 3, processed: 1 });
		// The pass wraps instead of latching, and the completion time is recorded.
		expect(await readJson(SWEEP_KEY)).toMatchObject({ cursor: 0, lastCompletedAt: NOW + 900_000, failures: 0 });

		expect((await readJson(`archive:prices:${dateFor(1)}`))?.rows).toEqual([
			['alpha', 100, 12],
			['gamma', 30, 9],
		]);
		expect((await readJson(`archive:prices:${dateFor(2)}`))?.rows).toEqual([['beta', 50, 4]]);
	});

	it('restarts the pass when the catalog list changes under the cursor', async () => {
		await seedCatalog(['alpha', 'beta']);
		await seedRankedCatalog([]);
		await seedDay(dateFor(1), []);
		mockStatistics({
			alpha: statsPayload([{ daysAgo: 1, median: 10, volume: 1 }]),
			beta: statsPayload([{ daysAgo: 1, median: 20, volume: 2 }]),
			zeta: statsPayload([{ daysAgo: 1, median: 30, volume: 3 }]),
		});
		const sweepEnv = testEnv({ TOP_TRADED_BATCH_SIZE: '1' });

		await sweepTopTraded(sweepEnv, { now: NOW });
		expect(await readJson(SWEEP_KEY)).toMatchObject({ cursor: 1 });

		await seedCatalog(['alpha', 'beta', 'zeta']);
		const second = await sweepTopTraded(sweepEnv, { now: NOW + 900_000 });

		expect(second).toMatchObject({ status: 'progress', slugs: 3, cursorBefore: 0, cursorAfter: 1 });
	});

	it('counts a failed slug without latching and revisits it on the next pass', async () => {
		await seedCatalog(['alpha']);
		await seedRankedCatalog([]);
		await seedDay(dateFor(1), []);
		let calls = 0;
		globalThis.fetch = vi.fn(async () => {
			calls += 1;
			return calls === 1 ? new Response('boom', { status: 503 }) : jsonOk(statsPayload([{ daysAgo: 1, median: 7, volume: 5 }]));
		}) as unknown as typeof fetch;

		const first = await sweepTopTraded(testEnv(), { now: NOW });
		expect(first).toMatchObject({ status: 'complete', processed: 1, failures: 1 });
		expect(await readJson(SWEEP_KEY)).toMatchObject({ cursor: 0 });

		const second = await sweepTopTraded(testEnv(), { now: NOW + 900_000 });
		expect(second).toMatchObject({ status: 'complete', failures: 0 });
		expect((await readJson(`archive:prices:${dateFor(1)}`))?.rows).toEqual([['alpha', 7, 5]]);
	});

	it('takes the rank 0 volume for a slug in the ranked catalog', async () => {
		await seedCatalog(['primed_flow']);
		await seedRankedCatalog([{ slug: 'primed_flow', maxRank: 10 }]);
		await seedDay(dateFor(1), []);
		mockStatistics({
			primed_flow: statsPayload([
				{ daysAgo: 1, median: 50, volume: 40, rank: 0 },
				{ daysAgo: 1, median: 123, volume: 3, rank: 10 },
			]),
		});

		await sweepTopTraded(testEnv(), { now: NOW });

		expect((await readJson(`archive:prices:${dateFor(1)}`))?.rows).toEqual([['primed_flow', 50, 40]]);
	});

	it('leaves the cursor unmoved when a catalog is unavailable', async () => {
		await env.ITEM_META.delete(RANKED_CATALOG_KEY);
		await seedCatalog(['alpha']);
		const fetchMock = mockStatistics({ alpha: statsPayload([{ daysAgo: 1, median: 7, volume: 5 }]) });

		const result = await sweepTopTraded(testEnv(), { now: NOW });

		expect(result).toMatchObject({ status: 'no_catalog', slugs: 1 });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await env.ITEM_META.get(SWEEP_KEY)).toBeNull();
	});

	it('is a no-op when the sweep or the archive family is switched off', async () => {
		await seedCatalog(['alpha']);
		await seedRankedCatalog([]);
		const fetchMock = mockStatistics({ alpha: statsPayload([{ daysAgo: 1, median: 7, volume: 5 }]) });

		expect((await sweepTopTraded(testEnv({ TOP_TRADED_ENABLED: '0' }), { now: NOW })).status).toBe('disabled');
		expect((await sweepTopTraded(testEnv({ HISTORY_ARCHIVE_ENABLED: '0' }), { now: NOW })).status).toBe('disabled');
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await env.ITEM_META.get(SWEEP_KEY)).toBeNull();
	});
});

describe('top traded volume merge', () => {
	it('never overwrites a median or a volume the archive already holds', async () => {
		await seedCatalog(['alpha', 'beta', 'gamma']);
		await seedRankedCatalog([]);
		await seedDay(dateFor(1), [
			['alpha', 100, 3],
			['beta', 55],
		]);
		mockStatistics({
			alpha: statsPayload([{ daysAgo: 1, median: 999, volume: 77 }]),
			beta: statsPayload([{ daysAgo: 1, median: 999, volume: 8 }]),
			gamma: statsPayload([{ daysAgo: 1, median: 30, volume: 9 }]),
		});

		await sweepTopTraded(testEnv(), { now: NOW });

		const stored = await readJson(`archive:prices:${dateFor(1)}`);
		expect(stored).toMatchObject({ generatedAt: 111, source: 'snapshot' });
		expect(stored?.rows).toEqual([
			['alpha', 100, 3],
			['beta', 55, 8],
			['gamma', 30, 9],
		]);
	});

	it('never creates the current UTC day, which the daily archive owns', async () => {
		await seedCatalog(['alpha']);
		await seedRankedCatalog([]);
		mockStatistics({
			alpha: statsPayload([
				{ daysAgo: 0, median: 10, volume: 4 },
				{ daysAgo: 1, median: 11, volume: 5 },
			]),
		});

		await sweepTopTraded(testEnv(), { now: NOW });

		expect(await env.ITEM_META.get(`archive:prices:${dateFor(0)}`)).toBeNull();
		// A past day the archive missed is still filled, and it joins the index.
		expect((await readJson(`archive:prices:${dateFor(1)}`))?.rows).toEqual([['alpha', 11, 5]]);
		expect((await readJson('archive:index:prices:v1'))?.entries).toEqual([dateFor(1)]);
	});

	it('writes no volume for the current UTC day once the daily archive created its key', async () => {
		await seedCatalog(['alpha']);
		await seedRankedCatalog([]);
		await seedDay(dateFor(0), [['alpha', 10]]);
		await seedDay(dateFor(1), [['alpha', 11]]);
		mockStatistics({
			alpha: statsPayload([
				{ daysAgo: 0, median: 10, volume: 4 },
				{ daysAgo: 1, median: 11, volume: 5 },
			]),
		});

		const result = await sweepTopTraded(testEnv(), { now: NOW });

		// Today's volume is still growing and a merged row is never replaced, so a
		// partial value would freeze and be read as a complete day tomorrow.
		expect((await readJson(`archive:prices:${dateFor(0)}`))?.rows).toEqual([['alpha', 10]]);
		expect((await readJson(`archive:prices:${dateFor(1)}`))?.rows).toEqual([['alpha', 11, 5]]);
		expect(result).toMatchObject({ dates: 1, filled: 1, added: 0 });
	});

	it('still reaches the oldest day the aggregate reads and stops before it', async () => {
		await seedCatalog(['alpha']);
		await seedRankedCatalog([]);
		mockStatistics({
			alpha: statsPayload([
				{ daysAgo: 7, median: 20, volume: 6 },
				{ daysAgo: 8, median: 21, volume: 7 },
			]),
		});

		await sweepTopTraded(testEnv(), { now: NOW });

		expect((await readJson(`archive:prices:${dateFor(7)}`))?.rows).toEqual([['alpha', 20, 6]]);
		expect(await env.ITEM_META.get(`archive:prices:${dateFor(8)}`)).toBeNull();
	});
});

describe('top traded aggregate', () => {
	async function seedLabels(): Promise<void> {
		await env.ITEM_META.put(
			CLIENT_CATALOG_KEY,
			JSON.stringify({
				updatedAt: 1,
				items: [
					{ id: 'a', slug: 'alpha', name: 'Alpha Prime Set', thumb: 'items/alpha.png', icon: null, maxRank: null, gameRef: null },
					{ id: 'b', slug: 'beta', name: 'Beta Prime Set', thumb: null, icon: null, maxRank: null, gameRef: null },
				],
			}),
		);
	}

	it('sums the last seven complete days, keeps the newest median and sorts both ways', async () => {
		await seedLabels();
		await seedDay(dateFor(0), [['alpha', 5, 500]]);
		await seedDay(dateFor(1), [
			['alpha', 10, 4],
			['beta', 200, 3],
		]);
		await seedDay(dateFor(7), [['alpha', 99, 6]]);
		await seedDay(dateFor(8), [['alpha', 1, 900]]);

		expect(await buildTopTraded(testEnv(), { now: NOW, force: true })).toBe('built');

		const doc = await readJson(DOC_KEY);
		expect(doc).toMatchObject({ generatedAt: NOW, windowDays: 7 });
		expect(doc?.items).toEqual([
			{ slug: 'alpha', name: 'Alpha Prime Set', volume: 10, median: 10, value: 100, thumb: 'items/alpha.png' },
			{ slug: 'beta', name: 'Beta Prime Set', volume: 3, median: 200, value: 600 },
		]);
		expect(doc?.byValue).toEqual(['beta', 'alpha']);
	});

	it('ignores rows with no volume and snapshot rank keys', async () => {
		await seedLabels();
		await seedDay(dateFor(1), [
			['alpha', 10],
			['primed_flow:rank-v3:r0', 100, 50],
			['beta', 200, 3],
		]);

		expect(await buildTopTraded(testEnv(), { now: NOW, force: true })).toBe('built');

		expect((await readJson(DOC_KEY))?.items).toEqual([{ slug: 'beta', name: 'Beta Prime Set', volume: 3, median: 200, value: 600 }]);
	});

	it('rebuilds at most once an hour unless a pass forces it', async () => {
		await seedLabels();
		await seedDay(dateFor(1), [['alpha', 10, 4]]);

		expect(await buildTopTraded(testEnv(), { now: NOW, force: true })).toBe('built');
		expect(await buildTopTraded(testEnv(), { now: NOW + 60_000 })).toBe('skipped');
		expect((await readJson(DOC_KEY))?.generatedAt).toBe(NOW);

		expect(await buildTopTraded(testEnv(), { now: NOW + 3_600_001 })).toBe('built');
		expect((await readJson(DOC_KEY))?.generatedAt).toBe(NOW + 3_600_001);
	});

	it('publishes nothing when no day carries a volume', async () => {
		await seedDay(dateFor(1), [['alpha', 10]]);

		expect(await buildTopTraded(testEnv(), { now: NOW, force: true })).toBe('no_data');
		expect(await env.ITEM_META.get(DOC_KEY)).toBeNull();
	});
});

describe('GET /v1/top-traded', () => {
	async function clearEdgeCache(): Promise<void> {
		await caches.default.delete(new Request('http://example.com/v1/top-traded?v=1'));
	}

	it('answers 404 with JSON before the first pass publishes', async () => {
		await clearEdgeCache();
		await env.ITEM_META.delete(DOC_KEY);

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('http://example.com/v1/top-traded'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ ok: false, error: 'top_traded_not_ready' });
	});

	it('serves the doc with an hour of edge caching and honors If-None-Match', async () => {
		await clearEdgeCache();
		await env.ITEM_META.put(
			DOC_KEY,
			JSON.stringify({
				generatedAt: NOW,
				windowDays: 7,
				items: [{ slug: 'alpha', name: 'Alpha Prime Set', volume: 10, median: 12, value: 120, thumb: 'items/alpha.png' }],
				byValue: ['alpha'],
			}),
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('http://example.com/v1/top-traded'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
		const etag = response.headers.get('etag');
		expect(etag).toBeTruthy();
		expect(await response.json()).toMatchObject({
			ok: true,
			generatedAt: NOW,
			windowDays: 7,
			items: [{ slug: 'alpha', name: 'Alpha Prime Set', volume: 10, median: 12, value: 120, thumb: 'items/alpha.png' }],
			byValue: ['alpha'],
		});

		const matchingCtx = createExecutionContext();
		const matching = await worker.fetch(
			new IncomingRequest('http://example.com/v1/top-traded', { headers: { 'if-none-match': etag ?? '' } }),
			env,
			matchingCtx,
		);
		await waitOnExecutionContext(matchingCtx);
		expect(matching.status).toBe(304);
		expect(matching.headers.get('etag')).toBe(etag);
		expect(await matching.text()).toBe('');

		const staleCtx = createExecutionContext();
		const stale = await worker.fetch(
			new IncomingRequest('http://example.com/v1/top-traded', { headers: { 'if-none-match': '"other-etag"' } }),
			env,
			staleCtx,
		);
		await waitOnExecutionContext(staleCtx);
		expect(stale.status).toBe(200);
	});

	it('rejects a malformed stored doc rather than serving it', async () => {
		await clearEdgeCache();
		await env.ITEM_META.put(
			DOC_KEY,
			JSON.stringify({
				generatedAt: NOW,
				windowDays: 7,
				items: [{ slug: '../etc/passwd', name: 'bad', volume: 5, median: 5, value: 25 }],
				byValue: [],
			}),
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('http://example.com/v1/top-traded'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
	});
});
