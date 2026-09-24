import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WFM_PRICE_BASIS } from '../../../config/shared/wfmStats';
import type { Env } from '../src/types';
import { prewarmBatch, prewarmOrderSummaryCatalog } from '../src/services/prewarm';
import { fetchCatalogSlugs, resetRankedSlugCacheForTest } from '../src/services/prewarmCatalog';
import { getOrHydratePrice } from '../src/services/readThrough';

const CATALOG_SLUGS_KEY = 'catalog:slugs:v1';
const RANKED_CATALOG_KEY = 'order-summary:catalog:v1';
const originalFetch = globalThis.fetch;

interface StatsRow {
	rank?: number;
	median: number;
	volume?: number;
	minutesAgo: number;
}

beforeEach(() => {
	(env as unknown as Record<string, string>).CATALOG_SLUG_GUARD_ENABLED = '0';
	resetRankedSlugCacheForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.fetch = originalFetch;
});

async function seedCatalog(slug: string): Promise<void> {
	await env.ITEM_META.put(CATALOG_SLUGS_KEY, JSON.stringify({ updatedAt: Date.now(), slugs: [slug], rankedSummaryCatalog: [] }));
}

async function seedRankedCatalog(entries: Array<{ slug: string; maxRank: number }> | null): Promise<void> {
	if (entries == null) {
		await env.ITEM_META.delete(RANKED_CATALOG_KEY);
		return;
	}
	await env.ITEM_META.put(RANKED_CATALOG_KEY, JSON.stringify({ updatedAt: Date.now(), entries }));
}

function statsPayload(rows: StatsRow[]): unknown {
	return {
		payload: {
			statistics_closed: {
				'48hours': rows.map((row) => ({
					datetime: new Date(Date.now() - row.minutesAgo * 60 * 1000).toISOString(),
					order_type: 'sell',
					wa_price: row.median,
					volume: row.volume ?? 1,
					...(row.rank == null ? {} : { mod_rank: row.rank }),
				})),
			},
		},
	};
}

function jsonOk(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Serves meta + statistics for one slug; `stats` may return a raw Response to model failures. */
function mockWfm(slug: string, stats: () => unknown): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === `https://api.warframe.market/v2/items/${slug}`) {
			return jsonOk({ data: { slug, tradable: true, i18n: { en: {} } } });
		}
		if (url === `https://api.warframe.market/v1/items/${slug}/statistics`) {
			const result = stats();
			return result instanceof Response ? result : jsonOk(result);
		}
		throw new Error(`Unexpected url: ${url}`);
	});
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

async function readPrice(slug: string): Promise<Record<string, unknown> | null> {
	const raw = await env.PRICE_CACHE.get(`price:${slug}`);
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

async function readSnapshotPrice(slug: string): Promise<Record<string, unknown> | undefined> {
	const raw = await env.PRICE_CACHE.get('snapshot:full:v1');
	if (!raw) return undefined;
	const snapshot = JSON.parse(raw) as { prices?: Record<string, Record<string, unknown>> };
	return snapshot.prices?.[slug];
}

describe('unranked prewarm sweep rank pinning', () => {
	it.each([{}, { payload: {} }, { payload: { statistics_closed: { '48hours': {} } } }])(
		'keeps a cached price after malformed statistics %j',
		async (payload) => {
			const slug = 'wf_test_sweep_malformed_stats';
			await seedCatalog(slug);
			await seedRankedCatalog([{ slug, maxRank: 10 }]);
			await env.PRICE_CACHE.put(`price:${slug}`, JSON.stringify({ slug, median: 42, priceBasis: WFM_PRICE_BASIS, timestamp: Date.now() }));
			mockWfm(slug, () => payload);

			await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

			expect(await readPrice(slug)).toMatchObject({ median: 42 });
			expect(await env.PRICE_CACHE.get(`miss:price:v3:${slug}`)).toBeNull();
		},
	);

	it('clears an unranked cached price and snapshot when closed sales are empty', async () => {
		const slug = 'wf_test_sweep_empty_unranked';
		await seedCatalog(slug);
		await seedRankedCatalog([]);
		await env.PRICE_CACHE.put(`price:${slug}`, JSON.stringify({ slug, median: 42, priceBasis: WFM_PRICE_BASIS, timestamp: Date.now() }));
		mockWfm(slug, () => statsPayload([]));

		await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(await readPrice(slug)).toBeNull();
		expect(await env.PRICE_CACHE.get(`miss:price:v3:${slug}`)).toBe('1');
		expect(await readSnapshotPrice(slug)).toMatchObject({ status: 'no_data', median: null, priceBasis: WFM_PRICE_BASIS });
	});

	it('clears both ranked prices when the ranked sweep confirms an empty sales window', async () => {
		const slug = 'wf_test_sweep_empty_ranks';
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		for (const rank of [0, 10]) {
			await env.PRICE_CACHE.put(
				`price:${slug}:r${rank}`,
				JSON.stringify({ slug, rank, median: 42, priceBasis: WFM_PRICE_BASIS, timestamp: 1 }),
			);
			await env.PRICE_CACHE.put(`orders-summary:${slug}:r${rank}`, JSON.stringify({ slug, rank, wts: 42, wtb: 40, timestamp: Date.now() }));
		}
		mockWfm(slug, () => statsPayload([]));

		await prewarmOrderSummaryCatalog(env as Env, { reason: 'cron', batchSize: 1, resetCursor: true });

		for (const rank of [0, 10]) {
			expect(await env.PRICE_CACHE.get(`price:${slug}:r${rank}`)).toBeNull();
			expect(await env.PRICE_CACHE.get(`miss:price:v3:${slug}:r${rank}`)).toBe('1');
			expect(await readSnapshotPrice(`${slug}:rank-v3:r${rank}`)).toMatchObject({ status: 'no_data', median: null });
		}
	});

	it('drops a fake close far above the live book of its rank in the ranked sweep', async () => {
		const slug = 'wf_test_sweep_fake_close';
		await seedRankedCatalog([{ slug, maxRank: 5 }]);
		for (const rank of [0, 5]) {
			await env.PRICE_CACHE.put(
				`price:${slug}:r${rank}`,
				JSON.stringify({ slug, rank, median: 69420, priceBasis: WFM_PRICE_BASIS, timestamp: 1 }),
			);
			await env.PRICE_CACHE.put(
				`orders-summary:${slug}:r${rank}`,
				JSON.stringify({ slug, rank, wts: 5, wtb: null, timestamp: Date.now() }),
			);
		}
		const book = (rank: number, median: number) => ({
			datetime: new Date().toISOString(),
			order_type: 'sell',
			mod_rank: rank,
			median,
		});
		mockWfm(slug, () => {
			const payload = statsPayload([
				{ rank: 0, median: 69420, minutesAgo: 240 },
				{ rank: 5, median: 15, minutesAgo: 60 },
			]) as { payload: Record<string, unknown> };
			payload.payload.statistics_live = { '48hours': [book(0, 5), book(0, 10), book(5, 24)] };
			return payload;
		});

		await prewarmOrderSummaryCatalog(env as Env, { reason: 'cron', batchSize: 1, resetCursor: true });

		expect(await env.PRICE_CACHE.get(`price:${slug}:r0`)).toBeNull();
		expect(await readSnapshotPrice(`${slug}:rank-v3:r0`)).toMatchObject({ status: 'no_data', median: null });
		expect(JSON.parse((await env.PRICE_CACHE.get(`price:${slug}:r5`)) ?? 'null')).toMatchObject({ median: 15 });
		expect(await readSnapshotPrice(`${slug}:rank-v3:r5`)).toMatchObject({ status: 'ok', median: 15 });
	});

	it('recomputes a fresh legacy price during the cron sweep', async () => {
		const slug = 'wf_test_sweep_legacy_price';
		await seedCatalog(slug);
		await seedRankedCatalog([]);
		await env.PRICE_CACHE.put(`price:${slug}`, JSON.stringify({ slug, median: 999, rank: null, timestamp: Date.now() }));
		mockWfm(slug, () =>
			statsPayload([
				{ median: 20, volume: 1, minutesAgo: 120 },
				{ median: 40, volume: 3, minutesAgo: 60 },
			]),
		);

		const result = await prewarmBatch(env as Env, { reason: 'cron', batchSize: 1, resetCursor: true });

		expect(result.priceUpdated).toBe(1);
		expect(await readPrice(slug)).toMatchObject({ median: 35, priceBasis: WFM_PRICE_BASIS });
		expect(await readSnapshotPrice(slug)).toMatchObject({ median: 35, priceBasis: WFM_PRICE_BASIS });
	});

	it('stores the rank 0 average for a slug the ranked catalog knows', async () => {
		const slug = 'wf_test_sweep_ranked_slug';
		await seedCatalog(slug);
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		mockWfm(slug, () =>
			statsPayload([
				{ rank: 0, median: 50, minutesAgo: 120 },
				{ rank: 10, median: 123, minutesAgo: 10 },
			]),
		);

		const result = await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(result.priceUpdated).toBe(1);
		expect(await readPrice(slug)).toMatchObject({ slug, median: 50, rank: null });
		expect(await readSnapshotPrice(slug)).toMatchObject({ status: 'ok', median: 50 });
	});

	it('volume-weights the closed sales of an unranked slug', async () => {
		const slug = 'wf_test_sweep_unranked_slug';
		await seedCatalog(slug);
		await seedRankedCatalog([{ slug: 'wf_test_sweep_other_ranked_slug', maxRank: 5 }]);
		mockWfm(slug, () =>
			statsPayload([
				{ median: 11, minutesAgo: 120 },
				{ median: 17, volume: 3, minutesAgo: 10 },
			]),
		);

		const result = await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(result.priceUpdated).toBe(1);
		expect(await readPrice(slug)).toMatchObject({ slug, median: 16, rank: null });
	});

	it('averages unranked sales when the stored ranked catalog is empty', async () => {
		const slug = 'wf_test_sweep_empty_catalog_slug';
		await seedCatalog(slug);
		await seedRankedCatalog([]);
		mockWfm(slug, () =>
			statsPayload([
				{ median: 50, minutesAgo: 120 },
				{ median: 123, minutesAgo: 10 },
			]),
		);

		const result = await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(result.failures).toBe(0);
		expect(result.priceUpdated).toBe(1);
		expect(await readPrice(slug)).toMatchObject({ slug, median: 87, rank: null });
	});

	it('preserves the cached bare price when the ranked catalog is missing', async () => {
		const slug = 'wf_test_sweep_no_catalog_slug';
		await seedCatalog(slug);
		await seedRankedCatalog(null);
		await env.PRICE_CACHE.put(
			`price:${slug}`,
			JSON.stringify({ priceBasis: WFM_PRICE_BASIS, slug, median: 50, rank: null, timestamp: Date.now() }),
		);
		mockWfm(slug, () =>
			statsPayload([
				{ rank: 0, median: 50, minutesAgo: 120 },
				{ rank: 10, median: 123, minutesAgo: 10 },
			]),
		);

		const result = await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(result.failures).toBe(0);
		expect(result.priceUpdated).toBe(0);
		// Meta keeps sweeping; only the rank-sensitive half is held back.
		expect(result.metaUpdated).toBe(1);
		expect(await readPrice(slug)).toMatchObject({ slug, median: 50, rank: null });
		expect(await env.PRICE_CACHE.get(`miss:price:v3:${slug}`)).toBeNull();
	});

	it('preserves the cached bare price when the ranked catalog read throws', async () => {
		const slug = 'wf_test_sweep_catalog_throws_slug';
		await seedCatalog(slug);
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.put(
			`price:${slug}`,
			JSON.stringify({ priceBasis: WFM_PRICE_BASIS, slug, median: 50, rank: null, timestamp: Date.now() }),
		);
		mockWfm(slug, () => statsPayload([{ rank: 10, median: 123, minutesAgo: 10 }]));

		const brokenEnv = {
			...env,
			ITEM_META: {
				...env.ITEM_META,
				get: vi.fn(async (key: string) => {
					if (key === RANKED_CATALOG_KEY) throw new Error('kv unavailable');
					return env.ITEM_META.get(key);
				}),
				put: env.ITEM_META.put.bind(env.ITEM_META),
				delete: env.ITEM_META.delete.bind(env.ITEM_META),
			},
		} as unknown as Env;

		const result = await prewarmBatch(brokenEnv, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(result.failures).toBe(0);
		expect(result.priceUpdated).toBe(0);
		expect(await readPrice(slug)).toMatchObject({ slug, median: 50, rank: null });
		expect(await env.PRICE_CACHE.get(`miss:price:v3:${slug}`)).toBeNull();
	});

	it('drops the stale bare price when a ranked slug has no rank 0 sale', async () => {
		const slug = 'wf_test_sweep_no_rank0_slug';
		await seedCatalog(slug);
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.put(
			`price:${slug}`,
			JSON.stringify({ priceBasis: WFM_PRICE_BASIS, slug, median: 999, rank: null, timestamp: Date.now() }),
		);
		mockWfm(slug, () => statsPayload([{ rank: 10, median: 123, minutesAgo: 10 }]));

		const result = await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(result.priceUpdated).toBe(0);
		expect(await readPrice(slug)).toBeNull();
		expect(await env.PRICE_CACHE.get(`miss:price:v3:${slug}`)).toBe('1');
		expect(await readSnapshotPrice(slug)).toMatchObject({ status: 'no_data', median: null });
	});

	it('keeps the stored ranked catalog when a refresh returns no ranked items', async () => {
		const kept = [{ slug: 'wf_test_sweep_kept_ranked_slug', maxRank: 10 }];
		await seedRankedCatalog(kept);
		globalThis.fetch = vi.fn(async () =>
			jsonOk({ data: [{ slug: 'wf_test_sweep_plain_slug', tradable: true, i18n: { en: { name: 'Plain' } } }] }),
		) as unknown as typeof fetch;

		const slugs = await fetchCatalogSlugs(env as Env, true);

		expect(slugs).toEqual(['wf_test_sweep_plain_slug']);
		const stored = JSON.parse(String(await env.ITEM_META.get(RANKED_CATALOG_KEY))) as { entries?: unknown };
		expect(stored.entries).toEqual(kept);
	});

	it('keeps the cached bare price when the ranked stats fetch fails transiently', async () => {
		const slug = 'wf_test_sweep_transient_slug';
		await seedCatalog(slug);
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.put(
			`price:${slug}`,
			JSON.stringify({ priceBasis: WFM_PRICE_BASIS, slug, median: 42, rank: null, timestamp: Date.now() }),
		);
		mockWfm(slug, () => new Response('boom', { status: 503 }));

		await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(await readPrice(slug)).toMatchObject({ slug, median: 42 });
		expect(await env.PRICE_CACHE.get(`miss:price:v3:${slug}`)).toBeNull();
	});

	it('keeps the cached bare price when a ranked stats fetch fails permanently', async () => {
		const slug = 'wf_test_sweep_permanent_slug';
		await seedCatalog(slug);
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.put(
			`price:${slug}`,
			JSON.stringify({ priceBasis: WFM_PRICE_BASIS, slug, median: 42, rank: null, timestamp: Date.now() }),
		);
		mockWfm(slug, () => new Response('nope', { status: 404 }));

		await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(await readPrice(slug)).toMatchObject({ slug, median: 42 });
		expect(await env.PRICE_CACHE.get(`miss:price:v3:${slug}`)).toBeNull();
	});
});

describe('read-through price rank pinning', () => {
	async function hydrate(slug: string): Promise<Awaited<ReturnType<typeof getOrHydratePrice>>> {
		const ctx = createExecutionContext();
		const result = await getOrHydratePrice(env as Env, slug, ctx);
		await waitOnExecutionContext(ctx);
		return result;
	}

	it.each([null, 0, 10])('clears confirmed empty sales for rank %s after a background refresh', async (rank) => {
		const slug = `wf_test_background_empty_${rank ?? 'bare'}`;
		const suffix = rank == null ? '' : `:r${rank}`;
		const snapshotKey = rank == null ? slug : `${slug}:rank-v3:r${rank}`;
		await seedRankedCatalog([]);
		await env.PRICE_CACHE.put(
			`price:${slug}${suffix}`,
			JSON.stringify({ slug, rank, median: 42, priceBasis: WFM_PRICE_BASIS, timestamp: 1 }),
		);
		await env.PRICE_CACHE.put(
			'snapshot:full:v1',
			JSON.stringify({
				version: 1,
				generatedAt: Date.now(),
				prices: { [snapshotKey]: { status: 'ok', median: 42, priceBasis: WFM_PRICE_BASIS, timestamp: Date.now() } },
				meta: {},
				orderSummaries: {},
			}),
		);
		const upstream = mockWfm(slug, () => statsPayload([]));
		const ctx = createExecutionContext();

		expect((await getOrHydratePrice(env as Env, slug, ctx, rank)).status).toBe('ok');
		await waitOnExecutionContext(ctx);

		expect(await env.PRICE_CACHE.get(`price:${slug}${suffix}`)).toBeNull();
		expect(await env.PRICE_CACHE.get(`miss:price:v3:${slug}${suffix}`)).toBe('1');
		expect(await readSnapshotPrice(snapshotKey)).toMatchObject({ status: 'no_data', median: null, priceBasis: WFM_PRICE_BASIS });
		expect((await getOrHydratePrice(env as Env, slug, undefined, rank)).status).toBe('not_found');
		expect(upstream).toHaveBeenCalledOnce();
	});

	it.each([
		['missing', () => ({ payload: {} })],
		['not_array', () => ({ payload: { statistics_closed: { '48hours': {} } } })],
		['invalid_json', () => new Response('{', { status: 200 })],
		['not_found', () => new Response('missing', { status: 404 })],
		['outage', () => new Response('down', { status: 503 })],
	] as const)('preserves the old price after a %s background response', async (label, response) => {
		const slug = `wf_test_background_bad_${label}`;
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.put(`price:${slug}`, JSON.stringify({ slug, median: 42, priceBasis: WFM_PRICE_BASIS, timestamp: 1 }));
		mockWfm(slug, response);

		await hydrate(slug);

		expect(await readPrice(slug)).toMatchObject({ median: 42 });
		expect(await env.PRICE_CACHE.get(`miss:price:v3:${slug}`)).toBeNull();
	});

	it.each([undefined, 'legacy-median'])('rejects a fresh cache with legacy basis %s and recomputes it', async (priceBasis) => {
		const slug = `wf_test_read_legacy_${priceBasis ? 'tagged' : 'missing'}`;
		await seedRankedCatalog([]);
		await env.PRICE_CACHE.put(`price:${slug}`, JSON.stringify({ slug, median: 999, rank: null, timestamp: Date.now(), priceBasis }));
		await env.PRICE_CACHE.put(`miss:price:v2:${slug}`, '1');
		const upstream = mockWfm(slug, () =>
			statsPayload([
				{ median: 20, volume: 1, minutesAgo: 120 },
				{ median: 40, volume: 3, minutesAgo: 60 },
			]),
		);

		const result = await hydrate(slug);

		expect(result.cacheHit).toBe(false);
		expect(result.data).toMatchObject({ median: 35, priceBasis: WFM_PRICE_BASIS });
		expect(await readPrice(slug)).toMatchObject({ median: 35, priceBasis: WFM_PRICE_BASIS });
		expect(upstream).toHaveBeenCalledOnce();
	});

	it('keeps the rank 0 average when a stale ranked price refreshes on a live read', async () => {
		const slug = 'wf_test_read_stale_ranked_slug';
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.put(
			`price:${slug}`,
			JSON.stringify({ priceBasis: WFM_PRICE_BASIS, slug, median: 50, rank: null, timestamp: Date.now() - 30 * 60 * 60 * 1000 }),
		);
		mockWfm(slug, () =>
			statsPayload([
				{ rank: 0, median: 50, minutesAgo: 120 },
				{ rank: 10, median: 123, minutesAgo: 10 },
			]),
		);

		const result = await hydrate(slug);

		expect(result.status).toBe('ok');
		expect(await readPrice(slug)).toMatchObject({ slug, median: 50, rank: null });
	});

	it('hydrates a missing ranked price from its rank 0 sales', async () => {
		const slug = 'wf_test_read_miss_ranked_slug';
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		mockWfm(slug, () =>
			statsPayload([
				{ rank: 0, median: 50, minutesAgo: 120 },
				{ rank: 10, median: 123, minutesAgo: 10 },
			]),
		);

		const result = await hydrate(slug);

		expect(result.data).toMatchObject({ median: 50 });
		expect(await readPrice(slug)).toMatchObject({ slug, median: 50, rank: null });
	});

	it('uses only unranked or rank 0 sales when the ranked catalog is unavailable', async () => {
		const slug = 'wf_test_read_no_catalog_slug';
		await seedRankedCatalog(null);
		mockWfm(slug, () =>
			statsPayload([
				{ rank: 0, median: 50, minutesAgo: 120 },
				{ rank: 10, median: 123, minutesAgo: 10 },
			]),
		);

		const result = await hydrate(slug);

		expect(result.data).toMatchObject({ median: 50 });
	});

	it('marks no data when a ranked slug has no rank 0 sale', async () => {
		const slug = 'wf_test_read_no_rank0_slug';
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		mockWfm(slug, () => statsPayload([{ rank: 10, median: 123, minutesAgo: 10 }]));

		const result = await hydrate(slug);

		expect(result.status).toBe('not_found');
		expect(await readPrice(slug)).toBeNull();
		expect(await env.PRICE_CACHE.get(`miss:price:v3:${slug}`)).toBe('1');
	});

	it('leaves no negative marker when a ranked read fails transiently', async () => {
		const slug = 'wf_test_read_transient_slug';
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		mockWfm(slug, () => new Response('boom', { status: 503 }));

		const result = await hydrate(slug);

		expect(result.status).toBe('unavailable');
		expect(await env.PRICE_CACHE.get(`miss:price:v3:${slug}`)).toBeNull();
	});

	it('reads the ranked catalog once across back-to-back bare price hydrations', async () => {
		const first = 'wf_test_read_cache_first_slug';
		const second = 'wf_test_read_cache_second_slug';
		await seedRankedCatalog([
			{ slug: first, maxRank: 10 },
			{ slug: second, maxRank: 10 },
		]);
		await env.PRICE_CACHE.delete(`price:${first}`);
		await env.PRICE_CACHE.delete(`price:${second}`);
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (!/\/v1\/items\/[a-z0-9_]+\/statistics$/.test(url)) throw new Error(`Unexpected url: ${url}`);
			return jsonOk(
				statsPayload([
					{ rank: 0, median: 50, minutesAgo: 120 },
					{ rank: 10, median: 123, minutesAgo: 10 },
				]),
			);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const metaGet = vi.spyOn(env.ITEM_META, 'get');

		expect((await hydrate(first)).data).toMatchObject({ median: 50 });
		expect((await hydrate(second)).data).toMatchObject({ median: 50 });

		// Both slugs really hydrated, so the single catalog read is the cache, not a skipped fetch.
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(metaGet.mock.calls.filter(([key]) => key === RANKED_CATALOG_KEY)).toHaveLength(1);
	});

	it('re-reads the ranked catalog after the isolate cache window expires', async () => {
		const slug = 'wf_test_read_cache_expiry_slug';
		await seedRankedCatalog([]);
		await env.PRICE_CACHE.delete(`price:${slug}`);
		mockWfm(slug, () =>
			statsPayload([
				{ rank: 0, median: 50, minutesAgo: 120 },
				{ rank: 10, median: 123, minutesAgo: 10 },
			]),
		);

		// Missing rank metadata must not mix upgraded mod prices into the base price.
		expect((await hydrate(slug)).data).toMatchObject({ median: 50 });

		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.delete(`price:${slug}`);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000);

		expect((await hydrate(slug)).data).toMatchObject({ median: 50 });
	});

	it('negatively caches a permanent ranked read failure without the rank 0 drop', async () => {
		const slug = 'wf_test_read_permanent_slug';
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		mockWfm(slug, () => new Response('nope', { status: 404 }));

		const result = await hydrate(slug);

		expect(result.status).toBe('not_found');
		expect(await env.PRICE_CACHE.get(`miss:price:v3:${slug}`)).toBe('1');
	});
});
