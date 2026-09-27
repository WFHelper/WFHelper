import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { parseNightwaveOfferings, readNightwaveOfferingsDoc, refreshNightwaveOfferings } from '../src/services/nightwaveOfferings';
import type { Env } from '../src/types';
import { expectEdgeCachedDocRoute } from './edgeCachedRoute';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DOC_KEY = 'nightwave-offerings:doc:v1';
const NOW = Date.parse('2026-09-09T06:35:00.000Z');

const originalFetch = globalThis.fetch;

// Verbatim excerpts of https://wiki.warframe.com/w/Nightwave/Offerings?action=raw.
const AURAS_TAB = `|-|Auras=
=== Auras ({{Nc|20}} each) ===
Names in '''bold''' indicate the item is always available.
<gallery captionalign="center" captionposition="below" hideaddbutton="true" spacing="small" navigation="true" position="center" bordersize="none" bordercolor="transparent">
CorrosiveProjectionMod.png     |link=Corrosive Projection           |'''{{M|Corrosive Projection}}'''
DeadEyeMod.png                 |link=Dead Eye                       |'''{{M|Dead Eye}}'''
Dreamer'sBondMod.png           |link=Dreamer's Bond                 |'''{{M|Dreamer's Bond}}'''
EMPAuraMod.png                 |link=EMP Aura                       |'''{{M|EMP Aura}}'''
</gallery>`;

const WEAPON_SKINS_TAB = `|-|Weapon Skins=
=== Weapon Skin Blueprints===
Names in '''bold''' indicate the item is always available.
<gallery bordercolor="transparent" captionalign="center" hideaddbutton="true" navigation="true" position="center" spacing="small">
AtomosSolsticeSkin.png           |link=Atomos Solstice Skin            |[[Atomos Solstice Skin|'''Atomos Solstice Skin Blueprint''']]<br>{{Nc|35}}
AtteraxDesert-CamoSkin.png       |link=Atterax Desert-Camo Skin        |[[Atterax Desert-Camo Skin|'''Atterax Desert-Camo Skin Blueprint''']]<br>{{Nc|30}}
</gallery>
=== Weapon Skins ===
<gallery bordercolor="transparent" captionalign="center" hideaddbutton="true" navigation="true" position="center" spacing="small">
CedoDaybreakSkin.png             |link=Cedo Daybreak Skin              |'''[[Cedo Daybreak Skin]]'''<br>{{Nc|50}}
</gallery>
=== Sugatra ===
<gallery bordercolor="transparent" captionalign="center" hideaddbutton="true" navigation="true" position="center" spacing="small">
BooleanSugatra.png               |link=Boolean Sugatra                 |[[Boolean Sugatra]]<br>{{Nc|30}}
</gallery>`;

const OTHER_TAB = `|-|Other=

=== Gear Items ===
Names in '''bold''' indicate the item is always available.
<gallery bordercolor="transparent" captionalign="center" hideaddbutton="true" navigation="true" position="center" spacing="small">
WolfBeacon.png                  |link=Wolf Beacon          |'''[[Wolf Beacon]]'''<br>{{Nc|50}}
</gallery>

=== Operator/Drifter Cosmetics ===
<gallery bordercolor="transparent" captionalign="center" hideaddbutton="true" navigation="true" position="center" spacing="small">
WolfHood.png                     |link=Operator/Customization#Head   |[[Operator/Customization#Head|Wolf Hood]] blueprint<br>{{Nc|35}}
DrifterKeelerSuit.png            |link=Operator/Customization        |[[Operator/Customization|Drifter Keeler Suit]]<br>{{Nc|50}}
</gallery>`;

const RECOVERED_TAB = `|-|Recovered Artifacts (Always Available)=
=== Recovered Artifacts (Always Available) ===
<gallery bordercolor="transparent" captionalign="center" hideaddbutton="true" navigation="true" position="center" spacing="small">
NitainExtract.png                    |link=Nitain Extract            |5x [[Nitain Extract]]<br>{{Nc|15}}
Kuva.png                             |link=Kuva                      |10,000x [[Kuva]] <br>{{Nc|50}}
OrokinCatalyst.png                   |link=Orokin Catalyst           |[[Orokin Catalyst]] (built)<br>{{Nc|75}}
Chassis.png                          |link=Vauban                    |{{WF|Vauban}} Chassis Blueprint<br>{{Nc|25}}
Chassis.png                          |link=Vauban                    |{{WF|Vauban}} Chassis Blueprint<br>{{Nc|25}}
NightwaveSkin.png                    |link=Nightwave (Landing Craft) |[[Nightwave (Landing Craft)|Nightwave]] Landing Craft Blueprint<br>{{Nc|35}}

</gallery>`;

/** The parser needs eight tabs and 150 rows before it trusts a page. */
function fillerTab(name: string, count: number): string {
	const rows = Array.from({ length: count }, (_, index) => `Filler.png |link=${name} ${index} |{{M|${name} Item ${index}}}`);
	return [`|-|${name}=`, `=== ${name} ({{Nc|30}} each) ===`, '<gallery spacing="small">', ...rows, '</gallery>'].join('\n');
}

function buildPage(tabs: string[]): string {
	return ['{{DISPLAYTITLE:Nightwave Offerings}}<onlyinclude>', '<div class="tabber-borderless"><tabber>', ...tabs, '</tabber></div>'].join(
		'\n',
	);
}

const FILLER_TABS = ['Weapons', 'Augments', 'Alternate Helmets', 'Decorations', 'Emotes'].map((name) => fillerTab(name, 30));
const OFFERINGS_PAGE = buildPage([AURAS_TAB, WEAPON_SKINS_TAB, OTHER_TAB, RECOVERED_TAB, ...FILLER_TABS]);

beforeEach(async () => {
	(env as unknown as Record<string, string>).PUBLIC_BOOTSTRAP_REQUIRED = '0';
	(env as unknown as Record<string, string>).DAILY_BUDGET_ENABLED = '0';
	(env as unknown as Record<string, string>).PUBLIC_RATE_LIMIT_ENABLED = '0';
	await env.ITEM_META.delete(DOC_KEY);
	await caches.default.delete(new Request('http://example.com/v1/nightwave-offerings?v=1'));
});

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.fetch = originalFetch;
});

function mockWiki(page: string | Response): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (!url.includes('Nightwave/Offerings')) throw new Error(`Unexpected url: ${url}`);
		const agent = new Headers(init?.headers).get('user-agent');
		if (agent !== 'WFHelper-worker/1.0 (+https://wfhelper.com)') throw new Error(`Unexpected user agent: ${agent}`);
		return page instanceof Response ? page : new Response(page, { status: 200, headers: { 'content-type': 'text/plain' } });
	});
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

async function readStoredDoc(): Promise<Record<string, unknown> | null> {
	const raw = await env.ITEM_META.get(DOC_KEY);
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe('nightwave offerings parser', () => {
	it('reads every tab in page order', () => {
		const doc = parseNightwaveOfferings(OFFERINGS_PAGE, NOW);

		expect(doc?.generatedAt).toBe(NOW);
		expect(doc?.source).toBe('wiki');
		expect(doc?.tabs.map((tab) => tab.name)).toEqual([
			'Auras',
			'Weapon Skins',
			'Other',
			'Recovered Artifacts (Always Available)',
			'Weapons',
			'Augments',
			'Alternate Helmets',
			'Decorations',
			'Emotes',
		]);
	});

	it('prices a section once and marks the bolded offers as always available', () => {
		const doc = parseNightwaveOfferings(OFFERINGS_PAGE, NOW);
		const auras = doc?.tabs[0].sections[0];

		expect(auras?.name).toBe('Auras');
		expect(auras?.creds).toBe(20);
		expect(auras?.items).toEqual([
			{ name: 'Corrosive Projection', always: true, creds: 20, quantity: 1 },
			{ name: 'Dead Eye', always: true, creds: 20, quantity: 1 },
			{ name: "Dreamer's Bond", always: true, creds: 20, quantity: 1 },
			{ name: 'EMP Aura', always: true, creds: 20, quantity: 1 },
		]);
	});

	it('takes the per-item price when the section carries none', () => {
		const skins = parseNightwaveOfferings(OFFERINGS_PAGE, NOW)?.tabs[1];

		expect(skins?.sections.map((section) => [section.name, section.creds])).toEqual([
			['Weapon Skin Blueprints', null],
			['Weapon Skins', null],
			['Sugatra', null],
		]);
		expect(skins?.sections[0].items[0]).toEqual({ name: 'Atomos Solstice Skin Blueprint', always: true, creds: 35, quantity: 1 });
		expect(skins?.sections[1].items[0]).toEqual({ name: 'Cedo Daybreak Skin', always: true, creds: 50, quantity: 1 });
		expect(skins?.sections[2].items[0]).toEqual({ name: 'Boolean Sugatra', always: false, creds: 30, quantity: 1 });
	});

	it('unwraps link and template markup and drops a repeat inside one tab', () => {
		const doc = parseNightwaveOfferings(OFFERINGS_PAGE, NOW);

		expect(doc?.tabs[2].sections[1].items).toEqual([
			{ name: 'Wolf Hood blueprint', always: false, creds: 35, quantity: 1 },
			{ name: 'Drifter Keeler Suit', always: false, creds: 50, quantity: 1 },
		]);
		expect(doc?.tabs[3].sections[0].items).toEqual([
			{ name: '5x Nitain Extract', always: true, creds: 15, quantity: 5 },
			{ name: '10,000x Kuva', always: true, creds: 50, quantity: 10000 },
			{ name: 'Orokin Catalyst (built)', always: true, creds: 75, quantity: 1 },
			{ name: 'Vauban Chassis Blueprint', always: true, creds: 25, quantity: 1 },
			{ name: 'Nightwave Landing Craft Blueprint', always: true, creds: 35, quantity: 1 },
		]);
	});

	it('refuses a page that lost tabs or rows', () => {
		expect(parseNightwaveOfferings(buildPage([AURAS_TAB, WEAPON_SKINS_TAB, OTHER_TAB, RECOVERED_TAB]), NOW)).toBeNull();
		expect(
			parseNightwaveOfferings(buildPage(['Auras', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name) => fillerTab(name, 2))), NOW),
		).toBeNull();
		expect(parseNightwaveOfferings('', NOW)).toBeNull();
	});
});

describe('nightwave offerings refresh', () => {
	it('stores the doc, then rebuilds at most hourly', async () => {
		const fetchMock = mockWiki(OFFERINGS_PAGE);

		expect(await refreshNightwaveOfferings(env as unknown as Env, { now: NOW })).toBe('built');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const stored = await readStoredDoc();
		expect(stored).toMatchObject({ generatedAt: NOW, source: 'wiki' });
		expect((stored?.tabs as unknown[]).length).toBe(9);

		expect(await refreshNightwaveOfferings(env as unknown as Env, { now: NOW + 60_000 })).toBe('skipped');
		expect(fetchMock).toHaveBeenCalledTimes(1);

		expect(await refreshNightwaveOfferings(env as unknown as Env, { now: NOW + 3_600_001 })).toBe('built');
		expect((await readStoredDoc())?.generatedAt).toBe(NOW + 3_600_001);
	});

	it('keeps the last good copy when the wiki fails or stops parsing', async () => {
		mockWiki(OFFERINGS_PAGE);
		await refreshNightwaveOfferings(env as unknown as Env, { now: NOW });

		mockWiki(new Response('Please wait', { status: 403 }));
		expect(await refreshNightwaveOfferings(env as unknown as Env, { now: NOW + 3_600_001 })).toBe('failed');
		expect((await readStoredDoc())?.generatedAt).toBe(NOW);

		mockWiki(buildPage([AURAS_TAB]));
		expect(await refreshNightwaveOfferings(env as unknown as Env, { now: NOW + 7_200_002 })).toBe('failed');
		expect((await readStoredDoc())?.generatedAt).toBe(NOW);
	});

	it('recovers bundle quantities from legacy stored documents', async () => {
		const doc = parseNightwaveOfferings(OFFERINGS_PAGE, NOW);
		await env.ITEM_META.put(
			DOC_KEY,
			JSON.stringify(doc, (key, value: unknown) => (key === 'quantity' ? undefined : value)),
		);
		const restored = await readNightwaveOfferingsDoc(env as unknown as Env);
		expect(restored?.tabs[3].sections[0].items.slice(0, 2).map((item) => item.quantity)).toEqual([5, 10000]);
	});

	it('refuses a stored doc that lost tabs', async () => {
		await env.ITEM_META.put(
			DOC_KEY,
			JSON.stringify({
				generatedAt: NOW,
				source: 'wiki',
				tabs: [
					{ name: 'Auras', sections: [{ name: 'Auras', creds: 20, items: [{ name: 'Dead Eye', always: true, creds: 20, quantity: 1 }] }] },
				],
			}),
		);

		expect(await readNightwaveOfferingsDoc(env as unknown as Env)).toBeNull();
	});
});

describe('GET /v1/nightwave-offerings', () => {
	async function publish(): Promise<void> {
		mockWiki(OFFERINGS_PAGE);
		await refreshNightwaveOfferings(env as unknown as Env, { now: NOW });
		globalThis.fetch = originalFetch;
	}

	it('answers 404 with JSON before the first refresh publishes', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('http://example.com/v1/nightwave-offerings'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toMatchObject({ ok: false, error: 'nightwave_offerings_not_ready' });
	});

	it('serves the tabs with edge caching and revalidates on the ETag', async () => {
		await publish();

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('http://example.com/v1/nightwave-offerings'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
		const etag = response.headers.get('etag');
		expect(etag).toBeTruthy();
		const body = (await response.json()) as {
			tabs: Array<{ name: string; sections: Array<{ name: string; creds: number | null; items: Array<{ name: string }> }> }>;
		};
		expect(body).toMatchObject({ ok: true, generatedAt: NOW, source: 'wiki' });
		expect(body.tabs).toHaveLength(9);
		expect(body.tabs[0].sections[0]).toMatchObject({ name: 'Auras', creds: 20 });

		const matchingCtx = createExecutionContext();
		const matching = await worker.fetch(
			new IncomingRequest('http://example.com/v1/nightwave-offerings', { headers: { 'if-none-match': etag ?? '' } }),
			env,
			matchingCtx,
		);
		await waitOnExecutionContext(matchingCtx);
		expect(matching.status).toBe(304);
		expect(await matching.text()).toBe('');
	});

	it('keeps CORS, ETags and 304s on fresh and edge-cached answers', async () => {
		await publish();

		await expectEdgeCachedDocRoute('/v1/nightwave-offerings', 'http://example.com/v1/nightwave-offerings?v=1', DOC_KEY);
	});

	it('rejects a malformed stored doc rather than serving it', async () => {
		await env.ITEM_META.put(DOC_KEY, JSON.stringify({ generatedAt: NOW, source: 'wiki', tabs: 'nope' }));

		const ctx = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest('http://example.com/v1/nightwave-offerings'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
	});
});
