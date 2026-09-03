import { ADVERSARY_VENDORS_DOC_KEY } from '../constants';
import { logEvent } from './logging';
import type { Env } from '../types';
import { getJsonFromKv } from '../utils';
import { toFiniteNumber } from '../../../../config/shared/numeric';

// DE publishes no vendor rotation, so the element and bonus figures are the
// player-reported wiki tables and nothing else.
const CODA_PAGE_URL = 'https://wiki.warframe.com/w/Coda_Weapons?action=raw';
const TENET_PAGE_URL = 'https://wiki.warframe.com/w/Tenet_Weapons?action=raw';
// A spoofed browser user agent is answered with a 403 challenge page; this one passes.
const WIKI_USER_AGENT = 'WFHelper-worker/1.0 (+https://wfhelper.com)';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGE_CHARS = 2 * 1024 * 1024;
const REBUILD_INTERVAL_MS = 60 * 60 * 1000;
const DOC_TTL_SEC = 30 * 24 * 60 * 60;
const MIN_CODA_ROWS = 7;
const MIN_TENET_ROWS = 5;
const MAX_TABLE_ROWS = 40;
const MAX_NAME_LENGTH = 60;
const MAX_ELEMENT_LENGTH = 24;
const MAX_BONUS = 100;

interface VendorItem {
	name: string;
	element: string;
	bonus: number;
}

interface VendorsDoc {
	generatedAt: number;
	source: 'wiki';
	coda: { A: VendorItem[]; B: VendorItem[] };
	tenet: VendorItem[];
}

function collapse(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function stripMarkup(value: string): string {
	return collapse(
		value
			.replace(/<[^>]*>/g, ' ')
			.replace(/\{\{[^{}]*\}\}/g, ' ')
			.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
			.replace(/'{2,}/g, ''),
	);
}

/** Plain text, `{{Weapon|Name}}` and `[[Page|Name]]` all appear in the name column. */
function cellName(cell: string): string {
	const template = /\{\{\s*Weapon\s*\|\s*([^}|]+)/i.exec(cell);
	const name = template ? collapse(template[1]) : stripMarkup(cell);
	return name.slice(0, MAX_NAME_LENGTH);
}

function cellElement(cell: string): string {
	const template = /\{\{\s*D\s*\|\s*([^}|]+)/i.exec(cell);
	const element = template ? collapse(template[1]) : stripMarkup(cell);
	return element.slice(0, MAX_ELEMENT_LENGTH);
}

/** The first number in the cell, whatever colouring template markup wraps it. */
function cellBonus(cell: string): number | null {
	const match = /-?\d+(?:\.\d+)?/.exec(cell);
	const value = match ? toFiniteNumber(match[0]) : null;
	if (value == null || value < 0 || value > MAX_BONUS) return null;
	return Math.round(value * 10) / 10;
}

function tableCells(row: string, tag: 'td' | 'th'): string[] {
	const cells: string[] = [];
	const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
	let match = pattern.exec(row);
	while (match) {
		cells.push(match[1]);
		match = pattern.exec(row);
	}
	return cells;
}

function tableRows(table: string): string[] {
	const rows: string[] = [];
	const pattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
	let match = pattern.exec(table);
	while (match && rows.length < MAX_TABLE_ROWS * 2) {
		rows.push(match[1]);
		match = pattern.exec(table);
	}
	return rows;
}

interface WikiTable {
	header: string[];
	items: VendorItem[];
}

/** Weapon/element/bonus tables only; every other table on the page is ignored. */
function parseTables(wikitext: string): WikiTable[] {
	const tables: WikiTable[] = [];
	const pattern = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
	let match = pattern.exec(wikitext);
	while (match) {
		const rows = tableRows(match[1]);
		match = pattern.exec(wikitext);

		const header = rows.flatMap((row) => tableCells(row, 'th')).map((cell) => stripMarkup(cell).toLowerCase());
		const wanted =
			header.some((cell) => cell.startsWith('weapon')) &&
			header.some((cell) => cell.includes('element')) &&
			header.some((cell) => cell.includes('bonus'));
		if (!wanted) continue;

		const items: VendorItem[] = [];
		const seen = new Set<string>();
		for (const row of rows) {
			const cells = tableCells(row, 'td');
			if (cells.length < 3) continue;
			const name = cellName(cells[0]);
			const element = cellElement(cells[1]);
			const bonus = cellBonus(cells[2]);
			if (!name || !element || bonus == null) continue;
			const key = name.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			items.push({ name, element, bonus });
			if (items.length >= MAX_TABLE_ROWS) break;
		}
		tables.push({ header, items });
	}
	return tables;
}

/** The timers live inside named sections; absent markers fall back to the page. */
function sliceSection(wikitext: string, name: string): string {
	const start = wikitext.indexOf(`<section begin="${name}"`);
	if (start < 0) return wikitext;
	const end = wikitext.indexOf(`<section end="${name}"`, start);
	return end < 0 ? wikitext.slice(start) : wikitext.slice(start, end);
}

export function parseCodaBatches(wikitext: string): { A: VendorItem[]; B: VendorItem[] } | null {
	const tables = parseTables(sliceSection(wikitext, 'eleanor_coda_timer'));
	const batchA = tables.find((table) => table.header.some((cell) => cell.includes('batch a')));
	const batchB = tables.find((table) => table.header.some((cell) => cell.includes('batch b')));
	if (!batchA || !batchB) return null;
	if (batchA.items.length < MIN_CODA_ROWS || batchB.items.length < MIN_CODA_ROWS) return null;
	return { A: batchA.items, B: batchB.items };
}

export function parseTenetMelee(wikitext: string): VendorItem[] | null {
	const tables = parseTables(sliceSection(wikitext, 'glast_tenet_melee_timer'));
	const table = tables.find((entry) => entry.items.length >= MIN_TENET_ROWS);
	return table ? table.items : null;
}

async function fetchWikitext(url: string): Promise<string | null> {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { 'user-agent': WIKI_USER_AGENT, accept: 'text/plain' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch {
		return null;
	}
	if (!response.ok) return null;

	const declared = toFiniteNumber(response.headers.get('content-length'));
	if (declared != null && declared > MAX_PAGE_CHARS) return null;

	try {
		const text = await response.text();
		return text.length > MAX_PAGE_CHARS ? null : text;
	} catch {
		return null;
	}
}

/**
 * Rebuilds the wiki-sourced vendor doc, at most hourly. A failed fetch or a table
 * that no longer parses leaves the stored copy in place; a partial doc is never written.
 */
export async function refreshAdversaryVendors(
	env: Env,
	options: { now?: number; force?: boolean } = {},
): Promise<'built' | 'skipped' | 'failed'> {
	const now = options.now ?? Date.now();
	if (!options.force) {
		const existing = await getJsonFromKv(env.ITEM_META, ADVERSARY_VENDORS_DOC_KEY);
		const generatedAt = toFiniteNumber(existing?.generatedAt) ?? 0;
		if (now - generatedAt < REBUILD_INTERVAL_MS && generatedAt <= now) return 'skipped';
	}

	const [codaPage, tenetPage] = await Promise.all([fetchWikitext(CODA_PAGE_URL), fetchWikitext(TENET_PAGE_URL)]);
	const coda = codaPage ? parseCodaBatches(codaPage) : null;
	const tenet = tenetPage ? parseTenetMelee(tenetPage) : null;
	if (!coda || !tenet) {
		logEvent({
			type: 'cron',
			route: 'adversary-vendors:refresh',
			status: 204,
			error: !codaPage || !tenetPage ? 'wiki_unavailable' : 'wiki_unparsed',
		});
		return 'failed';
	}

	const doc: VendorsDoc = { generatedAt: now, source: 'wiki', coda, tenet };
	const body = JSON.stringify(doc);
	await env.ITEM_META.put(ADVERSARY_VENDORS_DOC_KEY, body, { expirationTtl: DOC_TTL_SEC });
	logEvent({
		type: 'cron',
		route: 'adversary-vendors:refresh',
		status: 200,
		count: coda.A.length + coda.B.length + tenet.length,
		bytes: body.length,
	});
	return 'built';
}

function reviveItems(value: unknown, minimum: number): VendorItem[] | null {
	if (!Array.isArray(value)) return null;
	const items: VendorItem[] = [];
	for (const row of value.slice(0, MAX_TABLE_ROWS)) {
		if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
		const entry = row as Record<string, unknown>;
		const name = typeof entry.name === 'string' ? entry.name.slice(0, MAX_NAME_LENGTH) : '';
		const element = typeof entry.element === 'string' ? entry.element.slice(0, MAX_ELEMENT_LENGTH) : '';
		const bonus = toFiniteNumber(entry.bonus);
		if (!name || !element || bonus == null || bonus < 0 || bonus > MAX_BONUS) continue;
		items.push({ name, element, bonus });
	}
	return items.length >= minimum ? items : null;
}

/** Validated stored doc for the public route; null while nothing has published. */
export async function readAdversaryVendorsDoc(env: Env): Promise<VendorsDoc | null> {
	const stored = await getJsonFromKv(env.ITEM_META, ADVERSARY_VENDORS_DOC_KEY);
	const generatedAt = toFiniteNumber(stored?.generatedAt);
	if (generatedAt == null || generatedAt <= 0) return null;

	const coda = stored?.coda;
	if (!coda || typeof coda !== 'object' || Array.isArray(coda)) return null;
	const batches = coda as Record<string, unknown>;
	const batchA = reviveItems(batches.A, MIN_CODA_ROWS);
	const batchB = reviveItems(batches.B, MIN_CODA_ROWS);
	const tenet = reviveItems(stored?.tenet, MIN_TENET_ROWS);
	if (!batchA || !batchB || !tenet) return null;

	return { generatedAt: Math.floor(generatedAt), source: 'wiki', coda: { A: batchA, B: batchB }, tenet };
}
