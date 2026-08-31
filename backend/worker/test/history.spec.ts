import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { archiveBaroVisit, archiveDailyPrices, runDailyArchives, sweepRivenArchive } from '../src/services/history';

const SNAPSHOT_KEY = 'snapshot:full:v1';
const RIVEN_ITEMS_URL = 'https://api.warframe.market/v1/riven/items';
const SWEEP_KEY = 'archive:riven-sweep:v1';
const WEAPONS_KEY = 'archive:riven-weapons:v1';
const NOW = Date.parse('2026-08-31T04:00:00.000Z');
const DATE = '2026-08-31';

const originalFetch = globalThis.fetch;

beforeEach(() => {
	(env as unknown as Record<string, string>).HISTORY_ARCHIVE_ENABLED = '1';
	(env as unknown as Record<string, string>).HISTORY_RETENTION_DAYS = '730';
	(env as unknown as Record<string, string>).RIVEN_ARCHIVE_BATCH_SIZE = '12';
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

async function readArchive(key: string): Promise<Record<string, unknown> | null> {
	const raw = await env.ITEM_META.get(key);
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

async function readIndex(family: string): Promise<string[]> {
	const stored = await readArchive(`archive:index:${family}:v1`);
	return Array.isArray(stored?.entries) ? (stored.entries as string[]) : [];
}

async function seedSnapshot(prices: Record<string, unknown>): Promise<void> {
	await env.PRICE_CACHE.put(SNAPSHOT_KEY, JSON.stringify({ version: 1, generatedAt: NOW, prices, meta: {}, orderSummaries: {} }));
}

function auctionsPayload(prices: number[]): unknown {
	return { payload: { auctions: prices.map((platinum) => ({ buyout_price: platinum, visible: true, closed: false })) } };
}

/** Serves the riven weapon list plus one auction page per weapon. */
function mockRivenUpstream(weapons: string[], prices: (weapon: string) => number[] | Response): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === RIVEN_ITEMS_URL) {
			return jsonOk({ payload: { items: weapons.map((slug) => ({ url_name: slug, item_name: slug })) } });
		}
		const match = /weapon_url_name=([^&]+)/.exec(url);
		if (url.startsWith('https://api.warframe.market/v1/auctions/search') && match) {
			const result = prices(decodeURIComponent(match[1]));
			return result instanceof Response ? result : jsonOk(auctionsPayload(result));
		}
		throw new Error(`Unexpected url: ${url}`);
	});
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

function baroPayload(options: { visitId?: string; activation?: number; expiry?: number; manifest?: unknown[] } = {}): unknown {
	return {
		VoidTraders: [
			{
				_id: { $oid: options.visitId ?? 'baro_visit_1' },
				Activation: { $date: { $numberLong: String(options.activation ?? NOW - 24 * 3600_000) } },
				Expiry: { $date: { $numberLong: String(options.expiry ?? NOW + 24 * 3600_000) } },
				Character: "Baro'Ki Teel",
				Node: 'TradeHUB1',
				Manifest: options.manifest ?? [
					{ ItemType: '/Lotus/StoreItems/Types/Items/MiscItems/PrimeBucks', PrimePrice: 0, RegularPrice: 100000 },
					{ ItemType: '/Lotus/StoreItems/Upgrades/Mods/Rifle/PrimedRifleAmmoMutation', PrimePrice: 300, RegularPrice: 175000 },
				],
			},
		],
		// Varzia, deliberately different from Baro.
		PrimeVaultTraders: [{ _id: { $oid: 'varzia_1' }, Manifest: [{ ItemType: '/Lotus/Vault', PrimePrice: 1, RegularPrice: 1 }] }],
	};
}

describe('daily price archive', () => {
	it('writes a compact dated archive and indexes it', async () => {
		await seedSnapshot({
			ash_prime_set: { status: 'ok', median: 120, timestamp: NOW },
			'primed_flow:rank-v3:r10': { status: 'ok', median: 55.5, timestamp: NOW },
			dead_slug: { status: 'no_data', median: null, timestamp: NOW },
		});

		const result = await archiveDailyPrices(testEnv(), { now: NOW });

		expect(result).toMatchObject({ status: 'written', date: DATE, rows: 2 });
		expect(result.bytes).toBeGreaterThan(0);
		const stored = await readArchive(`archive:prices:${DATE}`);
		expect(stored).toMatchObject({ v: 1, date: DATE, source: 'snapshot', columns: ['key', 'median', 'volume'] });
		expect(stored?.rows).toEqual([
			['ash_prime_set', 120],
			['primed_flow:rank-v3:r10', 55.5],
		]);
		expect(await readIndex('prices')).toEqual([DATE]);
	});

	it('logs the written size', async () => {
		await seedSnapshot({ ash_prime_set: { status: 'ok', median: 120, timestamp: NOW } });
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

		const result = await archiveDailyPrices(testEnv(), { now: NOW });

		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'cron', route: 'archive:prices', status: 200, count: 1, bytes: result.bytes }),
		);
	});

	it('leaves the first write of the day in place on a re-run', async () => {
		await seedSnapshot({ ash_prime_set: { status: 'ok', median: 120, timestamp: NOW } });
		await archiveDailyPrices(testEnv(), { now: NOW });

		await seedSnapshot({ ash_prime_set: { status: 'ok', median: 999, timestamp: NOW } });
		const second = await archiveDailyPrices(testEnv(), { now: NOW + 60_000 });

		expect(second.status).toBe('exists');
		expect((await readArchive(`archive:prices:${DATE}`))?.rows).toEqual([['ash_prime_set', 120]]);
		expect(await readIndex('prices')).toEqual([DATE]);
	});

	it('never replaces an existing archive from an empty or missing snapshot', async () => {
		await seedSnapshot({ ash_prime_set: { status: 'ok', median: 120, timestamp: NOW } });
		await archiveDailyPrices(testEnv(), { now: NOW });

		await env.PRICE_CACHE.delete(SNAPSHOT_KEY);
		const nextDay = NOW + 24 * 60 * 60 * 1000;
		const result = await archiveDailyPrices(testEnv(), { now: nextDay });

		expect(result.status).toBe('no_source');
		expect(await env.ITEM_META.get('archive:prices:2026-09-01')).toBeNull();
		expect((await readArchive(`archive:prices:${DATE}`))?.rows).toEqual([['ash_prime_set', 120]]);
	});

	it('prunes the index and the archives past the retention bound', async () => {
		await env.ITEM_META.put('archive:prices:2026-08-28', JSON.stringify({ v: 1, rows: [] }));
		await env.ITEM_META.put('archive:prices:2026-08-29', JSON.stringify({ v: 1, rows: [] }));
		await env.ITEM_META.put(
			'archive:index:prices:v1',
			JSON.stringify({ v: 1, updatedAt: NOW, entries: ['2026-08-28', '2026-08-29', '2026-08-30'] }),
		);
		await seedSnapshot({ ash_prime_set: { status: 'ok', median: 120, timestamp: NOW } });

		const result = await archiveDailyPrices(testEnv({ HISTORY_RETENTION_DAYS: '3' }), { now: NOW });

		expect(result.status).toBe('written');
		expect(await readIndex('prices')).toEqual(['2026-08-29', '2026-08-30', DATE]);
		expect(await env.ITEM_META.get('archive:prices:2026-08-28')).toBeNull();
		expect(await env.ITEM_META.get('archive:prices:2026-08-29')).not.toBeNull();
	});

	it('refuses a day archive past the size cap and indexes nothing', async () => {
		// 256 chars is the longest key the row builder keeps, so ~17k rows clear the 4MB
		// cap while staying well under the 50k row bound.
		const prices: Record<string, unknown> = {};
		for (let index = 0; index < 17000; index += 1) {
			prices[`${'k'.repeat(250)}${String(index).padStart(6, '0')}`] = { status: 'ok', median: 100, timestamp: NOW };
		}
		await seedSnapshot(prices);
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

		const result = await archiveDailyPrices(testEnv(), { now: NOW });

		expect(result).toMatchObject({ status: 'too_large', date: DATE, rows: 17000 });
		expect(result.bytes).toBeGreaterThan(4 * 1024 * 1024);
		expect(await env.ITEM_META.get(`archive:prices:${DATE}`)).toBeNull();
		expect(await readIndex('prices')).toEqual([]);
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'error', route: 'archive:prices', status: 500, error: 'archive_too_large' }),
		);
	});

	it('is a no-op when archives are switched off', async () => {
		await seedSnapshot({ ash_prime_set: { status: 'ok', median: 120, timestamp: NOW } });

		const result = await archiveDailyPrices(testEnv({ HISTORY_ARCHIVE_ENABLED: '0' }), { now: NOW });

		expect(result.status).toBe('disabled');
		expect(await env.ITEM_META.get(`archive:prices:${DATE}`)).toBeNull();
	});
});

describe('riven archive sweep', () => {
	it('advances the cursor across ticks and finalizes the day', async () => {
		const weapons = ['acceltra', 'bramma', 'cedo', 'dread'];
		const fetchMock = mockRivenUpstream(weapons, (weapon) => (weapon === 'cedo' ? [10, 20, 30] : [5, 15]));
		const sweepEnv = testEnv({ RIVEN_ARCHIVE_BATCH_SIZE: '2' });

		const first = await sweepRivenArchive(sweepEnv, { now: NOW });
		expect(first).toMatchObject({ status: 'progress', weapons: 4, cursorBefore: 0, cursorAfter: 2, updated: 2, failures: 0 });
		expect((await readArchive(`archive:rivens:${DATE}`))?.complete).toBe(false);
		expect(await readIndex('rivens')).toEqual([DATE]);

		const second = await sweepRivenArchive(sweepEnv, { now: NOW + 900_000 });
		expect(second).toMatchObject({ status: 'complete', cursorBefore: 2, cursorAfter: 4, updated: 2 });

		const stored = await readArchive(`archive:rivens:${DATE}`);
		expect(stored).toMatchObject({ v: 1, date: DATE, complete: true, weapons: 4, columns: ['weapon', 'min', 'median', 'sample'] });
		expect(stored?.rows).toEqual([
			['acceltra', 5, 10, 2],
			['bramma', 5, 10, 2],
			['cedo', 10, 20, 3],
			['dread', 5, 10, 2],
		]);
		expect(second.bytes).toBeGreaterThan(0);

		// A finished day idles instead of re-sweeping, and the weapon list is fetched once.
		const third = await sweepRivenArchive(sweepEnv, { now: NOW + 1_800_000 });
		expect(third.status).toBe('idle');
		expect(fetchMock.mock.calls.filter(([input]) => String(input) === RIVEN_ITEMS_URL)).toHaveLength(1);
		expect(await readIndex('rivens')).toEqual([DATE]);
	});

	it('starts a new day without touching the previous day archive', async () => {
		const weapons = ['acceltra'];
		mockRivenUpstream(weapons, () => [7]);
		const sweepEnv = testEnv();

		await sweepRivenArchive(sweepEnv, { now: NOW });
		const nextDay = NOW + 24 * 60 * 60 * 1000;
		mockRivenUpstream(weapons, () => [9]);
		const result = await sweepRivenArchive(sweepEnv, { now: nextDay });

		expect(result).toMatchObject({ status: 'complete', date: '2026-09-01' });
		expect((await readArchive(`archive:rivens:${DATE}`))?.rows).toEqual([['acceltra', 7, 7, 1]]);
		expect((await readArchive('archive:rivens:2026-09-01'))?.rows).toEqual([['acceltra', 9, 9, 1]]);
		expect(await readIndex('rivens')).toEqual([DATE, '2026-09-01']);
	});

	it('keeps rows already gathered when the auction search fails', async () => {
		const weapons = ['acceltra', 'bramma'];
		mockRivenUpstream(weapons, (weapon) => (weapon === 'acceltra' ? [4, 6] : new Response('boom', { status: 503 })));
		const sweepEnv = testEnv({ RIVEN_ARCHIVE_BATCH_SIZE: '1' });

		const first = await sweepRivenArchive(sweepEnv, { now: NOW });
		expect(first).toMatchObject({ status: 'progress', updated: 1, failures: 0 });

		const second = await sweepRivenArchive(sweepEnv, { now: NOW + 900_000 });
		expect(second).toMatchObject({ status: 'complete', processed: 1, updated: 0, failures: 1 });
		expect((await readArchive(`archive:rivens:${DATE}`))?.rows).toEqual([['acceltra', 4, 5, 2]]);
	});

	it('keeps the cached weapon list when the riven items endpoint fails', async () => {
		await env.ITEM_META.put(WEAPONS_KEY, JSON.stringify({ updatedAt: NOW - 48 * 60 * 60 * 1000, weapons: ['acceltra'] }));
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url === RIVEN_ITEMS_URL) return new Response('nope', { status: 500 });
			return jsonOk(auctionsPayload([12]));
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await sweepRivenArchive(testEnv(), { now: NOW });

		expect(result).toMatchObject({ status: 'complete', weapons: 1, updated: 1 });
		expect(JSON.parse(String(await env.ITEM_META.get(WEAPONS_KEY))).weapons).toEqual(['acceltra']);
	});

	it('writes nothing when no weapon list is available', async () => {
		globalThis.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;

		const result = await sweepRivenArchive(testEnv(), { now: NOW });

		expect(result.status).toBe('no_weapons');
		expect(await env.ITEM_META.get(`archive:rivens:${DATE}`)).toBeNull();
		expect(await env.ITEM_META.get(SWEEP_KEY)).toBeNull();
	});

	it('is a no-op when archives are switched off', async () => {
		const fetchMock = mockRivenUpstream(['acceltra'], () => [1]);

		const result = await sweepRivenArchive(testEnv({ HISTORY_ARCHIVE_ENABLED: '0' }), { now: NOW });

		expect(result.status).toBe('disabled');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('Baro visit archive', () => {
	it('records the manifest of a live visit once across two cron runs', async () => {
		const fetchMock = vi.fn(async () => jsonOk(baroPayload()));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const first = await archiveBaroVisit(testEnv(), { now: NOW });
		expect(first).toMatchObject({ status: 'written', visitId: 'baro_visit_1', rows: 2 });
		expect(first.bytes).toBeGreaterThan(0);

		const stored = await readArchive('archive:baro:baro_visit_1');
		expect(stored).toMatchObject({
			v: 1,
			visitId: 'baro_visit_1',
			node: 'TradeHUB1',
			activation: new Date(NOW - 24 * 3600_000).toISOString(),
			expiry: new Date(NOW + 24 * 3600_000).toISOString(),
			columns: ['item', 'ducats', 'credits'],
		});
		expect(stored?.rows).toEqual([
			['/Lotus/StoreItems/Types/Items/MiscItems/PrimeBucks', 0, 100000],
			['/Lotus/StoreItems/Upgrades/Mods/Rifle/PrimedRifleAmmoMutation', 300, 175000],
		]);

		// The next daily tick still sees the same live visit.
		const second = await archiveBaroVisit(testEnv(), { now: NOW + 12 * 60 * 60 * 1000 });
		expect(second).toMatchObject({ status: 'exists', visitId: 'baro_visit_1' });
		expect((await readArchive('archive:baro:baro_visit_1'))?.recordedAt).toBe(NOW);
		expect(await readIndex('baro')).toEqual(['baro_visit_1']);
	});

	it('ignores a visit that is not running and never reads Varzia', async () => {
		globalThis.fetch = vi.fn(async () =>
			jsonOk(baroPayload({ activation: NOW + 3600_000, expiry: NOW + 7200_000 })),
		) as unknown as typeof fetch;

		const result = await archiveBaroVisit(testEnv(), { now: NOW });

		expect(result.status).toBe('inactive');
		expect(await env.ITEM_META.get('archive:baro:baro_visit_1')).toBeNull();
		expect(await env.ITEM_META.get('archive:baro:varzia_1')).toBeNull();
	});

	it('keeps a recorded visit when the world state is unavailable', async () => {
		globalThis.fetch = vi.fn(async () => jsonOk(baroPayload())) as unknown as typeof fetch;
		await archiveBaroVisit(testEnv(), { now: NOW });

		globalThis.fetch = vi.fn(async () => new Response('boom', { status: 503 })) as unknown as typeof fetch;
		const result = await archiveBaroVisit(testEnv(), { now: NOW + 60_000 });

		expect(result.status).toBe('unavailable');
		expect((await readArchive('archive:baro:baro_visit_1'))?.rows).toHaveLength(2);
		expect(await readIndex('baro')).toEqual(['baro_visit_1']);
	});

	it('prunes visits past the retention bound', async () => {
		const bound = Array.from({ length: 8 }, (_, index) => `old_visit_${index}`);
		await env.ITEM_META.put('archive:baro:old_visit_0', JSON.stringify({ v: 1, rows: [] }));
		await env.ITEM_META.put('archive:index:baro:v1', JSON.stringify({ v: 1, updatedAt: NOW, entries: bound }));
		globalThis.fetch = vi.fn(async () => jsonOk(baroPayload())) as unknown as typeof fetch;

		// The bound is visits, not days: 1 day of retention allows 8 stored visits.
		const result = await archiveBaroVisit(testEnv({ HISTORY_RETENTION_DAYS: '1' }), { now: NOW });

		expect(result.status).toBe('written');
		expect(await readIndex('baro')).toEqual([...bound.slice(1), 'baro_visit_1']);
		expect(await env.ITEM_META.get('archive:baro:old_visit_0')).toBeNull();
	});

	it('survives a world state payload with no trader block', async () => {
		globalThis.fetch = vi.fn(async () => jsonOk({ WorldSeed: 'x' })) as unknown as typeof fetch;

		expect(await archiveBaroVisit(testEnv(), { now: NOW })).toMatchObject({ status: 'inactive', visitId: null });
	});
});

describe('daily archive runner', () => {
	it('runs the price and Baro archives together', async () => {
		await seedSnapshot({ ash_prime_set: { status: 'ok', median: 120, timestamp: NOW } });
		globalThis.fetch = vi.fn(async () => jsonOk(baroPayload())) as unknown as typeof fetch;

		const result = await runDailyArchives(testEnv(), { now: NOW });

		expect(result.prices.status).toBe('written');
		expect(result.baro.status).toBe('written');
	});
});
