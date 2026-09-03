import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { parseCodaBatches, parseTenetMelee, readAdversaryVendorsDoc, refreshAdversaryVendors } from '../src/services/adversaryVendors';
import type { Env } from '../src/types';
import { codaBatchAt } from '../../../config/shared/vendorRotation';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DOC_KEY = 'adversary-vendors:doc:v1';
// Batch B is active at this instant; a player confirmed it in game.
const NOW = Date.parse('2026-09-03T06:35:00.000Z');

const originalFetch = globalThis.fetch;

// Verbatim excerpts of the wiki source, whitespace included.
const CODA_PAGE = `<section begin="eleanor_coda_timer" />
{{Countdown
| date            = March 18, 2025 00:00:00 UTC
| looptime        = 8D
| looplimit       = -1
| delaytime       = 4D
}}
{{#vardefine:RotatingRewardsIndexNormal|{{#expr: floor ((({{#time: U | now }} - {{#time: U | 2025-03-18 }}) mod (86400 * 8)) / (86400 * 4))}}}}
{{#ifeq: {{#var:RotatingRewardsIndexNormal}} | 0 |
<table class="wikitable" style="text-align: center; margin: auto;">
    <tr>
        <th>Weapon (Batch A)</th>
        <th>Element</th>
        <th>Bonus %</th>
    </tr>
    <tr><td>Coda Catabolyst</td><td>{{D|Radiation}}</td><td>{{ValenceBonusPercentageColor|30.5}}</td></tr>
    <tr><td>Coda Hema</td><td>{{D|Magnetic}}</td><td>{{ValenceBonusPercentageColor|28.9}}</td></tr>
    <tr><td>Coda Mire</td><td>{{D|Cold}}</td><td>{{ValenceBonusPercentageColor|25.2}}</td></tr>
    <tr><td>Coda Motovore</td><td>{{D|Impact}}</td><td>{{ValenceBonusPercentageColor|34.9}}</td></tr>
    <tr><td>Coda Pox</td><td>{{D|Magnetic}}</td><td>{{ValenceBonusPercentageColor|29.6}}</td></tr>
    <tr><td>Coda Sporothrix</td><td>{{D|Electricity}}</td><td>{{ValenceBonusPercentageColor|25.7}}</td></tr>
    <tr><td>Dual Coda Torxica</td><td>{{D|Magnetic}}</td><td>{{ValenceBonusPercentageColor|25.3}}</td></tr>
</table>
|
<table class="wikitable" style="text-align: center; margin: auto;">
    <tr>
        <th>Weapon (Batch B)</th>
        <th>Element</th>
        <th>Bonus %</th>
    </tr>
    <tr><td>Coda Bassocyst</td><td>{{D|Magnetic}}</td><td>{{ValenceBonusPercentageColor|25.5}}</td></tr>
    <tr><td>Coda Bubonico</td><td>{{D|Toxin}}</td><td>{{ValenceBonusPercentageColor|43.7}}</td></tr>
    <tr><td>Coda Caustacyst</td><td>{{D|Cold}}</td><td>{{ValenceBonusPercentageColor|26.2}}</td></tr>
    <tr><td>Coda Hirudo</td><td>{{D|Toxin}}</td><td>{{ValenceBonusPercentageColor|37.2}}</td></tr>
    <tr><td>Coda Pathocyst</td><td>{{D|Toxin}}</td><td>{{ValenceBonusPercentageColor|29.5}}</td></tr>
    <tr><td>Coda Synapse</td><td>{{D|Magnetic}}</td><td>{{ValenceBonusPercentageColor|25.4}}</td></tr>
    <tr><td>Coda Tysis</td><td>{{D|Impact}}</td><td>{{ValenceBonusPercentageColor|27.4}}</td></tr>
</table>
}}
<section end="eleanor_coda_timer" />`;

const TENET_PAGE = `<section begin="glast_tenet_melee_timer" />
{{Countdown
| date            = December 3, 2015 00:00:00 UTC
| looptime        = 4D
| looplimit       = -1
}}
<table class="wikitable" style="text-align: center; margin: auto;">
    <tr>
        <th>Weapon</th>
        <th>Element</th>
        <th>Bonus %</th>
    </tr>
    <tr><td>{{Weapon|Tenet Ferrox}}</td><td>{{D|Radiation}}</td><td>{{ValenceBonusPercentageColor|25.0}}</td></tr>
    <tr><td>{{Weapon|Tenet Grigori}}</td><td>{{D|Radiation}}</td><td>{{ValenceBonusPercentageColor|36.0}}</td></tr>
    <tr><td>{{Weapon|Tenet Livia}}</td><td>{{D|Heat}}</td><td>{{ValenceBonusPercentageColor|42.1}}</td></tr>
    <tr><td>{{Weapon|Tenet Exec}}</td><td> {{D|Toxin}}</td><td>{{ValenceBonusPercentageColor|32.3}}</td></tr>
    <tr><td>{{Weapon|Tenet Agendus}}</td><td> {{D|Impact}}</td><td>{{ValenceBonusPercentageColor|25.1}}</td></tr>
</table>
<section end="glast_tenet_melee_timer" />`;

beforeEach(async () => {
	(env as unknown as Record<string, string>).PUBLIC_BOOTSTRAP_REQUIRED = '0';
	(env as unknown as Record<string, string>).DAILY_BUDGET_ENABLED = '0';
	(env as unknown as Record<string, string>).PUBLIC_RATE_LIMIT_ENABLED = '0';
	await env.ITEM_META.delete(DOC_KEY);
	await clearEdgeCache();
});

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.fetch = originalFetch;
});

async function clearEdgeCache(): Promise<void> {
	await caches.default.delete(new Request('http://example.com/v1/adversary-vendors?v=1&b=A'));
	await caches.default.delete(new Request('http://example.com/v1/adversary-vendors?v=1&b=B'));
}

function mockWiki(pages: Record<string, string | Response>): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const page = url.includes('Coda_Weapons') ? 'coda' : url.includes('Tenet_Weapons') ? 'tenet' : '';
		const result = pages[page];
		if (result === undefined) throw new Error(`Unexpected url: ${url}`);
		const agent = new Headers(init?.headers).get('user-agent');
		if (agent !== 'WFHelper-worker/1.0 (+https://wfhelper.com)') throw new Error(`Unexpected user agent: ${agent}`);
		return result instanceof Response ? result : new Response(result, { status: 200, headers: { 'content-type': 'text/plain' } });
	});
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

async function readDoc(): Promise<Record<string, unknown> | null> {
	const raw = await env.ITEM_META.get(DOC_KEY);
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe('wiki vendor table parser', () => {
	it('reads both coda batches with their elements and bonuses', () => {
		const batches = parseCodaBatches(CODA_PAGE);

		expect(batches?.A).toHaveLength(7);
		expect(batches?.A[0]).toEqual({ name: 'Coda Catabolyst', element: 'Radiation', bonus: 30.5 });
		expect(batches?.A[6]).toEqual({ name: 'Dual Coda Torxica', element: 'Magnetic', bonus: 25.3 });
		expect(batches?.B.map((item) => item.name)).toEqual([
			'Coda Bassocyst',
			'Coda Bubonico',
			'Coda Caustacyst',
			'Coda Hirudo',
			'Coda Pathocyst',
			'Coda Synapse',
			'Coda Tysis',
		]);
		expect(batches?.B[1]).toEqual({ name: 'Coda Bubonico', element: 'Toxin', bonus: 43.7 });
	});

	it('unwraps the weapon template and tolerates padded cells', () => {
		const items = parseTenetMelee(TENET_PAGE);

		expect(items).toEqual([
			{ name: 'Tenet Ferrox', element: 'Radiation', bonus: 25 },
			{ name: 'Tenet Grigori', element: 'Radiation', bonus: 36 },
			{ name: 'Tenet Livia', element: 'Heat', bonus: 42.1 },
			{ name: 'Tenet Exec', element: 'Toxin', bonus: 32.3 },
			{ name: 'Tenet Agendus', element: 'Impact', bonus: 25.1 },
		]);
	});

	it('ignores tables that are not the weapon grid', () => {
		const page = `<table class="wikitable"><tr><th>Weapon</th><th>Damage</th></tr><tr><td>Tenet Livia</td><td>100</td></tr></table>${TENET_PAGE}`;

		expect(parseTenetMelee(page)).toHaveLength(5);
	});

	it('rejects a table that lost rows or a bonus figure', () => {
		const shortTenet = TENET_PAGE.replace(/<tr><td>\{\{Weapon\|Tenet Agendus\}\}[\s\S]*?<\/tr>\n/, '');
		expect(parseTenetMelee(shortTenet)).toBeNull();

		const brokenBonus = TENET_PAGE.replace('{{ValenceBonusPercentageColor|42.1}}', '{{ValenceBonusPercentageColor|unknown}}');
		expect(parseTenetMelee(brokenBonus)).toBeNull();

		const missingBatch = CODA_PAGE.replace('Weapon (Batch B)', 'Weapon (Legacy)');
		expect(parseCodaBatches(missingBatch)).toBeNull();
	});

	it('follows the wiki 8-day formula for the active batch', () => {
		expect(codaBatchAt(NOW)).toBe('B');
		expect(codaBatchAt(Date.parse('2026-09-01T00:00:00.000Z'))).toBe('B');
		expect(codaBatchAt(Date.parse('2026-08-31T23:59:00.000Z'))).toBe('A');
		expect(codaBatchAt(Date.parse('2026-08-28T00:00:00.000Z'))).toBe('A');
	});
});

describe('adversary vendor refresh', () => {
	it('stores both batches and the tenet stock, then rebuilds at most hourly', async () => {
		const fetchMock = mockWiki({ coda: CODA_PAGE, tenet: TENET_PAGE });

		expect(await refreshAdversaryVendors(env as unknown as Env, { now: NOW })).toBe('built');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const stored = await readDoc();
		expect(stored).toMatchObject({ generatedAt: NOW, source: 'wiki' });
		expect((stored?.coda as Record<string, unknown[]>).A).toHaveLength(7);
		expect(stored?.tenet as unknown[]).toHaveLength(5);

		expect(await refreshAdversaryVendors(env as unknown as Env, { now: NOW + 60_000 })).toBe('skipped');
		expect(fetchMock).toHaveBeenCalledTimes(2);

		expect(await refreshAdversaryVendors(env as unknown as Env, { now: NOW + 3_600_001 })).toBe('built');
		expect((await readDoc())?.generatedAt).toBe(NOW + 3_600_001);
	});

	it('keeps the last good copy when the wiki fails or stops parsing', async () => {
		mockWiki({ coda: CODA_PAGE, tenet: TENET_PAGE });
		await refreshAdversaryVendors(env as unknown as Env, { now: NOW });

		mockWiki({ coda: new Response('Please wait', { status: 403 }), tenet: TENET_PAGE });
		expect(await refreshAdversaryVendors(env as unknown as Env, { now: NOW + 3_600_001 })).toBe('failed');
		expect((await readDoc())?.generatedAt).toBe(NOW);

		mockWiki({ coda: CODA_PAGE, tenet: '<table><tr><th>Weapon</th><th>Element</th><th>Bonus %</th></tr></table>' });
		expect(await refreshAdversaryVendors(env as unknown as Env, { now: NOW + 7_200_002 })).toBe('failed');
		expect((await readDoc())?.generatedAt).toBe(NOW);
	});

	it('refuses a stored doc that lost rows', async () => {
		await env.ITEM_META.put(
			DOC_KEY,
			JSON.stringify({
				generatedAt: NOW,
				source: 'wiki',
				coda: { A: [{ name: 'Coda Hema', element: 'Magnetic', bonus: 28.9 }], B: [] },
				tenet: [],
			}),
		);

		expect(await readAdversaryVendorsDoc(env as unknown as Env)).toBeNull();
	});
});

describe('GET /v1/adversary-vendors', () => {
	async function publish(): Promise<void> {
		mockWiki({ coda: CODA_PAGE, tenet: TENET_PAGE });
		await refreshAdversaryVendors(env as unknown as Env, { now: NOW });
		globalThis.fetch = originalFetch;
	}

	it('answers 404 with JSON before the first refresh publishes', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('http://example.com/v1/adversary-vendors'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ ok: false, error: 'adversary_vendors_not_ready' });
	});

	it('serves the active batch, the next one and the tenet stock with edge caching', async () => {
		await publish();
		vi.spyOn(Date, 'now').mockReturnValue(NOW);

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('http://example.com/v1/adversary-vendors'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
		const etag = response.headers.get('etag');
		expect(etag).toBeTruthy();
		const body = (await response.json()) as {
			coda: { batch: string; items: Array<{ name: string }> };
			codaNext: { batch: string; items: Array<{ name: string }> };
			tenet: { items: Array<{ name: string; bonus: number }> };
		};
		expect(body).toMatchObject({ ok: true, generatedAt: NOW, source: 'wiki' });
		expect(body.coda.batch).toBe('B');
		expect(body.coda.items[0]).toEqual({ name: 'Coda Bassocyst', element: 'Magnetic', bonus: 25.5 });
		expect(body.codaNext.batch).toBe('A');
		expect(body.codaNext.items[0].name).toBe('Coda Catabolyst');
		expect(body.tenet.items).toHaveLength(5);

		const matchingCtx = createExecutionContext();
		const matching = await worker.fetch(
			new IncomingRequest('http://example.com/v1/adversary-vendors', { headers: { 'if-none-match': etag ?? '' } }),
			env,
			matchingCtx,
		);
		await waitOnExecutionContext(matchingCtx);
		expect(matching.status).toBe(304);
		expect(await matching.text()).toBe('');
	});

	it('switches batches on the rotation boundary', async () => {
		await publish();
		vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-31T23:59:00.000Z'));

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('http://example.com/v1/adversary-vendors'), env, ctx);
		await waitOnExecutionContext(ctx);

		const body = (await response.json()) as { coda: { batch: string; items: Array<{ name: string }> } };
		expect(body.coda.batch).toBe('A');
		expect(body.coda.items.map((item) => item.name)).toContain('Coda Catabolyst');
	});

	it('rejects a malformed stored doc rather than serving it', async () => {
		await env.ITEM_META.put(DOC_KEY, JSON.stringify({ generatedAt: NOW, source: 'wiki', coda: { A: [], B: [] }, tenet: [] }));

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('http://example.com/v1/adversary-vendors'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
	});
});
