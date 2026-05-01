/**
 * Live smoke tests — run against the deployed Worker, NOT Miniflare.
 *
 * Purpose: catch failures that mocked tests fundamentally cannot.
 *   - cron stopped running (stale snapshot.generatedAt)
 *   - prewarm cursor stuck on a subset (per-slug timestamps go stale)
 *   - KV lost data (snapshot entry count collapses)
 *   - upstream WFM outage causing stale data to linger
 *   - auth flow broken (bootstrap token no longer accepted)
 *
 * Thresholds derived from a real snapshot sample on 2026-04-18:
 *   prices:         6760 (floor: 5000)
 *   meta:           3764 (floor: 2500)
 *   orderSummaries: 2996 (floor: 2000)
 *   age p95:        5.2h  (bar: 24h)
 *   age p99:       10.3h  (bar: 36h)
 *   age max:       ~29d   (bar: 45d)
 *   99.9% under 24h       (bar: 95%)
 *
 * Run:     WORKER_URL=https://api.wfhelper.com npm run test:smoke
 * Default: https://api.wfhelper.com  (matches config/shared/backendConfig.ts BACKEND_URL)
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = (process.env.WORKER_URL || 'https://api.wfhelper.com').replace(/\/$/, '');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// ---- thresholds (tune if catalog size shifts materially) ---------------------
const MIN_PRICES = 5_000;
const MIN_META = 2_500;
const MIN_ORDER_SUMMARIES = 2_000;
const MAX_SNAPSHOT_AGE_MS = 4 * HOUR; // cron runs every 5 min; >4h means cron is dead
const MAX_OK_PRICE_AGE_MS = 30 * DAY;
const FRESH_WINDOW_MS = 24 * HOUR;
const FRESH_PCT_MIN = 0.95; // 95% of prices updated in last 24h
const P95_AGE_BAR_MS = 24 * HOUR;
const P99_AGE_BAR_MS = 36 * HOUR;
// -----------------------------------------------------------------------------

interface PriceEntry {
	status?: string;
	median?: number;
	timestamp?: number;
}

interface MetaEntry {
	slug?: string;
	tradable?: boolean;
	timestamp?: number;
}

interface OrderSummaryEntry {
	status?: string;
	wts?: unknown;
	wtb?: unknown;
	timestamp?: number;
}

interface Snapshot {
	version: number;
	generatedAt: number;
	prices: Record<string, PriceEntry>;
	meta: Record<string, MetaEntry>;
	orderSummaries: Record<string, OrderSummaryEntry>;
}

let snapshot: Snapshot;
let snapshotEtag: string | null = null;

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T; headers: Headers }> {
	const res = await fetch(`${BASE_URL}${path}`, init);
	const text = await res.text();
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		throw new Error(`[smoke] ${path} returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`);
	}
	return { status: res.status, body: body as T, headers: res.headers };
}

describe(`worker smoke @ ${BASE_URL}`, () => {
	beforeAll(async () => {
		const res = await fetch(`${BASE_URL}/v1/snapshot`);
		expect(res.status, 'GET /v1/snapshot must return 200').toBe(200);
		snapshotEtag = res.headers.get('etag');
		snapshot = (await res.json()) as Snapshot;
	}, 60_000);

	describe('liveness', () => {
		it('GET /healthz returns ok', async () => {
			const { status, body } = await fetchJson<{ ok: boolean; service: string }>('/healthz');
			expect(status).toBe(200);
			expect(body.ok).toBe(true);
			expect(body.service).toBe('wf-backend-lite');
		});
	});

	describe('snapshot shape', () => {
		it('has expected top-level keys', () => {
			expect(snapshot.version).toBe(1);
			expect(typeof snapshot.generatedAt).toBe('number');
			expect(snapshot.prices).toBeTypeOf('object');
			expect(snapshot.meta).toBeTypeOf('object');
			expect(snapshot.orderSummaries).toBeTypeOf('object');
		});

		it('generatedAt is recent (cron alive)', () => {
			const age = Date.now() - snapshot.generatedAt;
			expect(age, `snapshot is ${(age / HOUR).toFixed(1)}h old — cron may be dead`).toBeLessThan(MAX_SNAPSHOT_AGE_MS);
		});

		it('snapshot entry counts are above minimums', () => {
			const priceCount = Object.keys(snapshot.prices).length;
			const metaCount = Object.keys(snapshot.meta).length;
			const orderCount = Object.keys(snapshot.orderSummaries).length;
			expect(priceCount, `prices=${priceCount}`).toBeGreaterThanOrEqual(MIN_PRICES);
			expect(metaCount, `meta=${metaCount}`).toBeGreaterThanOrEqual(MIN_META);
			expect(orderCount, `orderSummaries=${orderCount}`).toBeGreaterThanOrEqual(MIN_ORDER_SUMMARIES);
		});
	});

	describe('snapshot freshness', () => {
		it('95%+ of prices updated in last 24h (prewarm cycling full catalog)', () => {
			const prices = Object.values(snapshot.prices);
			const now = Date.now();
			const withTs = prices.filter((p) => typeof p.timestamp === 'number');
			const fresh = withTs.filter((p) => now - (p.timestamp as number) < FRESH_WINDOW_MS).length;
			const pct = fresh / withTs.length;
			expect(pct, `only ${(pct * 100).toFixed(1)}% of ${withTs.length} prices fresh within 24h`).toBeGreaterThanOrEqual(FRESH_PCT_MIN);
		});

		it('no ok price entry is older than the inactive-market cutoff', () => {
			const now = Date.now();
			const oldest = Object.entries(snapshot.prices)
				.filter(([, p]) => p.status === 'ok' && typeof p.timestamp === 'number')
				.map(([slug, p]) => ({ slug, age: now - (p.timestamp as number) }))
				.sort((a, b) => b.age - a.age)[0];
			if (!oldest) return;
			expect(oldest.age, `${oldest.slug} is ${(oldest.age / DAY).toFixed(1)}d old — prewarm cursor may be stuck`).toBeLessThan(
				MAX_OK_PRICE_AGE_MS,
			);
		});

		it('p95/p99 age within bounds', () => {
			const now = Date.now();
			const ages = Object.values(snapshot.prices)
				.filter((p) => typeof p.timestamp === 'number')
				.map((p) => now - (p.timestamp as number))
				.sort((a, b) => a - b);
			const p95 = ages[Math.floor(ages.length * 0.95)];
			const p99 = ages[Math.floor(ages.length * 0.99)];
			expect(p95, `p95 age = ${(p95 / HOUR).toFixed(1)}h`).toBeLessThan(P95_AGE_BAR_MS);
			expect(p99, `p99 age = ${(p99 / HOUR).toFixed(1)}h`).toBeLessThan(P99_AGE_BAR_MS);
		});
	});

	// Note on ETag 304 testing: intentionally omitted. The worker's /v1/snapshot
	// checks if-none-match only on edge-cache *miss* (public.ts:200). On typical
	// warm-PoP requests, the `caches.default.match()` at public.ts:179 short-
	// circuits and returns the cached 200 response without consulting the ETag.
	// A smoke test asserting 304 would fail 99% of the time and tell you nothing
	// about operational health. Worker-side fix (if desired): handle if-none-match
	// before the edge-cache lookup, or set Vary: If-None-Match on the cached entry.

	describe('per-slug read path (via bootstrap)', () => {
		let bootstrapToken: string | null = null;
		let bootstrapHeader: string | null = null;

		it('GET /v1/bootstrap issues a token', async () => {
			const { status, body } = await fetchJson<{ ok: boolean; data?: { token: string; header: string; expiresAt: number } }>(
				'/v1/bootstrap',
			);
			// When bootstrap is disabled in deployment, route returns 404 — skip the rest.
			if (status === 404) {
				console.warn('[smoke] bootstrap disabled in deployment; skipping per-slug checks');
				return;
			}
			expect(status).toBe(200);
			expect(body.ok).toBe(true);
			expect(body.data?.token).toBeTruthy();
			expect(body.data?.header).toBeTruthy();
			bootstrapToken = body.data!.token;
			bootstrapHeader = body.data!.header;
		});

		it('per-slug price route rejects missing bootstrap with 401', async () => {
			if (!bootstrapToken) return; // bootstrap not enabled
			const { status, body } = await fetchJson<{ ok: boolean; error?: string }>('/v1/prices/ash_prime_set');
			expect(status).toBe(401);
			expect(body.error).toBe('bootstrap_required');
		});

		it('GET /v1/prices/ash_prime_set with token returns median > 0', async () => {
			if (!bootstrapToken || !bootstrapHeader) return; // bootstrap not enabled
			const { status, body } = await fetchJson<{ ok: boolean; data?: { median: number } }>('/v1/prices/ash_prime_set', {
				headers: { [bootstrapHeader]: bootstrapToken },
			});
			expect(status).toBe(200);
			expect(body.ok).toBe(true);
			expect(body.data?.median).toBeGreaterThan(0);
		});
	});
});
