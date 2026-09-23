import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BARO_HISTORY_KEY, type BaroHistoryVisit } from '../../../config/shared/baroHistory';
import { migrateBaroHistory, readBaroHistory } from '../src/services/baroHistory';
import { archiveBaroVisit } from '../src/services/history';
import type { Env } from '../src/types';

const NOW = Date.parse('2026-09-08T12:00:00Z');
const DAY = 86_400_000;
const ITEM = '/Lotus/Types/Items/TestItem';
const BARO_ID = '5d1e07a0a38e4a4fdd7cefca';
const VISIT_A = `d${NOW - DAY}`;

function testEnv(overrides: Partial<Env> = {}): Env {
	return { ...env, HISTORY_ARCHIVE_ENABLED: '1', HISTORY_RETENTION_DAYS: '730', ...overrides } as Env;
}

function visit(id = VISIT_A, activation = NOW - DAY, uniqueName = ITEM): BaroHistoryVisit {
	return { id, activation, expiry: activation + 2 * DAY, node: 'TradeHUB1', items: [{ uniqueName, ducats: 300, credits: 150000 }] };
}

function recordBaroVisitHistory(environment: Env, current: BaroHistoryVisit, now: number) {
	return migrateBaroHistory(environment, now, current);
}

function archive(value: BaroHistoryVisit, version = 1): string {
	return JSON.stringify({
		v: version,
		visitId: value.id,
		activation: new Date(value.activation).toISOString(),
		expiry: new Date(value.expiry).toISOString(),
		node: value.node,
		rows: value.items.map((item) => [item.uniqueName, item.ducats, item.credits]),
	});
}

function worldState(value: BaroHistoryVisit, manifest?: unknown[]): Response {
	return new Response(
		JSON.stringify({
			VoidTraders: [
				{
					_id: { $oid: BARO_ID },
					Activation: { $date: value.activation },
					Expiry: { $date: value.expiry },
					Node: value.node,
					Manifest:
						manifest ?? value.items.map((item) => ({ ItemType: item.uniqueName, PrimePrice: item.ducats, RegularPrice: item.credits })),
				},
			],
		}),
		{ headers: { 'content-type': 'application/json' } },
	);
}

afterEach(() => vi.restoreAllMocks());

describe('Baro history', () => {
	it('preserves legacy last-seen dates while Baro is away and canonicalizes store identities', async () => {
		const old = visit('legacy', NOW - 700 * DAY, '/Lotus/StoreItems/Types/Items/TestItem');
		await env.ITEM_META.put('archive:index:baro:v1', JSON.stringify({ entries: ['legacy'] }));
		await env.ITEM_META.put('archive:baro:legacy', archive(old));
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ VoidTraders: [] })));
		expect((await archiveBaroVisit(testEnv(), { now: NOW })).status).toBe('inactive');
		await env.ITEM_META.delete('archive:baro:legacy');
		expect((await readBaroHistory(testEnv()))?.lastSeen).toEqual([
			{ uniqueName: ITEM, ducats: 300, credits: 150000, visitId: 'legacy', lastSeen: old.activation },
		]);
	});
	it('returns empty unknown coverage when no archive exists and does not write from reads', async () => {
		expect(await readBaroHistory(testEnv())).toBeNull();
		expect(await env.ITEM_META.get(BARO_HISTORY_KEY)).toBeNull();
	});

	it('backs up and repairs a corrupt durable document', async () => {
		await env.ITEM_META.put(BARO_HISTORY_KEY, '{broken');
		expect(await readBaroHistory(testEnv())).toBeNull();
		await recordBaroVisitHistory(testEnv(), visit(), NOW);
		expect(await env.ITEM_META.get('baro:history:recovery:v1')).toBe('{broken');
		expect((await readBaroHistory(testEnv()))?.lastSeen).toHaveLength(1);
	});

	it('migrates retained archives and distinguishes unknown legacy zeros from explicit v2 zeros', async () => {
		const old = visit('old', NOW - 20 * DAY);
		old.items = [{ uniqueName: '/Lotus/Types/Items/Legacy', ducats: 0, credits: 100 }];
		const current = visit();
		current.items = [{ uniqueName: ITEM, ducats: 0, credits: null }];
		await env.ITEM_META.put('archive:index:baro:v1', JSON.stringify({ entries: ['old', VISIT_A, 'missing', '../invalid', 'old'] }));
		await env.ITEM_META.put('archive:baro:old', archive(old));
		await env.ITEM_META.put(`archive:baro:${VISIT_A}`, archive(current, 2));
		await expect(migrateBaroHistory(testEnv(), NOW)).rejects.toThrow('baro_history_migration_incomplete');
		const history = await readBaroHistory(testEnv());
		expect(history?.coverageStart).toBe(old.activation);
		expect(history?.visits.map((entry) => entry.id)).toEqual([VISIT_A, 'old']);
		expect(history?.lastSeen).toEqual([
			{ uniqueName: '/Lotus/Types/Items/Legacy', ducats: null, credits: 100, visitId: 'old', lastSeen: old.activation },
			{ uniqueName: ITEM, ducats: 0, credits: null, visitId: VISIT_A, lastSeen: current.activation },
		]);
		expect(await env.ITEM_META.get(BARO_HISTORY_KEY)).not.toBeNull();
	});

	it('keeps durable last-seen records after visits fall outside retention', async () => {
		const old = visit('old', NOW - 20 * DAY, '/Lotus/Types/Items/OldOnly');
		await recordBaroVisitHistory(testEnv(), old, NOW - 19 * DAY);
		const history = await recordBaroVisitHistory(testEnv({ HISTORY_RETENTION_DAYS: '1' }), visit(), NOW);
		expect(history.visits.map((entry) => entry.id)).toEqual([VISIT_A]);
		expect(history.coverageStart).toBe(old.activation);
		expect(history.lastSeen).toHaveLength(2);
		expect(history.lastSeen.find((entry) => entry.uniqueName === '/Lotus/Types/Items/OldOnly')?.lastSeen).toBe(old.activation);
	});

	it('does not move last-seen dates backward when an older visit is recorded later', async () => {
		await recordBaroVisitHistory(testEnv(), visit('new'), NOW);
		const old = visit('old', NOW - 15 * DAY);
		old.items[0].ducats = 999;
		const history = await recordBaroVisitHistory(testEnv(), old, NOW);
		expect(history.lastSeen[0]).toMatchObject({ visitId: 'new', lastSeen: NOW - DAY, ducats: 300 });
	});

	it('deduplicates repeat visits, preserves known costs and merges newly observed items', async () => {
		await recordBaroVisitHistory(testEnv(), visit(), NOW);
		const repeated = visit();
		repeated.items = [
			{ uniqueName: ITEM, ducats: null, credits: null },
			{ uniqueName: '/Lotus/Types/Items/New', ducats: 0, credits: 0 },
		];
		const history = await recordBaroVisitHistory(testEnv(), repeated, NOW + 1000);
		expect(history.visits).toHaveLength(1);
		expect(history.visits[0].items).toHaveLength(2);
		expect(history.lastSeen.find((entry) => entry.uniqueName === ITEM)).toMatchObject({ ducats: 300, credits: 150000 });
	});

	it('refuses invalid, future and duplicate-item visits', async () => {
		await expect(recordBaroVisitHistory(testEnv(), visit('future', NOW + DAY), NOW)).rejects.toThrow('invalid_baro_visit');
		const duplicate = visit();
		duplicate.items.push(duplicate.items[0]);
		await expect(recordBaroVisitHistory(testEnv(), duplicate, NOW)).rejects.toThrow('invalid_baro_visit');
		await recordBaroVisitHistory(testEnv(), visit(), NOW);
		const corrected = { ...visit(), expiry: visit().expiry + 1 };
		expect((await recordBaroVisitHistory(testEnv(), corrected, NOW)).visits[0].expiry).toBe(corrected.expiry);
	});

	it('retains every last-seen item when the 129th visit removes the oldest visit detail', async () => {
		const visits = Array.from({ length: 128 }, (_, index) =>
			visit(`old_${index}`, NOW - (index + 2) * DAY, `/Lotus/Types/Items/Old${index}`),
		);
		const coverageStart = visits[127].activation;
		await env.ITEM_META.put(
			BARO_HISTORY_KEY,
			JSON.stringify({
				version: 1,
				updatedAt: NOW,
				coverageStart,
				visits,
				lastSeen: visits.map((entry) => ({ ...entry.items[0], visitId: entry.id, lastSeen: entry.activation })),
			}),
		);
		const history = await recordBaroVisitHistory(testEnv(), visit(), NOW);
		expect(history.visits).toHaveLength(128);
		expect(history.lastSeen).toHaveLength(129);
		expect(history.coverageStart).toBe(coverageStart);
		expect(history.visits.some((entry) => entry.id === 'old_127')).toBe(false);
		expect(history.lastSeen.some((entry) => entry.visitId === 'old_127')).toBe(true);
	});

	it('refuses item overflow without discarding previously durable last-seen records', async () => {
		const previous = JSON.stringify({
			version: 1,
			updatedAt: NOW,
			coverageStart: NOW - DAY,
			visits: [],
			lastSeen: Array.from({ length: 5000 }, (_, index) => ({
				uniqueName: `/Lotus/Types/Items/Old${index}`,
				ducats: 1,
				credits: 1,
				visitId: 'old',
				lastSeen: NOW - DAY,
			})),
		});
		await env.ITEM_META.put(BARO_HISTORY_KEY, previous);
		await expect(recordBaroVisitHistory(testEnv(), visit(), NOW)).rejects.toThrow('baro_history_item_limit');
		expect(await env.ITEM_META.get(BARO_HISTORY_KEY)).toBe(previous);
	});

	it('skips malformed archives without inventing history dates or overwriting valid entries', async () => {
		await env.ITEM_META.put('archive:index:baro:v1', JSON.stringify({ entries: ['bad_json', 'wrong_id', 'future', VISIT_A] }));
		await env.ITEM_META.put('archive:baro:bad_json', '{broken');
		await env.ITEM_META.put('archive:baro:wrong_id', archive(visit('other')));
		await env.ITEM_META.put('archive:baro:future', archive(visit('future', NOW + DAY)));
		await env.ITEM_META.put(`archive:baro:${VISIT_A}`, archive(visit()));
		await expect(migrateBaroHistory(testEnv(), NOW)).rejects.toThrow('baro_history_migration_incomplete');
		const history = await readBaroHistory(testEnv());
		expect(history?.visits.map((entry) => entry.id)).toEqual([VISIT_A]);
		expect(history?.coverageStart).toBe(NOW - DAY);
	});

	it('bounds migration to 128 archive reads in batches of at most eight', async () => {
		let active = 0;
		let maximum = 0;
		let reads = 0;
		const namespace = {
			get: async (key: string) => {
				if (key === BARO_HISTORY_KEY) return null;
				if (key === 'archive:index:baro:v1')
					return JSON.stringify({ entries: Array.from({ length: 200 }, (_, index) => `visit_${index}`) });
				reads += 1;
				maximum = Math.max(maximum, ++active);
				await Promise.resolve();
				active -= 1;
				return null;
			},
			list: async () => ({ list_complete: true, keys: [] }),
			put: async () => undefined,
		} as unknown as KVNamespace;
		await expect(migrateBaroHistory(testEnv({ ITEM_META: namespace }), NOW)).rejects.toThrow('baro_history_migration_incomplete');
		expect(reads).toBe(128);
		expect(maximum).toBeLessThanOrEqual(8);
	});

	it('repairs history and archive index when a previously archived visit is seen again', async () => {
		await env.ITEM_META.put(`archive:baro:${VISIT_A}`, archive(visit()));
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => worldState(visit()));
		expect(await archiveBaroVisit(testEnv(), { now: NOW })).toMatchObject({ status: 'exists' });
		expect((await readBaroHistory(testEnv()))?.lastSeen[0].visitId).toBe(VISIT_A);
		expect(JSON.parse((await env.ITEM_META.get('archive:index:baro:v1')) ?? '{}').entries).toEqual([VISIT_A]);
	});

	it('stores two visits that reuse the world-state id as separate visits', async () => {
		const first = visit(`d${NOW - 15 * DAY}`, NOW - 15 * DAY);
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => worldState(first));
		expect(await archiveBaroVisit(testEnv(), { now: NOW - 14 * DAY })).toMatchObject({ status: 'written', visitId: first.id });
		const second = visit();
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => worldState(second));
		expect(await archiveBaroVisit(testEnv(), { now: NOW })).toMatchObject({ status: 'written', visitId: second.id });
		const history = await readBaroHistory(testEnv());
		expect(history?.visits.map((entry) => [entry.id, entry.activation])).toEqual([
			[second.id, second.activation],
			[first.id, first.activation],
		]);
		expect(history?.lastSeen).toEqual([{ ...second.items[0], visitId: second.id, lastSeen: second.activation }]);
	});

	it('keeps a visit archived under the reused world-state id readable beside a new visit', async () => {
		const legacy = visit(BARO_ID, NOW - 15 * DAY, '/Lotus/Fixture/Legacy');
		await env.ITEM_META.put('archive:index:baro:v1', JSON.stringify({ entries: [BARO_ID] }));
		await env.ITEM_META.put(`archive:baro:${BARO_ID}`, archive(legacy, 2));
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => worldState(visit()));
		expect(await archiveBaroVisit(testEnv(), { now: NOW })).toMatchObject({ status: 'written', visitId: VISIT_A });
		const history = await readBaroHistory(testEnv());
		expect(history?.visits.map((entry) => entry.id)).toEqual([VISIT_A, BARO_ID]);
		expect(history?.lastSeen.map((entry) => [entry.visitId, entry.lastSeen])).toEqual([
			[BARO_ID, legacy.activation],
			[VISIT_A, NOW - DAY],
		]);
	});

	it('records missing and invalid current prices as null while preserving explicit zero', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			worldState(visit(), [
				{ ItemType: ITEM },
				{ ItemType: ITEM, PrimePrice: 400 },
				{ ItemType: '/Lotus/Types/Items/Zero', PrimePrice: 0, RegularPrice: 0 },
				{ ItemType: '/Lotus/Types/Items/Invalid', PrimePrice: -1, RegularPrice: 2.5 },
				{ ItemType: 'invalid', PrimePrice: 1 },
			]),
		);
		expect(await archiveBaroVisit(testEnv(), { now: NOW })).toMatchObject({ status: 'written', rows: 3 });
		const stored = JSON.parse((await env.ITEM_META.get(`archive:baro:${VISIT_A}`)) ?? '{}');
		expect(stored.v).toBe(2);
		expect(stored.rows).toEqual([
			[ITEM, null, null],
			['/Lotus/Types/Items/Zero', 0, 0],
			['/Lotus/Types/Items/Invalid', null, null],
		]);
	});

	it('does not prune archives when the durable last-seen write fails', async () => {
		const put = vi.fn(async (key: string) => {
			if (key === BARO_HISTORY_KEY) throw new Error('write failed');
		});
		const remove = vi.fn(async () => undefined);
		const namespace = {
			get: async () => null,
			put,
			delete: remove,
			list: async () => ({ list_complete: true, keys: [] }),
		} as unknown as KVNamespace;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => worldState(visit()));
		expect(await archiveBaroVisit(testEnv({ ITEM_META: namespace }), { now: NOW })).toMatchObject({ status: 'error' });
		expect(remove).not.toHaveBeenCalled();
		expect(put.mock.calls.map(([key]) => key)).toContain(`archive:baro:${VISIT_A}`);
		expect(put.mock.calls.map(([key]) => key)).not.toContain('archive:index:baro:v1');
	});
});

describe('Baro archive recovery', () => {
	it.each([{ rows: [] }, { rows: [['invalid', 10, 20]] }])(
		'quarantines malformed legacy rows $rows before acknowledging the archive',
		async ({ rows }) => {
			const raw = JSON.stringify({ ...JSON.parse(archive(visit('legacy', NOW - 15 * DAY))), rows });
			await env.ITEM_META.put('archive:baro:legacy', raw);
			await env.ITEM_META.put('archive:index:baro:v1', JSON.stringify({ entries: ['legacy'] }));
			vi.spyOn(globalThis, 'fetch').mockImplementation(async () => worldState(visit()));
			expect((await archiveBaroVisit(testEnv(), { now: NOW })).status).toBe('written');
			expect(JSON.parse((await env.ITEM_META.get('baro:history:recovery:archives:v1'))!).legacy).toBe(raw);
			expect(JSON.parse((await env.ITEM_META.get('archive:index:baro:v1'))!).entries).toEqual(['legacy', VISIT_A]);
			expect((await readBaroHistory(testEnv()))?.visits.map((entry) => entry.id)).toEqual([VISIT_A]);
			expect((await archiveBaroVisit(testEnv(), { now: NOW })).status).toBe('exists');
		},
	);
	it('does not acknowledge or prune a malformed archive when quarantine fails', async () => {
		await env.ITEM_META.put('archive:baro:legacy', '{broken');
		const put = vi.fn(async (key: string, value: string, options?: KVNamespacePutOptions) => {
			if (key === 'baro:history:recovery:archives:v1') throw new Error('recovery unavailable');
			await env.ITEM_META.put(key, value, options);
		});
		const namespace = {
			get: env.ITEM_META.get.bind(env.ITEM_META),
			list: env.ITEM_META.list.bind(env.ITEM_META),
			put,
		} as unknown as KVNamespace;
		await expect(migrateBaroHistory(testEnv({ ITEM_META: namespace }), NOW)).rejects.toThrow('recovery unavailable');
		expect(await env.ITEM_META.get(BARO_HISTORY_KEY)).toBeNull();
		expect(await env.ITEM_META.get('archive:baro:legacy')).toBe('{broken');
	});
	it('preserves prototype-like archive ids as own recovery keys', async () => {
		await env.ITEM_META.put('archive:baro:__proto__', '{broken');
		await migrateBaroHistory(testEnv(), NOW);
		const recovered = JSON.parse((await env.ITEM_META.get('baro:history:recovery:archives:v1'))!);
		expect(Object.hasOwn(recovered, '__proto__')).toBe(true);
		expect(recovered.__proto__).toBe('{broken');
	});
	it('recovers a manifest after departure when its durable write failed', async () => {
		let fail = true;
		const namespace = {
			get: env.ITEM_META.get.bind(env.ITEM_META),
			list: env.ITEM_META.list.bind(env.ITEM_META),
			delete: env.ITEM_META.delete.bind(env.ITEM_META),
			put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
				if (key === BARO_HISTORY_KEY && fail) throw new Error('durable unavailable');
				await env.ITEM_META.put(key, value, options);
			},
		} as unknown as KVNamespace;
		const scoped = testEnv({ ITEM_META: namespace });
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => worldState(visit()));
		expect((await archiveBaroVisit(scoped, { now: NOW })).status).toBe('error');
		expect(await env.ITEM_META.get(`archive:baro:${VISIT_A}`)).not.toBeNull();
		expect(await env.ITEM_META.get('archive:index:baro:v1')).toBeNull();
		fail = false;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ VoidTraders: [] })));
		expect((await archiveBaroVisit(scoped, { now: NOW + 3 * DAY })).status).toBe('inactive');
		expect((await readBaroHistory(scoped))?.lastSeen[0]).toMatchObject({ uniqueName: ITEM, lastSeen: NOW - DAY });
	});
	it('retries missing and rejected archive reads without losing recovered older dates', async () => {
		const old = visit('old', NOW - 30 * DAY, '/Lotus/Fixture/Old');
		const later = visit('later', NOW - 10 * DAY, '/Lotus/Fixture/Later');
		await env.ITEM_META.put('archive:index:baro:v1', JSON.stringify({ entries: ['old', 'later'] }));
		await env.ITEM_META.put('archive:baro:old', archive(old));
		await expect(migrateBaroHistory(testEnv(), NOW)).rejects.toThrow('baro_history_migration_incomplete');
		expect((await readBaroHistory(testEnv()))?.lastSeen).toHaveLength(1);
		const unknownNamespace = {
			get: async (key: string) => {
				if (key === 'archive:baro:later') throw new Error('unacknowledged read failed');
				return env.ITEM_META.get(key);
			},
			list: env.ITEM_META.list.bind(env.ITEM_META),
			put: env.ITEM_META.put.bind(env.ITEM_META),
		} as unknown as KVNamespace;
		await expect(migrateBaroHistory(testEnv({ ITEM_META: unknownNamespace }), NOW)).rejects.toThrow('baro_history_migration_incomplete');
		await env.ITEM_META.put('archive:baro:later', archive(later));
		await migrateBaroHistory(testEnv(), NOW + DAY);
		const before = (await readBaroHistory(testEnv()))?.lastSeen;
		expect(before).toHaveLength(2);
		const namespace = {
			get: async (key: string) => {
				if (key === 'archive:baro:old') throw new Error('transient');
				return env.ITEM_META.get(key);
			},
			list: env.ITEM_META.list.bind(env.ITEM_META),
			put: env.ITEM_META.put.bind(env.ITEM_META),
		} as unknown as KVNamespace;
		await expect(migrateBaroHistory(testEnv({ ITEM_META: namespace }), NOW + 2 * DAY)).resolves.toMatchObject({ lastSeen: before });
		expect((await readBaroHistory(testEnv()))?.lastSeen).toEqual(before);
		await migrateBaroHistory(testEnv(), NOW + 3 * DAY);
		expect((await readBaroHistory(testEnv()))?.lastSeen).toEqual(before);
	});
	it('preserves valid old per-item dates when repairing a partially corrupt durable value', async () => {
		const old = { uniqueName: '/Lotus/Fixture/OldOnly', ducats: 10, credits: null, visitId: 'old', lastSeen: NOW - 700 * DAY };
		const raw = JSON.stringify({ version: 1, updatedAt: NOW, coverageStart: old.lastSeen, visits: [], lastSeen: [old, { broken: true }] });
		await env.ITEM_META.put(BARO_HISTORY_KEY, raw);
		await env.ITEM_META.put(`archive:baro:${VISIT_A}`, archive(visit()));
		await migrateBaroHistory(testEnv(), NOW);
		expect(await env.ITEM_META.get('baro:history:recovery:v1')).toBe(raw);
		expect((await readBaroHistory(testEnv()))?.lastSeen).toContainEqual(old);
		expect((await readBaroHistory(testEnv()))?.lastSeen).toHaveLength(2);
		await migrateBaroHistory(testEnv(), NOW + DAY);
		expect(await env.ITEM_META.get('baro:history:recovery:v1')).toBe(raw);
	});
	it('archives current manifests before a corrupt migration index can fail', async () => {
		await env.ITEM_META.put('archive:index:baro:v1', '{broken');
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => worldState(visit()));
		expect((await archiveBaroVisit(testEnv(), { now: NOW })).status).toBe('error');
		expect(await env.ITEM_META.get(`archive:baro:${VISIT_A}`)).not.toBeNull();
		expect(await env.ITEM_META.get('archive:index:baro:v1')).toBe('{broken');
	});
	it('bounds corrupt document recovery by encoded bytes without replacing the source', async () => {
		const raw = JSON.stringify({
			...{ version: 1, updatedAt: NOW, coverageStart: null, visits: [], lastSeen: [] },
			extra: '\u20ac'.repeat(1_400_000),
		});
		await env.ITEM_META.put(BARO_HISTORY_KEY, raw);
		expect(await readBaroHistory(testEnv())).toBeNull();
		await expect(migrateBaroHistory(testEnv(), NOW)).rejects.toThrow('baro_history_too_large');
		expect(await env.ITEM_META.get(BARO_HISTORY_KEY)).toBe(raw);
	});
	it('advances after acknowledged archives expire across visit retention and a later cron', async () => {
		const scoped = testEnv({ HISTORY_RETENTION_DAYS: '1' });
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => worldState(visit()));
		expect((await archiveBaroVisit(scoped, { now: NOW })).status).toBe('written');
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ VoidTraders: [] })));
		expect((await archiveBaroVisit(scoped, { now: NOW + 4 * DAY })).status).toBe('inactive');
		expect((await readBaroHistory(scoped))?.visits).toHaveLength(0);
		await env.ITEM_META.delete(`archive:baro:${VISIT_A}`);
		expect((await archiveBaroVisit(scoped, { now: NOW + 5 * DAY })).status).toBe('inactive');
		const later = visit(`d${NOW + 6 * DAY}`, NOW + 6 * DAY, '/Lotus/Fixture/Later');
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => worldState(later));
		expect((await archiveBaroVisit(scoped, { now: NOW + 7 * DAY })).status).toBe('written');
		expect(JSON.parse((await env.ITEM_META.get('archive:index:baro:v1'))!).entries).toEqual([VISIT_A, later.id]);
		expect((await readBaroHistory(scoped))?.lastSeen).toContainEqual({ ...visit().items[0], visitId: VISIT_A, lastSeen: NOW - DAY });
	});
	it('uses pre-ledger durable visit proof when an indexed archive disappears', async () => {
		const old = visit();
		await env.ITEM_META.put(
			BARO_HISTORY_KEY,
			JSON.stringify({
				version: 1,
				updatedAt: NOW,
				coverageStart: old.activation,
				visits: [old],
				lastSeen: [{ ...old.items[0], visitId: old.id, lastSeen: old.activation }],
			}),
		);
		await env.ITEM_META.put('archive:index:baro:v1', JSON.stringify({ entries: [old.id] }));
		await migrateBaroHistory(testEnv({ HISTORY_RETENTION_DAYS: '1' }), NOW + 4 * DAY);
		await migrateBaroHistory(testEnv({ HISTORY_RETENTION_DAYS: '1' }), NOW + 5 * DAY);
		expect((await readBaroHistory(testEnv()))?.lastSeen[0].visitId).toBe(old.id);
	});
	it('keeps corrected schedules when the older raw archive is reconciled again', async () => {
		const original = visit();
		await env.ITEM_META.put(`archive:baro:${VISIT_A}`, archive(original));
		await migrateBaroHistory(testEnv(), NOW, original);
		const corrected = { ...original, expiry: original.expiry - 1 };
		await migrateBaroHistory(testEnv(), NOW, corrected);
		await migrateBaroHistory(testEnv(), NOW + DAY);
		expect((await readBaroHistory(testEnv()))?.visits[0].expiry).toBe(corrected.expiry);
	});
	it('filters treasure boxes from new and legacy archived manifests', async () => {
		const box = '/Lotus/StoreItems/Types/Items/MiscItems/BaroTreasureBox';
		await env.ITEM_META.put(
			'archive:baro:old',
			archive({ ...visit('old', NOW - 15 * DAY), items: [...visit().items, { uniqueName: box, ducats: 1, credits: 1 }] }),
		);
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			worldState(visit(), [
				{ ItemType: ITEM, PrimePrice: 2, RegularPrice: 3 },
				{ ItemType: box, PrimePrice: 1, RegularPrice: 1 },
			]),
		);
		expect((await archiveBaroVisit(testEnv(), { now: NOW })).status).toBe('written');
		const history = await readBaroHistory(testEnv());
		expect(history?.lastSeen).toHaveLength(1);
		expect(history?.visits.every((entry) => entry.items.length === 1)).toBe(true);
		expect(JSON.parse((await env.ITEM_META.get(`archive:baro:${VISIT_A}`))!).rows).toHaveLength(1);
	});
});
