import {
	ARCHIVE_BARO_PREFIX,
	MAX_ARCHIVE_BYTES,
	ARCHIVE_INDEX_PREFIX,
	ARCHIVE_PRICES_PREFIX,
	ARCHIVE_RIVENS_PREFIX,
	BARO_WINDOW_KEY,
	RIVEN_ARCHIVE_SWEEP_KEY,
	RIVEN_ARCHIVE_WEAPONS_KEY,
	SNAPSHOT_KEY,
} from '../constants';
import { getWorkerConfig } from '../config';
import { logEvent } from './logging';
import { byteLength, parseJsonRecord, isRecord, utcDate } from '../utils';
import type { Env } from '../types';
import { clamp, getJsonFromKv } from '../utils';
import { sanitizeWfmSlug } from '../../../../config/shared/textNormalize';
import { WFM_HEADERS } from '../../../../config/shared/wfm';
import { withAbortTimeout } from '../../../../config/shared/fetchWithTimeout';
import { baroVisitId, migrateBaroHistory } from './baroHistory';
import { storeItemPath } from '../../../../config/shared/itemPath';
import { readResponseText } from '../../../../config/shared/readResponseText';

const DAY_SEC = 24 * 60 * 60;
const MAX_INDEX_ENTRIES = 4096;
// Pruning drops one entry a day in steady state and the TTL reclaims the rest.
const MAX_INDEX_DELETES_PER_RUN = 8;
export const MAX_PRICE_ROWS = 50000;
export const DAILY_MEDIAN_BASIS = 'closed-daily-median-v1';
const MAX_RIVEN_WEAPONS = 1000;
const MAX_RIVEN_AUCTIONS = 1000;
const MAX_BARO_ROWS = 500;
const RIVEN_WEAPON_LIST_TTL_MS = 24 * 60 * 60 * 1000;
const WORLD_STATE_URL = 'https://api.warframe.com/cdn/worldState.php';
const WARFRAMESTAT_VOID_TRADER_URL = 'https://api.warframestat.us/pc/voidTrader?language=en';
const BARO_UA = 'WFHelper-worker/1.0 (+https://wfhelper.com)';
// DE serves a few MB; anything far past that is not the world state we parse.
const MAX_WORLD_STATE_BYTES = 32 * 1024 * 1024;

type ArchiveFamily = 'prices' | 'rivens' | 'baro';

export type PriceRow = [string, number] | [string, number, number];
type RivenRow = [string, number, number, number];
type BaroRow = [string, number | null, number | null];

interface PriceArchiveResult {
	status: 'written' | 'exists' | 'no_source' | 'too_large' | 'disabled' | 'error';
	date: string;
	rows: number;
	bytes: number;
}

interface RivenSweepResult {
	status: 'progress' | 'complete' | 'idle' | 'no_weapons' | 'no_data' | 'too_large' | 'disabled' | 'error';
	date: string;
	weapons: number;
	cursorBefore: number;
	cursorAfter: number;
	processed: number;
	updated: number;
	failures: number;
	rows: number;
	bytes: number;
}

interface BaroArchiveResult {
	status: 'written' | 'exists' | 'inactive' | 'unavailable' | 'too_large' | 'disabled' | 'idle' | 'error';
	visitId: string | null;
	rows: number;
	bytes: number;
}

function numeric(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value !== 'string' || !value.trim()) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: unknown): number | null {
	const parsed = numeric(value);
	return parsed != null && parsed > 0 ? parsed : null;
}

function archivePrefix(family: ArchiveFamily): string {
	if (family === 'prices') return ARCHIVE_PRICES_PREFIX;
	if (family === 'rivens') return ARCHIVE_RIVENS_PREFIX;
	return ARCHIVE_BARO_PREFIX;
}

function indexKey(family: ArchiveFamily): string {
	return `${ARCHIVE_INDEX_PREFIX}${family}:v1`;
}

function retentionTtlSec(env: Env): number {
	return getWorkerConfig(env).historyRetentionDays * DAY_SEC;
}

// Baro visits roughly every two weeks, so the visit index is bounded in visits
// rather than days; the TTL still expires each key on the retention window.
function baroIndexBound(retentionDays: number): number {
	return clamp(Math.ceil(retentionDays / 14) + 4, 8, MAX_INDEX_ENTRIES);
}

function archiveIndexEntries(stored: Record<string, unknown> | null): string[] {
	const raw = stored?.entries;
	if (!Array.isArray(raw)) return [];

	const entries: string[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		const value = typeof entry === 'string' ? entry.trim() : '';
		if (!value || value.length > 64 || seen.has(value)) continue;
		seen.add(value);
		entries.push(value);
		if (entries.length >= MAX_INDEX_ENTRIES) break;
	}
	return entries;
}

export async function readPriceArchiveRevisions(env: Env): Promise<Record<string, string>> {
	const stored = await getJsonFromKv(env.ITEM_META, indexKey('prices'));
	const revisions = isRecord(stored?.revisions) ? stored.revisions : {};
	return Object.fromEntries(
		archiveIndexEntries(stored).map((date) => [date, typeof revisions[date] === 'string' ? revisions[date] : 'legacy']),
	);
}

export async function recordArchiveEntries(
	env: Env,
	family: ArchiveFamily,
	ids: string[],
	maxEntries: number,
	changed: Record<string, string> = {},
): Promise<void> {
	const stored = await getJsonFromKv(env.ITEM_META, indexKey(family));
	const entries = archiveIndexEntries(stored);
	const known = new Set(entries);
	for (const id of ids) {
		if (!id || known.has(id)) continue;
		known.add(id);
		entries.push(id);
	}
	// Date ids sort chronologically as strings, and pruning drops from the front. The
	// price seed appends days older than the live ones, so the sort keeps that true.
	if (family !== 'baro') entries.sort();
	const overflow = Math.max(0, entries.length - maxEntries);
	const pruned = overflow > 0 ? entries.splice(0, overflow) : [];

	const revisions =
		family === 'prices'
			? Object.fromEntries(
					entries.map((id) => [id, changed[id] ?? (isRecord(stored?.revisions) ? stored.revisions[id] : undefined) ?? 'legacy']),
				)
			: undefined;
	if (
		family === 'prices' &&
		JSON.stringify(entries) === JSON.stringify(archiveIndexEntries(stored)) &&
		entries.every((id) => revisions?.[id] === (isRecord(stored?.revisions) ? stored.revisions[id] : 'legacy'))
	)
		return;
	await env.ITEM_META.put(indexKey(family), JSON.stringify({ v: 1, updatedAt: Date.now(), entries, revisions }));

	for (const stale of pruned.slice(0, MAX_INDEX_DELETES_PER_RUN)) {
		try {
			await env.ITEM_META.delete(`${archivePrefix(family)}${stale}`);
		} catch {
			// Best effort: the archive TTL removes anything a failed delete leaves behind.
		}
	}
}

async function recordArchiveEntry(env: Env, family: ArchiveFamily, id: string, maxEntries: number): Promise<void> {
	await recordArchiveEntries(env, family, [id], maxEntries);
}

function priceRowsFromSnapshot(snapshot: Record<string, unknown> | null): PriceRow[] {
	const prices = snapshot?.prices;
	if (!isRecord(prices)) return [];

	const rows: PriceRow[] = [];
	for (const [key, value] of Object.entries(prices)) {
		if (!isRecord(value) || !key || key.length > 256) continue;
		const median = numeric(value.median);
		if (median == null) continue;
		// Snapshot entries carry no volume; the top-traded sweep merges it in later.
		rows.push([key, median]);
		if (rows.length >= MAX_PRICE_ROWS) break;
	}
	return rows;
}

/**
 * Keeps the snapshot's price basis; legacy untagged rows remain untagged.
 * First write of a UTC day wins, so a retried cron never rewrites the day.
 */
export async function archiveDailyPrices(env: Env, options: { now?: number } = {}): Promise<PriceArchiveResult> {
	const now = options.now ?? Date.now();
	const date = utcDate(now);
	const config = getWorkerConfig(env);
	const base: PriceArchiveResult = { status: 'disabled', date, rows: 0, bytes: 0 };
	if (!config.historyArchiveEnabled) return base;

	try {
		const key = `${ARCHIVE_PRICES_PREFIX}${date}`;
		const existing = await env.ITEM_META.get(key);
		if (existing) {
			const day = parseJsonRecord(existing);
			if (Array.isArray(day?.rows))
				await recordArchiveEntries(env, 'prices', [date], config.historyRetentionDays, {
					[date]: typeof day.revision === 'string' ? day.revision : 'legacy',
				});
			return { ...base, status: 'exists', bytes: byteLength(existing) };
		}

		const snapshot = await getJsonFromKv(env.PRICE_CACHE, SNAPSHOT_KEY);
		const rows = priceRowsFromSnapshot(snapshot);
		if (rows.length === 0) {
			// An empty or unreadable snapshot says nothing about the day's prices.
			logEvent({ type: 'cron', route: 'archive:prices', status: 204, error: 'snapshot_unavailable' });
			return { ...base, status: 'no_source' };
		}

		const priceBasisByKey: Record<string, string> = Object.create(null);
		const prices = isRecord(snapshot?.prices) ? snapshot.prices : {};
		for (const [key] of rows) {
			const price = prices[key];
			if (isRecord(price) && typeof price.priceBasis === 'string' && price.priceBasis.length <= 128 && price.priceBasis)
				priceBasisByKey[key] = price.priceBasis;
		}
		const revision = crypto.randomUUID();
		const body = JSON.stringify({
			v: 1,
			date,
			revision,
			generatedAt: now,
			source: 'snapshot',
			columns: ['key', 'median', 'volume'],
			priceBasisByKey,
			rows,
		});
		const bytes = byteLength(body);
		if (bytes > MAX_ARCHIVE_BYTES) {
			logEvent({ type: 'error', route: 'archive:prices', status: 500, bytes, error: 'archive_too_large' });
			return { ...base, status: 'too_large', rows: rows.length, bytes };
		}

		await env.ITEM_META.put(key, body, { expirationTtl: retentionTtlSec(env) });
		await recordArchiveEntries(env, 'prices', [date], config.historyRetentionDays, { [date]: revision });
		logEvent({ type: 'cron', route: 'archive:prices', status: 200, count: rows.length, bytes });
		return { ...base, status: 'written', rows: rows.length, bytes };
	} catch (err) {
		logEvent({
			type: 'error',
			route: 'archive:prices',
			status: 500,
			error: err instanceof Error ? err.message : 'unknown_error',
		});
		return { ...base, status: 'error' };
	}
}

export interface VolumeSample {
	median: number;
	volume: number;
}

interface MergeVolumesResult {
	dates: string[];
	created: string[];
	/** Existing rows that gained the volume they lacked. */
	filled: number;
	/** Rows the day did not hold at all. */
	added: number;
}

/** Rows of a stored day archive, dropping anything that is not a `[key, median, volume?]`. */
export function storedPriceRows(value: Record<string, unknown> | null): PriceRow[] {
	const rows: PriceRow[] = [];
	if (!Array.isArray(value?.rows)) return rows;

	for (const row of value.rows) {
		if (!Array.isArray(row) || row.length < 2) continue;
		const key = typeof row[0] === 'string' ? row[0] : '';
		const median = numeric(row[1]);
		if (!key || median == null) continue;
		const volume = row.length > 2 ? numeric(row[2]) : null;
		rows.push(volume == null ? [key, median] : [key, median, volume]);
		if (rows.length >= MAX_PRICE_ROWS) break;
	}
	return rows;
}

export function storedPriceMetadata(value: Record<string, unknown> | null): {
	priceBasisByKey: Record<string, string>;
	dailyMedians: Record<string, number>;
} {
	const priceBasisByKey: Record<string, string> = Object.create(null);
	const dailyMedians: Record<string, number> = Object.create(null);
	const bases = isRecord(value?.priceBasisByKey) ? value.priceBasisByKey : {};
	const medians = isRecord(value?.dailyMedians) ? value.dailyMedians : {};
	for (const [key, basis] of Object.entries(bases).slice(0, MAX_PRICE_ROWS)) {
		if (key && key.length <= 256 && typeof basis === 'string' && basis && basis.length <= 128) priceBasisByKey[key] = basis;
	}
	for (const [key, value] of Object.entries(medians).slice(0, MAX_PRICE_ROWS)) {
		const median = positive(value);
		if (key && key.length <= 256 && median !== null) dailyMedians[key] = median;
	}
	return { priceBasisByKey, dailyMedians };
}

// A backfilled day expires on the retention window measured from its own date, so
// touching an old day cannot extend it past the bound the live archive keeps.
export function dayRetentionTtlSec(date: string, now: number, retentionDays: number): number {
	const ageSec = Math.max(0, Math.floor((now - Date.parse(`${date}T00:00:00.000Z`)) / 1000));
	return Math.max(DAY_SEC, retentionDays * DAY_SEC - ageSec);
}

/** Adds sales volume to dated price rows without replacing a stored median or
 *  volume; the current UTC day is never created because the daily archive owns
 *  a day's first write and would skip it. */
export async function mergeVolumes(
	env: Env,
	byDate: Map<string, Map<string, VolumeSample>>,
	options: { now?: number } = {},
): Promise<MergeVolumesResult> {
	const now = options.now ?? Date.now();
	const config = getWorkerConfig(env);
	const result: MergeVolumesResult = { dates: [], created: [], filled: 0, added: 0 };
	if (!config.historyArchiveEnabled) return result;

	const today = utcDate(now);
	const revisions: Record<string, string> = {};
	for (const date of [...byDate.keys()].sort()) {
		const samples = byDate.get(date);
		if (!samples || samples.size === 0) continue;

		const key = `${ARCHIVE_PRICES_PREFIX}${date}`;
		const existingRaw = await env.ITEM_META.get(key);
		if (!existingRaw && date >= today) continue;

		const existing = parseJsonRecord(existingRaw);
		const rows = storedPriceRows(existing);
		const metadata = storedPriceMetadata(existing);
		const rowIndex = new Map<string, number>();
		rows.forEach((row, index) => {
			if (!rowIndex.has(row[0])) rowIndex.set(row[0], index);
		});

		let filled = 0;
		let added = 0;
		let priced = 0;
		for (const [slug, sample] of samples) {
			const at = rowIndex.get(slug);
			if (at == null) {
				if (rows.length >= MAX_PRICE_ROWS) continue;
				rowIndex.set(slug, rows.length);
				rows.push([slug, sample.median, sample.volume]);
				metadata.priceBasisByKey[slug] = DAILY_MEDIAN_BASIS;
				added += 1;
				continue;
			}
			const row = rows[at];
			const basis = metadata.priceBasisByKey[slug];
			// A rolling average cannot stand in for the completed day's median.
			if (basis && basis !== DAILY_MEDIAN_BASIS && metadata.dailyMedians[slug] === undefined) {
				metadata.dailyMedians[slug] = sample.median;
				priced += 1;
			}
			if (row.length > 2) continue;
			rows[at] = [row[0], row[1], sample.volume];
			filled += 1;
		}
		if (filled === 0 && added === 0 && priced === 0) {
			if (Array.isArray(existing?.rows)) {
				result.dates.push(date);
				revisions[date] = typeof existing.revision === 'string' ? existing.revision : 'legacy';
			}
			continue;
		}

		const revision = crypto.randomUUID();
		const body = JSON.stringify({
			v: 1,
			date,
			revision,
			generatedAt: numeric(existing?.generatedAt) ?? now,
			source: typeof existing?.source === 'string' ? existing.source : 'wfm-statistics-volume',
			columns: ['key', 'median', 'volume'],
			...metadata,
			rows,
		});
		const bytes = byteLength(body);
		if (bytes > MAX_ARCHIVE_BYTES) {
			logEvent({ type: 'error', route: 'archive:prices', status: 500, bytes, error: 'archive_too_large' });
			continue;
		}

		await env.ITEM_META.put(key, body, { expirationTtl: dayRetentionTtlSec(date, now, config.historyRetentionDays) });
		result.dates.push(date);
		revisions[date] = revision;
		result.filled += filled;
		result.added += added;
		if (!existingRaw) result.created.push(date);
	}

	if (result.dates.length > 0) await recordArchiveEntries(env, 'prices', result.dates, config.historyRetentionDays, revisions);
	return result;
}

function weaponListRows(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	if (!isRecord(payload)) return [];
	if (isRecord(payload.payload) && Array.isArray(payload.payload.items)) return payload.payload.items;
	if (Array.isArray(payload.data)) return payload.data;
	if (Array.isArray(payload.items)) return payload.items;
	return [];
}

function sanitizeWeaponSlugs(values: unknown[]): string[] {
	const slugs: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const slug = sanitizeWfmSlug(value);
		if (!slug || seen.has(slug)) continue;
		seen.add(slug);
		slugs.push(slug);
		if (slugs.length >= MAX_RIVEN_WEAPONS) break;
	}
	return slugs;
}

function parseWeaponSlugs(payload: unknown): string[] {
	const names: unknown[] = [];
	for (const row of weaponListRows(payload)) {
		if (!isRecord(row)) continue;
		names.push(row.url_name ?? row.urlName ?? row.slug);
	}
	return sanitizeWeaponSlugs(names);
}

async function fetchRivenWeaponList(): Promise<string[]> {
	let response: Response;
	try {
		response = await fetch('https://api.warframe.market/v2/riven/weapons', { headers: WFM_HEADERS });
	} catch {
		return [];
	}
	if (!response.ok) return [];

	try {
		return parseWeaponSlugs(await response.json());
	} catch {
		return [];
	}
}

/** Cached weapon list; an empty upstream answer keeps the stored one. */
async function loadRivenWeapons(env: Env, now: number): Promise<string[]> {
	const stored = await getJsonFromKv(env.ITEM_META, RIVEN_ARCHIVE_WEAPONS_KEY);
	const cached = sanitizeWeaponSlugs(Array.isArray(stored?.weapons) ? (stored.weapons as unknown[]) : []);
	const updatedAt = numeric(stored?.updatedAt) ?? 0;
	if (cached.length > 0 && now - updatedAt < RIVEN_WEAPON_LIST_TTL_MS) return cached;

	const fetched = await fetchRivenWeaponList();
	if (fetched.length === 0) return cached;

	await env.ITEM_META.put(RIVEN_ARCHIVE_WEAPONS_KEY, JSON.stringify({ updatedAt: now, weapons: fetched }));
	return fetched;
}

function auctionRows(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	if (!isRecord(payload)) return [];
	if (isRecord(payload.payload) && Array.isArray(payload.payload.auctions)) return payload.payload.auctions;
	if (Array.isArray(payload.data)) return payload.data;
	return [];
}

function auctionPrices(payload: unknown): number[] {
	const prices: number[] = [];
	for (const row of auctionRows(payload)) {
		if (!isRecord(row)) continue;
		if (row.closed === true || row.visible === false) continue;
		const price = positive(row.buyout_price) ?? positive(row.buyoutPrice) ?? positive(row.starting_price) ?? positive(row.startingPrice);
		if (price == null) continue;
		prices.push(price);
		if (prices.length >= MAX_RIVEN_AUCTIONS) break;
	}
	return prices;
}

function medianOf(sorted: number[]): number {
	const mid = sorted.length >> 1;
	const value = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	return Math.round(value * 10) / 10;
}

// Auctions carry no sales volume, so the sample count is the only depth signal.
async function fetchRivenAggregate(weapon: string): Promise<{ row: RivenRow | null; failed: boolean }> {
	const url = `https://api.warframe.market/v1/auctions/search?type=riven&weapon_url_name=${encodeURIComponent(weapon)}&sort_by=price_asc`;
	let response: Response;
	try {
		response = await fetch(url, { headers: WFM_HEADERS });
	} catch {
		return { row: null, failed: true };
	}
	if (!response.ok) return { row: null, failed: true };

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return { row: null, failed: true };
	}

	const prices = auctionPrices(payload);
	if (prices.length === 0) return { row: null, failed: false };
	prices.sort((a, b) => a - b);
	return { row: [weapon, prices[0], medianOf(prices), prices.length], failed: false };
}

interface RivenSweepState {
	date: string;
	cursor: number;
	complete: boolean;
	/** The list this day's cursor indexes; empty means it was never pinned. */
	weapons: string[];
}

function parseSweepState(value: Record<string, unknown> | null): RivenSweepState | null {
	if (!value) return null;
	const date = typeof value.date === 'string' ? value.date : '';
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
	const cursor = numeric(value.cursor);
	return {
		date,
		cursor: cursor != null && cursor > 0 ? Math.floor(cursor) : 0,
		complete: value.complete === true,
		weapons: sanitizeWeaponSlugs(Array.isArray(value.weapons) ? (value.weapons as unknown[]) : []),
	};
}

function parseRivenRows(value: Record<string, unknown> | null): Map<string, RivenRow> {
	const rows = new Map<string, RivenRow>();
	if (!Array.isArray(value?.rows)) return rows;

	for (const row of value.rows) {
		if (!Array.isArray(row) || row.length < 4) continue;
		const weapon = typeof row[0] === 'string' ? row[0] : '';
		const min = numeric(row[1]);
		const median = numeric(row[2]);
		const sample = numeric(row[3]);
		if (!weapon || min == null || median == null || sample == null) continue;
		rows.set(weapon, [weapon, min, median, Math.floor(sample)]);
		if (rows.size >= MAX_RIVEN_WEAPONS) break;
	}
	return rows;
}

/**
 * One batch of the daily riven sweep. About 250 weapons cannot fit in a single
 * invocation, so the cursor walks the list across 15-minute ticks.
 */
export async function sweepRivenArchive(env: Env, options: { now?: number; batchSize?: number } = {}): Promise<RivenSweepResult> {
	const now = options.now ?? Date.now();
	const date = utcDate(now);
	const config = getWorkerConfig(env);
	const base: RivenSweepResult = {
		status: 'disabled',
		date,
		weapons: 0,
		cursorBefore: 0,
		cursorAfter: 0,
		processed: 0,
		updated: 0,
		failures: 0,
		rows: 0,
		bytes: 0,
	};
	if (!config.historyArchiveEnabled) return base;

	try {
		const state = parseSweepState(await getJsonFromKv(env.ITEM_META, RIVEN_ARCHIVE_SWEEP_KEY));
		const sameDay = state != null && state.date === date;
		if (sameDay && state.complete) return { ...base, status: 'idle' };

		// The list is pinned for the sweep day: loadRivenWeapons refreshes after 24h and
		// a list that shifts mid-sweep would move weapons past the cursor unvisited.
		const pinned = sameDay && state.weapons.length > 0;
		const weapons = pinned ? state.weapons : await loadRivenWeapons(env, now);
		if (weapons.length === 0) {
			logEvent({ type: 'cron', route: 'archive:rivens', status: 204, error: 'weapon_list_unavailable' });
			return { ...base, status: 'no_weapons' };
		}

		const batchSize = clamp(options.batchSize ?? config.rivenArchiveBatchSize, 1, 60);
		// An unpinned same-day state predates the pin, so its cursor indexes an unknown list.
		const cursorBefore = pinned ? Math.min(state.cursor, weapons.length) : 0;
		const cursorAfter = Math.min(cursorBefore + batchSize, weapons.length);
		const complete = cursorAfter >= weapons.length;

		const key = `${ARCHIVE_RIVENS_PREFIX}${date}`;
		const existingRaw = await env.ITEM_META.get(key);
		const existing = parseJsonRecord(existingRaw);
		const rows = parseRivenRows(existing);

		const result: RivenSweepResult = {
			...base,
			status: complete ? 'complete' : 'progress',
			weapons: weapons.length,
			cursorBefore,
			cursorAfter,
		};

		// Serialized like the prewarm sweep: one upstream request at a time, never a burst.
		for (let index = cursorBefore; index < cursorAfter; index += 1) {
			const weapon = weapons[index];
			const { row, failed } = await fetchRivenAggregate(weapon);
			result.processed += 1;
			if (failed) {
				result.failures += 1;
				continue;
			}
			if (row) {
				rows.set(weapon, row);
				result.updated += 1;
			}
		}

		await env.ITEM_META.put(
			RIVEN_ARCHIVE_SWEEP_KEY,
			JSON.stringify({ date, cursor: cursorAfter, complete, weapons: complete ? [] : weapons, updatedAt: now }),
		);

		if (rows.size === 0) {
			// Nothing answered yet, so there is no day key to write and none to overwrite.
			logEvent({ type: 'cron', route: 'archive:rivens', status: 204, count: 0, error: 'no_aggregates' });
			return { ...result, status: 'no_data' };
		}

		const body = JSON.stringify({
			v: 1,
			date,
			complete,
			generatedAt: numeric(existing?.generatedAt) ?? now,
			updatedAt: now,
			weapons: weapons.length,
			columns: ['weapon', 'min', 'median', 'sample'],
			rows: [...rows.values()],
		});
		const bytes = byteLength(body);
		if (bytes > MAX_ARCHIVE_BYTES) {
			logEvent({ type: 'error', route: 'archive:rivens', status: 500, bytes, error: 'archive_too_large' });
			return { ...result, status: 'too_large', rows: rows.size, bytes };
		}

		await env.ITEM_META.put(key, body, { expirationTtl: retentionTtlSec(env) });
		if (!existingRaw) await recordArchiveEntry(env, 'rivens', date, config.historyRetentionDays);

		logEvent({
			type: 'cron',
			route: 'archive:rivens',
			status: 200,
			count: rows.size,
			bytes,
		});
		return { ...result, rows: rows.size, bytes };
	} catch (err) {
		logEvent({
			type: 'error',
			route: 'archive:rivens',
			status: 500,
			error: err instanceof Error ? err.message : 'unknown_error',
		});
		return { ...base, status: 'error' };
	}
}

function deDateMs(value: unknown): number | null {
	if (!isRecord(value)) return null;
	const date = value.$date;
	if (isRecord(date)) return numeric(date.$numberLong);
	return numeric(date);
}

function isoMs(value: unknown): number | null {
	const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

interface TraderItem {
	path: unknown;
	ducats: unknown;
	credits: unknown;
}

interface TraderEntry {
	node: unknown;
	activation: number | null;
	expiry: number | null;
	items: TraderItem[];
}

interface BaroWindow {
	activation: number;
	expiry: number;
}

// VoidTraders is Baro. PrimeVaultTraders is Varzia and is deliberately not read here.
function deTraderEntries(payload: unknown): TraderEntry[] | null {
	if (!isRecord(payload)) return null;
	const raw = payload.VoidTraders;
	const list = Array.isArray(raw) ? raw : isRecord(raw) ? [raw] : [];
	return list
		.filter(isRecord)
		.slice(0, 8)
		.map((entry) => ({
			node: entry.Node,
			activation: deDateMs(entry.Activation),
			expiry: deDateMs(entry.Expiry),
			items: (Array.isArray(entry.Manifest) ? entry.Manifest : [])
				.filter(isRecord)
				.map((item) => ({ path: item.ItemType, ducats: item.PrimePrice, credits: item.RegularPrice })),
		}));
}

// warframestat.us parses the same VoidTraders block: uniqueName is the raw ItemType, dates are
// ISO strings and location is a display name, not the DE node. No window means no answer.
function mirrorTraderEntries(payload: unknown): TraderEntry[] | null {
	const list = Array.isArray(payload) ? payload : [payload];
	const entries = list
		.filter(isRecord)
		.slice(0, 8)
		.map((entry) => ({
			node: entry.location,
			activation: isoMs(entry.activation),
			expiry: isoMs(entry.expiry),
			items: (Array.isArray(entry.inventory) ? entry.inventory : [])
				.filter(isRecord)
				.map((item) => ({ path: item.uniqueName, ducats: item.ducats, credits: item.credits })),
		}))
		.filter((entry) => entry.activation !== null && entry.expiry !== null);
	return entries.length > 0 ? entries : null;
}

interface BaroSource {
	name: string;
	url: string;
	traders: (payload: unknown) => TraderEntry[] | null;
}

// Measured from Cloudflare since at least 2026-09-04: api.warframe.com answers 403 with an empty
// body whatever the request headers, while the mirror answers. DE stays as the fallback.
const BARO_SOURCES: readonly BaroSource[] = [
	{ name: 'warframestat', url: WARFRAMESTAT_VOID_TRADER_URL, traders: mirrorTraderEntries },
	{ name: 'de', url: WORLD_STATE_URL, traders: deTraderEntries },
];

function validWindow(activation: number | null, expiry: number | null): BaroWindow | null {
	if (activation == null || expiry == null) return null;
	if (!Number.isSafeInteger(activation) || !Number.isSafeInteger(expiry) || activation <= 0 || expiry > 8.64e15 || expiry <= activation)
		return null;
	return { activation, expiry };
}

function liveWindow(window: BaroWindow | null, now: number): BaroWindow | null {
	return window && now >= window.activation && now < window.expiry ? window : null;
}

interface BaroVisit {
	visitId: string;
	node: string;
	activation: number;
	expiry: number;
	rows: BaroRow[];
}

function manifestRows(items: TraderItem[]): BaroRow[] {
	const rows: BaroRow[] = [];
	const seen = new Set<string>();
	const cost = (value: unknown): number | null => {
		const parsed = numeric(value);
		return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
	};
	for (const item of items) {
		const uniqueName = storeItemPath(typeof item.path === 'string' ? item.path.trim() : '');
		if (!uniqueName.startsWith('/Lotus/') || uniqueName.length > 512 || uniqueName.includes('BaroTreasureBox') || seen.has(uniqueName))
			continue;
		seen.add(uniqueName);
		rows.push([uniqueName, cost(item.ducats), cost(item.credits)]);
		if (rows.length >= MAX_BARO_ROWS) break;
	}
	return rows;
}

/** Only a live visit is recorded; an announced manifest can still change before activation. */
function activeBaroVisit(entries: TraderEntry[], now: number): BaroVisit | null {
	for (const entry of entries) {
		if (entry.items.length === 0) continue;
		const window = liveWindow(validWindow(entry.activation, entry.expiry), now);
		if (!window) continue;

		const rows = manifestRows(entry.items);
		if (rows.length === 0) continue;
		return {
			visitId: baroVisitId(window.activation),
			node: typeof entry.node === 'string' ? entry.node.slice(0, 64) : '',
			activation: window.activation,
			expiry: window.expiry,
			rows,
		};
	}
	return null;
}

type SourceAnswer = { payload: unknown } | { status: number; error: string };

async function fetchSource(url: string): Promise<SourceAnswer> {
	try {
		return await withAbortTimeout(15_000, async (signal): Promise<SourceAnswer> => {
			const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': BARO_UA }, signal });
			if (!response.ok) return { status: response.status, error: 'baro_source_http_error' };
			if ((numeric(response.headers.get('content-length')) ?? 0) > MAX_WORLD_STATE_BYTES) {
				return { status: 502, error: 'baro_source_too_large' };
			}
			const text = await readResponseText(response, MAX_WORLD_STATE_BYTES);
			return { payload: JSON.parse(text) as unknown };
		});
	} catch {
		return { status: 502, error: 'baro_source_unreadable' };
	}
}

function hasLiveWindow(entries: TraderEntry[], now: number): boolean {
	return entries.some((entry) => liveWindow(validWindow(entry.activation, entry.expiry), now) !== null);
}

async function fetchBaroTraders(now: number): Promise<TraderEntry[] | null> {
	let answered: TraderEntry[] | null = null;
	for (const source of BARO_SOURCES) {
		const answer = await fetchSource(source.url);
		const traders = 'payload' in answer ? source.traders(answer.payload) : null;
		if (traders && (!hasLiveWindow(traders, now) || activeBaroVisit(traders, now))) return traders;
		answered ??= traders;
		const failure = !('payload' in answer)
			? answer
			: { status: 502, error: traders ? 'baro_source_empty_manifest' : 'baro_source_unrecognized' };
		logEvent({ type: 'error', route: 'archive:baro', status: failure.status, source: source.name, error: failure.error });
	}
	return answered;
}

function parseBaroWindow(value: Record<string, unknown> | null): BaroWindow | null {
	return value ? validWindow(numeric(value.activation), numeric(value.expiry)) : null;
}

/**
 * The current or next visit, so the quarter-hour retry knows when to fetch without fetching, and
 * once `recorded` names its archive the retry skips reading that archive too.
 */
async function rememberBaroWindow(env: Env, entries: TraderEntry[], now: number, recordedId?: string): Promise<void> {
	let next: BaroWindow | null = null;
	for (const entry of entries) {
		const window = validWindow(entry.activation, entry.expiry);
		if (window && window.expiry > now && (!next || window.activation < next.activation)) next = window;
	}
	if (!next) return;
	try {
		const raw = await getJsonFromKv(env.ITEM_META, BARO_WINDOW_KEY);
		const stored = parseBaroWindow(raw);
		const same = stored?.activation === next.activation && stored.expiry === next.expiry;
		const storedRecorded = same && typeof raw?.recorded === 'string' ? raw.recorded : undefined;
		const recorded = recordedId === baroVisitId(next.activation) ? recordedId : storedRecorded;
		if (same && recorded === storedRecorded) return;
		const body = { v: 1, activation: next.activation, expiry: next.expiry, ...(recorded ? { recorded } : {}), updatedAt: now };
		await env.ITEM_META.put(BARO_WINDOW_KEY, JSON.stringify(body));
	} catch (err) {
		logEvent({ type: 'error', route: 'archive:baro', status: 500, error: err instanceof Error ? err.message : 'unknown_error' });
	}
}

/** DE does not publish past manifests, so persist the live visit before reconciliation. */
export async function archiveBaroVisit(env: Env, options: { now?: number; retry?: boolean } = {}): Promise<BaroArchiveResult> {
	const now = options.now ?? Date.now();
	const config = getWorkerConfig(env);
	const base: BaroArchiveResult = { status: 'disabled', visitId: null, rows: 0, bytes: 0 };
	if (!config.historyArchiveEnabled) return base;

	try {
		const traders = await fetchBaroTraders(now);
		if (traders == null) {
			if (!options.retry) await migrateBaroHistory(env, now);
			return { ...base, status: 'unavailable' };
		}
		await rememberBaroWindow(env, traders, now);

		const visit = activeBaroVisit(traders, now);
		if (!visit) {
			if (!options.retry) await migrateBaroHistory(env, now);
			return { ...base, status: 'inactive' };
		}

		const key = `${ARCHIVE_BARO_PREFIX}${visit.visitId}`;
		const existing = await env.ITEM_META.get(key);

		const body = JSON.stringify({
			v: 2,
			visitId: visit.visitId,
			node: visit.node,
			activation: new Date(visit.activation).toISOString(),
			expiry: new Date(visit.expiry).toISOString(),
			recordedAt: now,
			columns: ['item', 'ducats', 'credits'],
			rows: visit.rows,
		});
		const bytes = byteLength(body);
		if (bytes > MAX_ARCHIVE_BYTES) {
			logEvent({ type: 'error', route: 'archive:baro', status: 500, bytes, error: 'archive_too_large' });
			return { ...base, status: 'too_large', visitId: visit.visitId, rows: visit.rows.length, bytes };
		}

		if (!existing) await env.ITEM_META.put(key, body, { expirationTtl: retentionTtlSec(env) });
		// Last-seen data must survive before the bounded archive index can prune visits.
		await migrateBaroHistory(env, now, {
			id: visit.visitId,
			activation: visit.activation,
			expiry: visit.expiry,
			node: visit.node,
			items: visit.rows.map(([uniqueName, ducats, credits]) => ({ uniqueName, ducats, credits })),
		});
		await recordArchiveEntry(env, 'baro', visit.visitId, baroIndexBound(config.historyRetentionDays));
		await rememberBaroWindow(env, traders, now, visit.visitId);

		logEvent({ type: 'cron', route: 'archive:baro', status: 200, count: visit.rows.length, bytes });
		return { status: existing ? 'exists' : 'written', visitId: visit.visitId, rows: visit.rows.length, bytes };
	} catch (err) {
		logEvent({
			type: 'error',
			route: 'archive:baro',
			status: 500,
			error: err instanceof Error ? err.message : 'unknown_error',
		});
		return { ...base, status: 'error' };
	}
}

/** Quarter-hour retry: fetches only while the remembered visit is live and its archive is missing. */
export async function retryBaroVisit(env: Env, options: { now?: number } = {}): Promise<BaroArchiveResult> {
	const now = options.now ?? Date.now();
	const idle: BaroArchiveResult = { status: 'idle', visitId: null, rows: 0, bytes: 0 };
	if (!getWorkerConfig(env).historyArchiveEnabled) return { ...idle, status: 'disabled' };
	const stored = await getJsonFromKv(env.ITEM_META, BARO_WINDOW_KEY);
	const window = liveWindow(parseBaroWindow(stored), now);
	if (!window) return idle;
	const visitId = baroVisitId(window.activation);
	if (stored?.recorded === visitId) return idle;
	if ((await env.ITEM_META.get(`${ARCHIVE_BARO_PREFIX}${visitId}`)) !== null) return idle;
	return archiveBaroVisit(env, { now, retry: true });
}
