import {
	ARCHIVE_BARO_PREFIX,
	ARCHIVE_INDEX_PREFIX,
	ARCHIVE_PRICES_PREFIX,
	ARCHIVE_RIVENS_PREFIX,
	RIVEN_ARCHIVE_SWEEP_KEY,
	RIVEN_ARCHIVE_WEAPONS_KEY,
	SNAPSHOT_KEY,
} from '../constants';
import { getWorkerConfig } from '../config';
import { logEvent } from './logging';
import type { Env } from '../types';
import { clamp, getJsonFromKv } from '../utils';
import { sanitizeWfmSlug } from '../../../../config/shared/textNormalize';
import { WFM_HEADERS } from '../../../../config/shared/wfm';

const DAY_SEC = 24 * 60 * 60;
// Far below KV's 25MB per-value limit: an archive this large means the rows are
// wrong, so the write is refused instead of silently storing garbage.
export const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 4096;
// Pruning drops one entry a day in steady state and the TTL reclaims the rest.
const MAX_INDEX_DELETES_PER_RUN = 8;
const MAX_PRICE_ROWS = 50000;
const MAX_RIVEN_WEAPONS = 1000;
const MAX_RIVEN_AUCTIONS = 1000;
const MAX_BARO_ROWS = 500;
const RIVEN_WEAPON_LIST_TTL_MS = 24 * 60 * 60 * 1000;
const WORLD_STATE_URL = 'https://api.warframe.com/cdn/worldState.php';
// DE serves a few MB; anything far past that is not the world state we parse.
const MAX_WORLD_STATE_BYTES = 32 * 1024 * 1024;

type ArchiveFamily = 'prices' | 'rivens' | 'baro';

type PriceRow = [string, number] | [string, number, number];
type RivenRow = [string, number, number, number];
type BaroRow = [string, number, number];

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
	status: 'written' | 'exists' | 'inactive' | 'unavailable' | 'too_large' | 'disabled' | 'error';
	visitId: string | null;
	rows: number;
	bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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

function utcDate(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as unknown;
		return isRecord(value) ? value : null;
	} catch {
		return null;
	}
}

export function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
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

async function readArchiveIndex(env: Env, family: ArchiveFamily): Promise<string[]> {
	const stored = await getJsonFromKv(env.ITEM_META, indexKey(family));
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

export async function recordArchiveEntries(env: Env, family: ArchiveFamily, ids: string[], maxEntries: number): Promise<void> {
	const entries = await readArchiveIndex(env, family);
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

	await env.ITEM_META.put(indexKey(family), JSON.stringify({ v: 1, updatedAt: Date.now(), entries }));

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
 * Writes one dated median archive from the snapshot the worker already holds.
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
			return { ...base, status: 'exists', bytes: byteLength(existing) };
		}

		const rows = priceRowsFromSnapshot(await getJsonFromKv(env.PRICE_CACHE, SNAPSHOT_KEY));
		if (rows.length === 0) {
			// An empty or unreadable snapshot says nothing about the day's prices.
			logEvent({ type: 'cron', route: 'archive:prices', status: 204, error: 'snapshot_unavailable' });
			return { ...base, status: 'no_source' };
		}

		const body = JSON.stringify({
			v: 1,
			date,
			generatedAt: now,
			source: 'snapshot',
			columns: ['key', 'median', 'volume'],
			rows,
		});
		const bytes = byteLength(body);
		if (bytes > MAX_ARCHIVE_BYTES) {
			logEvent({ type: 'error', route: 'archive:prices', status: 500, bytes, error: 'archive_too_large' });
			return { ...base, status: 'too_large', rows: rows.length, bytes };
		}

		await env.ITEM_META.put(key, body, { expirationTtl: retentionTtlSec(env) });
		await recordArchiveEntry(env, 'prices', date, config.historyRetentionDays);
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

function storedPriceRows(value: Record<string, unknown> | null): PriceRow[] {
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

// A backfilled day expires on the retention window measured from its own date, so
// touching an old day cannot extend it past the bound the live archive keeps.
function dayRetentionTtlSec(date: string, now: number, retentionDays: number): number {
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
	for (const date of [...byDate.keys()].sort()) {
		const samples = byDate.get(date);
		if (!samples || samples.size === 0) continue;

		const key = `${ARCHIVE_PRICES_PREFIX}${date}`;
		const existingRaw = await env.ITEM_META.get(key);
		if (!existingRaw && date >= today) continue;

		const existing = parseJsonRecord(existingRaw);
		const rows = storedPriceRows(existing);
		const rowIndex = new Map<string, number>();
		rows.forEach((row, index) => {
			if (!rowIndex.has(row[0])) rowIndex.set(row[0], index);
		});

		let filled = 0;
		let added = 0;
		for (const [slug, sample] of samples) {
			const at = rowIndex.get(slug);
			if (at == null) {
				if (rows.length >= MAX_PRICE_ROWS) continue;
				rowIndex.set(slug, rows.length);
				rows.push([slug, sample.median, sample.volume]);
				added += 1;
				continue;
			}
			const row = rows[at];
			if (row.length > 2) continue;
			rows[at] = [row[0], row[1], sample.volume];
			filled += 1;
		}
		if (filled === 0 && added === 0) continue;

		const body = JSON.stringify({
			v: 1,
			date,
			generatedAt: numeric(existing?.generatedAt) ?? now,
			source: typeof existing?.source === 'string' ? existing.source : 'wfm-statistics-volume',
			columns: ['key', 'median', 'volume'],
			rows,
		});
		const bytes = byteLength(body);
		if (bytes > MAX_ARCHIVE_BYTES) {
			logEvent({ type: 'error', route: 'archive:prices', status: 500, bytes, error: 'archive_too_large' });
			continue;
		}

		await env.ITEM_META.put(key, body, { expirationTtl: dayRetentionTtlSec(date, now, config.historyRetentionDays) });
		result.dates.push(date);
		result.filled += filled;
		result.added += added;
		if (!existingRaw) result.created.push(date);
	}

	if (result.created.length > 0) await recordArchiveEntries(env, 'prices', result.created, config.historyRetentionDays);
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

// VoidTraders is Baro. PrimeVaultTraders is Varzia and is deliberately not read here.
function voidTraderEntries(payload: unknown): Record<string, unknown>[] {
	if (!isRecord(payload)) return [];
	const raw = payload.VoidTraders;
	const list = Array.isArray(raw) ? raw : isRecord(raw) ? [raw] : [];
	return list.filter(isRecord).slice(0, 8);
}

interface BaroVisit {
	visitId: string;
	node: string;
	activation: number;
	expiry: number;
	rows: BaroRow[];
}

function visitIdOf(entry: Record<string, unknown>, activation: number): string {
	const id = isRecord(entry._id) ? entry._id.$oid : entry._id;
	if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) return id;
	return `d${activation}`;
}

function manifestRows(manifest: unknown[]): BaroRow[] {
	const rows: BaroRow[] = [];
	for (const item of manifest) {
		if (!isRecord(item)) continue;
		const uniqueName = typeof item.ItemType === 'string' ? item.ItemType.trim().slice(0, 200) : '';
		if (!uniqueName) continue;
		rows.push([uniqueName, numeric(item.PrimePrice) ?? 0, numeric(item.RegularPrice) ?? 0]);
		if (rows.length >= MAX_BARO_ROWS) break;
	}
	return rows;
}

/** Only a live visit is recorded; an announced manifest can still change before activation. */
function activeBaroVisit(payload: unknown, now: number): BaroVisit | null {
	for (const entry of voidTraderEntries(payload)) {
		const manifest = Array.isArray(entry.Manifest) ? entry.Manifest : [];
		if (manifest.length === 0) continue;
		const activation = deDateMs(entry.Activation);
		const expiry = deDateMs(entry.Expiry);
		if (activation == null || expiry == null) continue;
		if (now < activation || now >= expiry) continue;

		const rows = manifestRows(manifest);
		if (rows.length === 0) continue;
		return {
			visitId: visitIdOf(entry, activation),
			node: typeof entry.Node === 'string' ? entry.Node.slice(0, 64) : '',
			activation,
			expiry,
			rows,
		};
	}
	return null;
}

/** null once the body passes the cap: content-length is absent on a chunked response,
 *  so the only real bound is the number of bytes actually read. */
async function readCappedText(response: Response, maxBytes: number): Promise<string | null> {
	const stream = response.body;
	if (!stream || typeof stream.getReader !== 'function') return null;
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} catch {
		return null;
	}

	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

async function fetchWorldState(): Promise<unknown | null> {
	let response: Response;
	try {
		response = await fetch(WORLD_STATE_URL, { headers: { accept: 'application/json' } });
	} catch {
		return null;
	}
	if (!response.ok) return null;
	if ((numeric(response.headers.get('content-length')) ?? 0) > MAX_WORLD_STATE_BYTES) return null;

	const text = await readCappedText(response, MAX_WORLD_STATE_BYTES);
	if (text == null) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

/**
 * Records the running Baro visit once. Daily checks catch every visit because a
 * visit stays live for about 48 hours.
 */
export async function archiveBaroVisit(env: Env, options: { now?: number } = {}): Promise<BaroArchiveResult> {
	const now = options.now ?? Date.now();
	const config = getWorkerConfig(env);
	const base: BaroArchiveResult = { status: 'disabled', visitId: null, rows: 0, bytes: 0 };
	if (!config.historyArchiveEnabled) return base;

	try {
		const payload = await fetchWorldState();
		if (payload == null) {
			logEvent({ type: 'cron', route: 'archive:baro', status: 204, error: 'world_state_unavailable' });
			return { ...base, status: 'unavailable' };
		}

		const visit = activeBaroVisit(payload, now);
		if (!visit) return { ...base, status: 'inactive' };

		const key = `${ARCHIVE_BARO_PREFIX}${visit.visitId}`;
		const existing = await env.ITEM_META.get(key);
		if (existing) {
			return { ...base, status: 'exists', visitId: visit.visitId, bytes: byteLength(existing) };
		}

		const body = JSON.stringify({
			v: 1,
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

		await env.ITEM_META.put(key, body, { expirationTtl: retentionTtlSec(env) });
		await recordArchiveEntry(env, 'baro', visit.visitId, baroIndexBound(config.historyRetentionDays));

		logEvent({ type: 'cron', route: 'archive:baro', status: 200, count: visit.rows.length, bytes });
		return { status: 'written', visitId: visit.visitId, rows: visit.rows.length, bytes };
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
