import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { pickWfcdRelease, refreshWfcdRelics, trimWfcdRelics } from '../src/services/wfcdRelics';
import type { Env } from '../src/types';
import { expectEdgeCachedDocRoute } from './edgeCachedRoute';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DOC_KEY = 'wfcd-relics:doc:v1';
const STATE_KEY = 'wfcd-relics:state:v1';
const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const REGISTRY_URL = 'https://registry.npmjs.org/@wfcd%2Fitems';

const originalFetch = globalThis.fetch;
const testEnv = env as unknown as Env;

function hoursAgo(hours: number): string {
	return new Date(NOW - hours * HOUR).toISOString();
}

function dataUrl(version: string): string {
	return `https://cdn.jsdelivr.net/npm/@wfcd/items@${version}/data/json/Relics.json`;
}

// Real tables reuse about 600 part names across all relics; the trim refuses more than 2,000.
function rawReward(index: number, rarity = 'Uncommon', chance = 11): Record<string, unknown> {
	const part = index % 600;
	return {
		chance,
		item: {
			name: `Part ${part}`,
			uniqueName: `/Lotus/Types/Recipes/Test/Part${part}`,
			warframeMarket: { id: `id${part}`, urlName: `part_${part}` },
		},
		rarity,
	};
}

/** Shaped like a row of @wfcd/items data/json/Relics.json, extra fields included. */
function rawRelic(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		uniqueName: `/Lotus/Types/Game/Projections/T1VoidProjectionTest${index}Bronze`,
		name: `Lith T${index} Intact`,
		codexSecret: false,
		description: 'An artifact containing Orokin secrets.',
		type: 'Relic',
		imageName: 'RelicLithD.png',
		category: 'Relics',
		tradable: true,
		locations: [],
		rewards: [0, 1, 2, 3, 4, 5].map((slot) => rawReward(index * 10 + slot, slot === 0 ? 'Rare' : 'Uncommon', slot === 0 ? 2 : 11)),
		marketInfo: { id: `relic${index}`, urlName: `lith_t${index}_relic` },
		vaulted: false,
		masterable: false,
		...overrides,
	};
}

const GENERIC_ROWS = ['Axi', 'Lith', 'Meso', 'Neo', 'Requiem', 'Void'].map((tier, index) => ({
	uniqueName: `/Lotus/Types/Game/Projections/T${index}VoidProjection`,
	name: `${tier} Relic`,
	rewards: [],
}));

function relicTable(count: number): unknown[] {
	return [...Array.from({ length: count }, (_, index) => rawRelic(index)), ...GENERIC_ROWS];
}

const TABLE_TEXT = JSON.stringify(relicTable(2_500));

function packument(entries: Array<{ version: string; published: string; deprecated?: string }>, latest: string): Record<string, unknown> {
	return {
		name: '@wfcd/items',
		'dist-tags': { latest },
		versions: Object.fromEntries(
			entries.map(({ version, deprecated }) => [version, { name: '@wfcd/items', version, ...(deprecated ? { deprecated } : {}) }]),
		),
		time: {
			created: hoursAgo(10_000),
			modified: entries[entries.length - 1].published,
			...Object.fromEntries(entries.map(({ version, published }) => [version, published])),
		},
	};
}

// 1.0.2 is the dist-tags.latest but too young for the default 24-hour gate.
const REGISTRY = packument(
	[
		{ version: '1.0.0', published: hoursAgo(72) },
		{ version: '1.0.1', published: hoursAgo(30) },
		{ version: '1.0.2', published: hoursAgo(2) },
	],
	'1.0.2',
);

type Upstream = { registry: Record<string, unknown> | Response; data?: Record<string, string | Response> };

function mockUpstream(upstream: Upstream): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === REGISTRY_URL) {
			const { registry } = upstream;
			return registry instanceof Response ? registry.clone() : new Response(JSON.stringify(registry), { status: 200 });
		}
		for (const [version, table] of Object.entries(upstream.data ?? {})) {
			if (url !== dataUrl(version)) continue;
			return table instanceof Response ? table.clone() : new Response(table, { status: 200 });
		}
		throw new Error(`Unexpected url: ${url}`);
	});
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

function requestedUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
	return fetchMock.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));
}

async function readStoredDoc(): Promise<Record<string, unknown> | null> {
	const raw = await env.ITEM_META.get(DOC_KEY);
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function spyLogs(): () => unknown[] {
	const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
	return () => logSpy.mock.calls.map(([entry]) => entry);
}

// Workers KV answers 429 to a second write of one key within a second; a refresh here takes far less.
function strictKvRefresh(): (now: number, loseStateAfterDoc?: boolean) => ReturnType<typeof refreshWfcdRelics> {
	const kv = testEnv.ITEM_META;
	let written = new Set<string>();
	let loseState = false;
	const itemMeta = {
		get: kv.get.bind(kv),
		getWithMetadata: kv.getWithMetadata.bind(kv),
		put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
			if (written.has(key)) throw new Error('KV PUT failed: 429 Too Many Requests');
			if (loseState && key === STATE_KEY && written.has(DOC_KEY)) throw new Error('KV PUT failed: 503 Service Unavailable');
			written.add(key);
			await kv.put(key, value, options);
		},
	};
	const strictEnv = { ...testEnv, ITEM_META: itemMeta as unknown as KVNamespace };
	return (now, loseStateAfterDoc = false) => {
		written = new Set();
		loseState = loseStateAfterDoc;
		return refreshWfcdRelics(strictEnv, { now });
	};
}

beforeEach(async () => {
	(env as unknown as Record<string, string>).PUBLIC_BOOTSTRAP_REQUIRED = '0';
	(env as unknown as Record<string, string>).DAILY_BUDGET_ENABLED = '0';
	(env as unknown as Record<string, string>).PUBLIC_RATE_LIMIT_ENABLED = '0';
	delete (env as unknown as Record<string, string>).WFCD_RELEASE_AGE_HOURS;
	await env.ITEM_META.delete(DOC_KEY);
	await env.ITEM_META.delete(STATE_KEY);
	await caches.default.delete(new Request('http://example.com/v1/wfcd-relics?v=1'));
});

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.fetch = originalFetch;
});

describe('wfcd relic trim', () => {
	it('keeps only the served fields, in contract order, and omits absent optionals', () => {
		const full = rawRelic(0, {
			vaulted: true,
			drops: [{ location: 'Void/Hepit', chance: 0.1 }, { location: 'Void/Ukko' }],
			rewards: [
				{
					chance: 2,
					rarity: 'Rare',
					item: {
						name: 'Citrine Prime Neuroptics Blueprint',
						uniqueName: '/Lotus/Types/Recipes/WarframeRecipes/CitrinePrimeHelmetBlueprint',
						imageName: 'citrine-prime-neuroptics.png',
						ducats: 100,
						tradable: true,
						warframeMarket: { id: '6ab3f1bb626e0c6df7f6c9af', url_name: 'citrine_prime_neuroptics_blueprint' },
					},
				},
				{
					chance: 25.33,
					rarity: 'Common',
					item: { name: 'Forma Blueprint', uniqueName: '/Lotus/Types/Recipes/Components/FormaBlueprint' },
				},
			],
		});
		const bare = { ...rawRelic(1), imageName: '', vaulted: undefined, rewards: [rawReward(7)] };
		const trimmed = trimWfcdRelics([full, bare, ...relicTable(2_498)]);

		expect(JSON.stringify(trimmed?.relics.slice(0, 2))).toBe(
			JSON.stringify([
				{
					uniqueName: '/Lotus/Types/Game/Projections/T1VoidProjectionTest0Bronze',
					name: 'Lith T0 Intact',
					vaulted: true,
					imageName: 'RelicLithD.png',
					dropCount: 2,
					rewards: [
						{
							chance: 2,
							rarity: 'Rare',
							item: {
								uniqueName: '/Lotus/Types/Recipes/WarframeRecipes/CitrinePrimeHelmetBlueprint',
								name: 'Citrine Prime Neuroptics Blueprint',
								imageName: 'citrine-prime-neuroptics.png',
								ducats: 100,
								warframeMarket: { id: '6ab3f1bb626e0c6df7f6c9af', urlName: 'citrine_prime_neuroptics_blueprint' },
							},
						},
						{
							chance: 25.33,
							rarity: 'Common',
							item: { uniqueName: '/Lotus/Types/Recipes/Components/FormaBlueprint', name: 'Forma Blueprint' },
						},
					],
				},
				{
					uniqueName: '/Lotus/Types/Game/Projections/T1VoidProjectionTest1Bronze',
					name: 'Lith T1 Intact',
					vaulted: false,
					dropCount: 0,
					rewards: [
						{
							chance: 11,
							rarity: 'Uncommon',
							item: { uniqueName: '/Lotus/Types/Recipes/Test/Part7', name: 'Part 7', warframeMarket: { id: 'id7', urlName: 'part_7' } },
						},
					],
				},
			]),
		);
		expect(trimmed?.dropped).toBe(GENERIC_ROWS.length);
	});

	it('drops every row that breaks a rule and counts it', () => {
		const long = 'x'.repeat(257);
		const withReward = (index: number, reward: Record<string, unknown>) =>
			rawRelic(index, { rewards: [reward, ...(rawRelic(index).rewards as unknown[])].slice(0, 6) });
		const withItem = (index: number, item: Record<string, unknown>) => withReward(index, { chance: 11, rarity: 'Uncommon', item });
		const invalid: unknown[] = [
			null,
			'Lith A1 Intact',
			rawRelic(9_001, { uniqueName: '/Lotus/Types/Game/Other/T1VoidProjectionTestBronze' }),
			rawRelic(9_002, { name: 'Requiem Eterna Relic', rewards: Array.from({ length: 8 }, (_, slot) => rawReward(slot)) }),
			rawRelic(9_003, { name: 'Lith T9003 Pristine' }),
			rawRelic(9_004, { rewards: [] }),
			rawRelic(9_005, { rewards: Array.from({ length: 13 }, (_, slot) => rawReward(slot)) }),
			rawRelic(9_006, { rewards: 'none' }),
			withReward(9_007, { ...rawReward(1), chance: 0 }),
			withReward(9_008, { ...rawReward(1), chance: 100.5 }),
			withReward(9_009, { ...rawReward(1), chance: Number.NaN }),
			withReward(9_010, { ...rawReward(1), chance: '11' }),
			withReward(9_011, { ...rawReward(1), rarity: 'Legendary' }),
			withReward(9_012, { chance: 11, rarity: 'Uncommon' }),
			withItem(9_013, { name: '', uniqueName: '/Lotus/Types/Recipes/Test/Part1' }),
			withItem(9_014, { name: 'Part 1' }),
			rawRelic(9_015, { name: `Lith ${long} Intact` }),
			rawRelic(9_016, { imageName: long }),
			withItem(9_017, { name: 'Part 1', uniqueName: '/Lotus/Types/Recipes/Test/Part1', warframeMarket: { urlName: long } }),
		];
		const valid = relicTable(2_500).slice(0, 2_500);
		const trimmed = trimWfcdRelics([...valid, ...invalid]);

		expect(trimmed?.relics).toHaveLength(2_500);
		expect(trimmed?.dropped).toBe(invalid.length);
		expect(new Set(trimmed?.relics.map((relic) => relic.uniqueName))).toEqual(
			new Set(valid.map((row) => (row as { uniqueName: string }).uniqueName)),
		);
		// Chance 100 and a 256-character string still pass.
		const edge = rawRelic(0, { imageName: 'y'.repeat(256), rewards: [{ ...rawReward(1), chance: 100 }] });
		expect(trimWfcdRelics([edge, ...relicTable(2_500).slice(1, 2_500)])?.relics[0].rewards[0].chance).toBe(100);
	});

	it('refuses a table outside the row floor', () => {
		expect(trimWfcdRelics(relicTable(2_499))).toBeNull();
		expect(trimWfcdRelics(relicTable(10_001))).toBeNull();
		expect(trimWfcdRelics(relicTable(10_000))?.relics).toHaveLength(10_000);
		expect(trimWfcdRelics({ relics: relicTable(3_000) })).toBeNull();
	});
});

describe('wfcd release pick', () => {
	const DAY = 24 * HOUR;

	it('adopts the newest version old enough, stepping back past a young latest', () => {
		expect(pickWfcdRelease(REGISTRY, NOW, DAY)).toEqual({ version: '1.0.1', publishedAt: hoursAgo(30) });
		expect(pickWfcdRelease(REGISTRY, NOW, HOUR)).toEqual({ version: '1.0.2', publishedAt: hoursAgo(2) });
		expect(pickWfcdRelease(REGISTRY, NOW, 100 * HOUR)).toBeNull();
	});

	it('skips deprecated, prerelease, unpublished and above-latest versions', () => {
		const registry = packument(
			[
				{ version: '1.0.9', published: hoursAgo(90) },
				{ version: '1.0.10', published: hoursAgo(80), deprecated: 'broken data' },
				{ version: '1.1.0-beta.1', published: hoursAgo(70) },
				{ version: '2.0.0', published: hoursAgo(60) },
				{ version: '1.0.11', published: hoursAgo(50) },
			],
			'1.0.11',
		);
		(registry.time as Record<string, string>)['1.0.12'] = hoursAgo(40);

		expect(pickWfcdRelease(registry, NOW, DAY)?.version).toBe('1.0.11');
		const versions = registry.versions as Record<string, unknown>;
		delete versions['1.0.11'];
		expect(pickWfcdRelease(registry, NOW, DAY)?.version).toBe('1.0.9');
	});
});

describe('wfcd relics refresh', () => {
	it('stores the trimmed doc, then checks npm at most hourly without refetching the same version', async () => {
		const fetchMock = mockUpstream({ registry: REGISTRY, data: { '1.0.1': TABLE_TEXT } });

		expect(await refreshWfcdRelics(testEnv, { now: NOW })).toBe('built');
		expect(requestedUrls(fetchMock)).toEqual([REGISTRY_URL, dataUrl('1.0.1')]);
		const stored = await readStoredDoc();
		expect(Object.keys(stored ?? {})).toEqual(['version', 'publishedAt', 'generatedAt', 'relics']);
		expect(stored).toMatchObject({ version: '1.0.1', publishedAt: hoursAgo(30), generatedAt: new Date(NOW).toISOString() });
		expect((stored?.relics as unknown[]).length).toBe(2_500);

		expect(await refreshWfcdRelics(testEnv, { now: NOW + 60_000 })).toBe('skipped');
		expect(fetchMock).toHaveBeenCalledTimes(2);

		expect(await refreshWfcdRelics(testEnv, { now: NOW + HOUR + 1 })).toBe('unchanged');
		expect(requestedUrls(fetchMock).slice(2)).toEqual([REGISTRY_URL]);
		expect((await readStoredDoc())?.generatedAt).toBe(new Date(NOW).toISOString());
	});

	it('changes nothing when no version is old enough, and honours the age override', async () => {
		const young = packument([{ version: '1.0.2', published: hoursAgo(2) }], '1.0.2');
		const fetchMock = mockUpstream({ registry: young, data: { '1.0.2': TABLE_TEXT } });

		expect(await refreshWfcdRelics(testEnv, { now: NOW })).toBe('unchanged');
		expect(requestedUrls(fetchMock)).toEqual([REGISTRY_URL]);
		expect(await readStoredDoc()).toBeNull();

		(env as unknown as Record<string, string>).WFCD_RELEASE_AGE_HOURS = '1';
		expect(await refreshWfcdRelics(testEnv, { now: NOW, force: true })).toBe('built');
		expect((await readStoredDoc())?.version).toBe('1.0.2');
	});

	it('steps back when npm deprecates the stored release, even with the same relics', async () => {
		(env as unknown as Record<string, string>).WFCD_RELEASE_AGE_HOURS = '1';
		mockUpstream({ registry: REGISTRY, data: { '1.0.2': TABLE_TEXT } });
		expect(await refreshWfcdRelics(testEnv, { now: NOW })).toBe('built');
		delete (env as unknown as Record<string, string>).WFCD_RELEASE_AGE_HOURS;

		const deprecated = packument(
			[
				{ version: '1.0.1', published: hoursAgo(30) },
				{ version: '1.0.2', published: hoursAgo(26), deprecated: 'bad relic data' },
			],
			'1.0.2',
		);
		mockUpstream({ registry: deprecated, data: { '1.0.1': TABLE_TEXT } });
		expect(await refreshWfcdRelics(testEnv, { now: NOW + HOUR + 1 })).toBe('built');
		expect((await readStoredDoc())?.version).toBe('1.0.1');
	});

	it('answers 404 while WFCD_RELICS_ENABLED is 0 but keeps the doc current for re-enabling', async () => {
		mockUpstream({ registry: REGISTRY, data: { '1.0.1': TABLE_TEXT } });
		(env as unknown as Record<string, string>).WFCD_RELICS_ENABLED = '0';
		try {
			expect(await refreshWfcdRelics(testEnv, { now: NOW })).toBe('built');
			const ctx = createExecutionContext();
			const response = await worker.fetch(new IncomingRequest('https://api.wfhelper.com/v1/wfcd-relics'), testEnv, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(404);
		} finally {
			delete (env as unknown as Record<string, string>).WFCD_RELICS_ENABLED;
		}
	});

	it('keeps the doc and its version when a newer release leaves the relics unchanged', async () => {
		mockUpstream({ registry: REGISTRY, data: { '1.0.1': TABLE_TEXT } });
		await refreshWfcdRelics(testEnv, { now: NOW });
		const before = await env.ITEM_META.get(DOC_KEY);

		const newer = packument(
			[
				{ version: '1.0.1', published: hoursAgo(30) },
				{ version: '1.0.2', published: hoursAgo(26) },
			],
			'1.0.2',
		);
		const fetchMock = mockUpstream({ registry: newer, data: { '1.0.2': TABLE_TEXT } });
		expect(await refreshWfcdRelics(testEnv, { now: NOW + HOUR + 1 })).toBe('unchanged');
		expect(requestedUrls(fetchMock)).toEqual([REGISTRY_URL, dataUrl('1.0.2')]);
		expect(await env.ITEM_META.get(DOC_KEY)).toBe(before);

		// The unchanged release is remembered, so the next check does not download it again.
		expect(await refreshWfcdRelics(testEnv, { now: NOW + 2 * HOUR + 2 })).toBe('unchanged');
		expect(requestedUrls(fetchMock).slice(2)).toEqual([REGISTRY_URL]);

		const changed = packument(
			[
				{ version: '1.0.2', published: hoursAgo(26) },
				{ version: '1.0.3', published: hoursAgo(25) },
			],
			'1.0.3',
		);
		mockUpstream({ registry: changed, data: { '1.0.3': JSON.stringify(relicTable(2_501)) } });
		expect(await refreshWfcdRelics(testEnv, { now: NOW + 3 * HOUR + 3 })).toBe('built');
		expect((await readStoredDoc())?.version).toBe('1.0.3');
	});

	it('writes each key once per check and still rolls back when the state write after a new doc is lost', async () => {
		const refresh = strictKvRefresh();
		const releases = [
			{ version: '1.0.1', published: hoursAgo(30) },
			{ version: '1.0.2', published: hoursAgo(29) },
			{ version: '1.0.3', published: hoursAgo(28) },
		];
		mockUpstream({ registry: packument(releases.slice(0, 1), '1.0.1'), data: { '1.0.1': TABLE_TEXT } });
		expect(await refresh(NOW)).toBe('built');
		mockUpstream({ registry: packument(releases.slice(0, 2), '1.0.2'), data: { '1.0.2': TABLE_TEXT } });
		expect(await refresh(NOW + HOUR + 1)).toBe('unchanged');

		mockUpstream({ registry: packument(releases, '1.0.3'), data: { '1.0.3': JSON.stringify(relicTable(2_501)) } });
		await expect(refresh(NOW + 2 * HOUR + 2, true)).rejects.toThrow('503');
		expect((await readStoredDoc())?.version).toBe('1.0.3');

		// npm unpublishes 1.0.3; 1.0.2 was remembered against the 1.0.1 doc, not this one.
		mockUpstream({ registry: packument(releases.slice(0, 2), '1.0.2'), data: { '1.0.2': TABLE_TEXT } });
		expect(await refresh(NOW + 3 * HOUR + 3)).toBe('built');
		expect((await readStoredDoc())?.version).toBe('1.0.2');
	});

	it('keeps the old doc when the next table falls under the floor or is not JSON', async () => {
		mockUpstream({ registry: REGISTRY, data: { '1.0.1': TABLE_TEXT } });
		await refreshWfcdRelics(testEnv, { now: NOW });
		const before = await env.ITEM_META.get(DOC_KEY);

		const logs = spyLogs();
		const newer = packument(
			[
				{ version: '1.0.1', published: hoursAgo(30) },
				{ version: '1.0.2', published: hoursAgo(26) },
			],
			'1.0.2',
		);
		mockUpstream({ registry: newer, data: { '1.0.2': JSON.stringify(relicTable(2_499)) } });
		expect(await refreshWfcdRelics(testEnv, { now: NOW + HOUR + 1 })).toBe('failed');
		expect(await env.ITEM_META.get(DOC_KEY)).toBe(before);
		expect(logs()).toContainEqual({ type: 'cron', route: 'wfcd-relics:refresh', status: 204, error: 'wfcd_invalid', source: 'jsdelivr' });

		mockUpstream({ registry: newer, data: { '1.0.2': '[{"truncated":' } });
		expect(await refreshWfcdRelics(testEnv, { now: NOW + 2 * HOUR + 2 })).toBe('failed');
		expect(await env.ITEM_META.get(DOC_KEY)).toBe(before);
	});

	it('keeps the old doc when npm or jsDelivr is unreachable', async () => {
		mockUpstream({ registry: REGISTRY, data: { '1.0.1': TABLE_TEXT } });
		await refreshWfcdRelics(testEnv, { now: NOW });
		const before = await env.ITEM_META.get(DOC_KEY);
		const logs = spyLogs();

		mockUpstream({ registry: new Response('busy', { status: 503 }) });
		expect(await refreshWfcdRelics(testEnv, { now: NOW + HOUR + 1 })).toBe('failed');
		expect(logs()).toContainEqual({
			type: 'cron',
			route: 'wfcd-relics:refresh',
			status: 204,
			error: 'wfcd_unavailable',
			source: 'registry',
		});

		const newer = packument(
			[
				{ version: '1.0.1', published: hoursAgo(30) },
				{ version: '1.0.2', published: hoursAgo(26) },
			],
			'1.0.2',
		);
		// A failed registry check retries on the next tick; a failed table waits an hour.
		mockUpstream({ registry: newer, data: { '1.0.2': new Response('Not found', { status: 404 }) } });
		expect(await refreshWfcdRelics(testEnv, { now: NOW + HOUR + 2 })).toBe('failed');
		expect(logs()).toContainEqual({
			type: 'cron',
			route: 'wfcd-relics:refresh',
			status: 204,
			error: 'wfcd_unavailable',
			source: 'jsdelivr',
		});
		expect(await refreshWfcdRelics(testEnv, { now: NOW + HOUR + 3 })).toBe('skipped');
		expect(await env.ITEM_META.get(DOC_KEY)).toBe(before);
	});

	it('runs on the quarter-hour cron tick', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url === REGISTRY_URL) {
				const registry = packument([{ version: '1.0.1', published: new Date(Date.now() - 30 * HOUR).toISOString() }], '1.0.1');
				return new Response(JSON.stringify(registry));
			}
			if (url === dataUrl('1.0.1')) return new Response(TABLE_TEXT);
			return new Response('{}', { status: 404 });
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		spyLogs();

		const ctx = createExecutionContext();
		const tick = { cron: '*/15 * * * *', scheduledTime: Date.parse('2026-09-26T12:15:00.000Z'), noRetry: () => undefined };
		await worker.scheduled(tick as ScheduledController, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect((await readStoredDoc())?.version).toBe('1.0.1');
	});
});

describe('GET /v1/wfcd-relics', () => {
	async function get(headers: Record<string, string> = {}): Promise<Response> {
		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('http://example.com/v1/wfcd-relics', { headers }), testEnv, ctx);
		await waitOnExecutionContext(ctx);
		return response;
	}

	async function publish(): Promise<void> {
		mockUpstream({ registry: REGISTRY, data: { '1.0.1': TABLE_TEXT } });
		await refreshWfcdRelics(testEnv, { now: NOW });
		globalThis.fetch = originalFetch;
	}

	it('answers an uncached 404 before the first refresh publishes', async () => {
		const response = await get();
		expect(response.status).toBe(404);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({ ok: false, error: 'wfcd_relics_not_ready' });

		await publish();
		expect((await get()).status).toBe(200);
	});

	it('serves the contract body with edge caching and revalidates on the version ETag', async () => {
		await publish();

		const response = await get();
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
		const etag = response.headers.get('etag');
		expect(etag).toBe('"wfcd-1.0.1-1"');
		const body = (await response.json()) as Record<string, unknown> & { relics: Array<Record<string, unknown>> };
		expect(Object.keys(body)).toEqual(['ok', 'version', 'publishedAt', 'generatedAt', 'relics']);
		expect(body).toMatchObject({ ok: true, version: '1.0.1', publishedAt: hoursAgo(30), generatedAt: new Date(NOW).toISOString() });
		expect(body.relics).toHaveLength(2_500);
		expect(body.relics[0]).toMatchObject({ name: 'Lith T0 Intact', vaulted: false, dropCount: 0, imageName: 'RelicLithD.png' });

		const matching = await get({ 'if-none-match': etag ?? '' });
		expect(matching.status).toBe(304);
		expect(matching.headers.get('etag')).toBe(etag);
		expect(await matching.text()).toBe('');

		const cached = await get();
		expect(cached.status).toBe(200);
		expect(cached.headers.get('etag')).toBe(etag);
		expect(((await cached.json()) as { version: string }).version).toBe('1.0.1');
	});

	it('keeps CORS, ETags and 304s on fresh and edge-cached answers', async () => {
		await publish();

		await expectEdgeCachedDocRoute('/v1/wfcd-relics', 'http://example.com/v1/wfcd-relics?v=1', DOC_KEY);
	});

	it('refuses a stored doc whose metadata is missing', async () => {
		await env.ITEM_META.put(DOC_KEY, JSON.stringify({ version: '1.0.1', publishedAt: NOW, generatedAt: NOW, relics: [] }));

		expect((await get()).status).toBe(404);
	});
});
