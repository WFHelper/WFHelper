import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { seedPriceHistory } from '../src/services/priceHistorySeed';
import { resetRankedSlugCacheForTest } from '../src/services/prewarmCatalog';

const CATALOG_SLUGS_KEY = 'catalog:slugs:v1';
const RANKED_CATALOG_KEY = 'order-summary:catalog:v1';
const STATE_KEY = 'archive:price-seed:v1';
const SLUGS_KEY = 'archive:price-seed:slugs:v1';
const NOW = Date.parse('2026-08-31T04:00:00.000Z');
const STARTED_DATE = '2026-08-31';

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
	(env as unknown as Record<string, string>).PRICE_SEED_ENABLED = '1';
	(env as unknown as Record<string, string>).PRICE_SEED_BATCH_SIZE = '20';
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
	return new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function readArchive(key: string): Promise<Record<string, unknown> | null> {
	const raw = await env.ITEM_META.get(key);
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

async function readIndex(): Promise<string[]> {
	const stored = await readArchive('archive:index:prices:v1');
	return Array.isArray(stored?.entries) ? (stored.entries as string[]) : [];
}

async function seedCatalog(slugs: string[]): Promise<void> {
	await env.ITEM_META.put(CATALOG_SLUGS_KEY, JSON.stringify({ updatedAt: Date.now(), slugs, rankedSummaryCatalog: [] }));
}

async function seedRankedCatalog(entries: Array<{ slug: string; maxRank: number }>): Promise<void> {
	await env.ITEM_META.put(RANKED_CATALOG_KEY, JSON.stringify({ updatedAt: Date.now(), entries }));
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

/** Serves one statistics response per slug; a raw Response models an upstream failure. */
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

function statisticsCalls(fetchMock: ReturnType<typeof vi.fn>): number {
	return fetchMock.mock.calls.filter(([input]) => String(input).includes('/statistics')).length;
}

describe('price history seed sweep', () => {
	it('walks the pinned slug list in batches and latches itself off', async () => {
		await seedCatalog(['alpha', 'beta', 'gamma']);
		await seedRankedCatalog([]);
		const fetchMock = mockStatistics({
			alpha: statsPayload([{ daysAgo: 1, median: 110, volume: 7 }]),
			beta: statsPayload([{ daysAgo: 1, median: 20 }]),
			gamma: statsPayload([{ daysAgo: 1, median: 30 }]),
		});
		const seedEnv = testEnv({ PRICE_SEED_BATCH_SIZE: '2' });

		const first = await seedPriceHistory(seedEnv, { now: NOW });
		expect(first).toMatchObject({
			status: 'progress',
			startedDate: STARTED_DATE,
			slugs: 3,
			cursorBefore: 0,
			cursorAfter: 2,
			processed: 2,
			failures: 0,
			dates: 1,
			rows: 2,
		});
		expect(first.bytes).toBeGreaterThan(0);
		expect(await readArchive(STATE_KEY)).toMatchObject({ startedDate: STARTED_DATE, cursor: 2, complete: false, failures: 0 });

		const second = await seedPriceHistory(seedEnv, { now: NOW + 900_000 });
		expect(second).toMatchObject({ status: 'complete', cursorBefore: 2, cursorAfter: 3, processed: 1, rows: 1 });

		const stored = await readArchive(`archive:prices:${dateFor(1)}`);
		expect(stored).toMatchObject({ v: 1, date: dateFor(1), source: 'wfm-statistics-seed', columns: ['key', 'median', 'volume'] });
		expect(stored?.rows).toEqual([
			['alpha', 110, 7],
			['beta', 20],
			['gamma', 30],
		]);
		expect(await readIndex()).toEqual([dateFor(1)]);
		expect(await readArchive(STATE_KEY)).toMatchObject({ cursor: 3, complete: true });
		expect(await env.ITEM_META.get(SLUGS_KEY)).toBeNull();

		// The latch holds: no further upstream request and no further write.
		const third = await seedPriceHistory(seedEnv, { now: NOW + 1_800_000 });
		expect(third).toMatchObject({ status: 'idle', startedDate: STARTED_DATE });
		expect(statisticsCalls(fetchMock)).toBe(3);
	});

	it('stays complete across a redeploy', async () => {
		await env.ITEM_META.put(
			STATE_KEY,
			JSON.stringify({ startedDate: STARTED_DATE, cursor: 3, complete: true, failures: 2, updatedAt: NOW }),
		);
		await seedCatalog(['alpha']);
		await seedRankedCatalog([]);
		const fetchMock = mockStatistics({ alpha: statsPayload([{ daysAgo: 1, median: 110 }]) });

		const result = await seedPriceHistory(testEnv(), { now: NOW + 30 * 24 * 60 * 60 * 1000 });

		expect(result.status).toBe('idle');
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await readArchive(STATE_KEY)).toMatchObject({ cursor: 3, complete: true, failures: 2 });
		expect(await env.ITEM_META.get(`archive:prices:${dateFor(1)}`)).toBeNull();
	});

	it('takes the rank 0 day rows for a slug in the ranked catalog', async () => {
		await seedCatalog(['primed_flow']);
		await seedRankedCatalog([{ slug: 'primed_flow', maxRank: 10 }]);
		mockStatistics({
			primed_flow: statsPayload([
				{ daysAgo: 2, median: 50, rank: 0 },
				{ daysAgo: 2, median: 123, rank: 10 },
			]),
		});

		const result = await seedPriceHistory(testEnv(), { now: NOW });

		expect(result).toMatchObject({ status: 'complete', rows: 1 });
		expect((await readArchive(`archive:prices:${dateFor(2)}`))?.rows).toEqual([['primed_flow', 50]]);
	});

	it('takes the rankless day rows for a slug the ranked catalog does not hold', async () => {
		await seedCatalog(['ash_prime_set']);
		await seedRankedCatalog([{ slug: 'primed_flow', maxRank: 10 }]);
		mockStatistics({
			ash_prime_set: statsPayload([
				{ daysAgo: 3, median: 3, rank: 0 },
				{ daysAgo: 3, median: 17 },
			]),
		});

		const result = await seedPriceHistory(testEnv(), { now: NOW });

		expect(result).toMatchObject({ status: 'complete', rows: 1 });
		expect((await readArchive(`archive:prices:${dateFor(3)}`))?.rows).toEqual([['ash_prime_set', 17]]);
	});

	it('adds only the missing keys to a day the live archive already wrote', async () => {
		const date = dateFor(1);
		await env.ITEM_META.put(
			`archive:prices:${date}`,
			JSON.stringify({
				v: 1,
				date,
				generatedAt: 1234,
				source: 'snapshot',
				columns: ['key', 'median', 'volume'],
				rows: [['alpha', 120]],
			}),
		);
		await env.ITEM_META.put('archive:index:prices:v1', JSON.stringify({ v: 1, updatedAt: NOW, entries: [STARTED_DATE] }));
		await seedCatalog(['alpha', 'beta']);
		await seedRankedCatalog([]);
		mockStatistics({
			alpha: statsPayload([{ daysAgo: 1, median: 999 }]),
			beta: statsPayload([{ daysAgo: 1, median: 5, volume: 3 }]),
		});

		const result = await seedPriceHistory(testEnv(), { now: NOW });

		expect(result).toMatchObject({ status: 'complete', rows: 1 });
		const stored = await readArchive(`archive:prices:${date}`);
		expect(stored).toMatchObject({ generatedAt: 1234, source: 'snapshot' });
		expect(stored?.rows).toEqual([
			['alpha', 120],
			['beta', 5, 3],
		]);
		// Seeded days are older than the live ones, so the index stays oldest first.
		expect(await readIndex()).toEqual([date, STARTED_DATE]);
	});

	it('never writes the day the sweep started or anything outside the 90-day window', async () => {
		await seedCatalog(['alpha']);
		await seedRankedCatalog([]);
		mockStatistics({
			alpha: statsPayload([
				{ daysAgo: -1, median: 11 },
				{ daysAgo: 0, median: 12 },
				{ daysAgo: 90, median: 13 },
				{ daysAgo: 91, median: 14 },
			]),
		});

		const result = await seedPriceHistory(testEnv(), { now: NOW });

		expect(result).toMatchObject({ status: 'complete', dates: 1, rows: 1 });
		expect(await env.ITEM_META.get(`archive:prices:${dateFor(-1)}`)).toBeNull();
		expect(await env.ITEM_META.get(`archive:prices:${STARTED_DATE}`)).toBeNull();
		expect(await env.ITEM_META.get(`archive:prices:${dateFor(91)}`)).toBeNull();
		expect((await readArchive(`archive:prices:${dateFor(90)}`))?.rows).toEqual([['alpha', 13]]);
	});

	it('leaves the cursor unmoved when the catalog is unavailable', async () => {
		const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const blocked = await seedPriceHistory(testEnv(), { now: NOW });

		expect(blocked).toMatchObject({ status: 'no_catalog', slugs: 0 });
		expect(await env.ITEM_META.get(STATE_KEY)).toBeNull();
		expect(await env.ITEM_META.get(SLUGS_KEY)).toBeNull();

		await seedCatalog(['alpha']);
		await seedRankedCatalog([]);
		mockStatistics({ alpha: statsPayload([{ daysAgo: 1, median: 110 }]) });
		const resumed = await seedPriceHistory(testEnv(), { now: NOW + 900_000 });

		expect(resumed).toMatchObject({ status: 'complete', cursorBefore: 0, cursorAfter: 1, rows: 1 });
	});

	it('leaves the cursor unmoved when the ranked catalog is unavailable', async () => {
		await seedCatalog(['alpha']);
		await env.ITEM_META.delete(RANKED_CATALOG_KEY);
		const fetchMock = mockStatistics({ alpha: statsPayload([{ daysAgo: 1, median: 110 }]) });

		const result = await seedPriceHistory(testEnv(), { now: NOW });

		expect(result).toMatchObject({ status: 'no_catalog', slugs: 1 });
		expect(statisticsCalls(fetchMock)).toBe(0);
		expect(await env.ITEM_META.get(STATE_KEY)).toBeNull();
	});

	it('is a no-op when the seed or the archive family is switched off', async () => {
		await seedCatalog(['alpha']);
		await seedRankedCatalog([]);
		const fetchMock = mockStatistics({ alpha: statsPayload([{ daysAgo: 1, median: 110 }]) });

		expect((await seedPriceHistory(testEnv({ PRICE_SEED_ENABLED: '0' }), { now: NOW })).status).toBe('disabled');
		expect((await seedPriceHistory(testEnv({ HISTORY_ARCHIVE_ENABLED: '0' }), { now: NOW })).status).toBe('disabled');
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await env.ITEM_META.get(STATE_KEY)).toBeNull();
	});

	it('counts failed and malformed responses and keeps going', async () => {
		await seedCatalog(['alpha', 'beta', 'gamma']);
		await seedRankedCatalog([]);
		mockStatistics({
			alpha: new Response('boom', { status: 503 }),
			beta: { payload: {} },
			gamma: statsPayload([{ daysAgo: 1, median: 30 }]),
		});

		const result = await seedPriceHistory(testEnv(), { now: NOW });

		expect(result).toMatchObject({ status: 'complete', processed: 3, failures: 2, rows: 1 });
		expect(await readArchive(STATE_KEY)).toMatchObject({ complete: true, failures: 2 });
		expect((await readArchive(`archive:prices:${dateFor(1)}`))?.rows).toEqual([['gamma', 30]]);
	});

	it('keeps the pinned slug list when the catalog changes mid-sweep', async () => {
		await seedCatalog(['alpha', 'beta']);
		await seedRankedCatalog([]);
		mockStatistics({
			alpha: statsPayload([{ daysAgo: 1, median: 110 }]),
			beta: statsPayload([{ daysAgo: 1, median: 20 }]),
		});
		const seedEnv = testEnv({ PRICE_SEED_BATCH_SIZE: '1' });

		await seedPriceHistory(seedEnv, { now: NOW });
		await seedCatalog(['zeta']);
		const second = await seedPriceHistory(seedEnv, { now: NOW + 900_000 });

		expect(second).toMatchObject({ status: 'complete', slugs: 2, cursorBefore: 1, cursorAfter: 2 });
		expect((await readArchive(`archive:prices:${dateFor(1)}`))?.rows).toEqual([
			['alpha', 110],
			['beta', 20],
		]);
	});
});
