import { ARCHIVE_PRICES_PREFIX, TOP_TRADED_DOC_KEY, TOP_TRADED_SWEEP_KEY } from '../constants';
import { getWorkerConfig } from '../config';
import { byteLength, mergeVolumes, type VolumeSample } from './history';
import { logEvent } from './logging';
import { barePriceFetchRank, fetchCatalogSlugs, readClientCatalogFromKv, readRankedSlugsFromKv } from './prewarmCatalog';
import type { Env } from '../types';
import { clamp, getJsonFromKv } from '../utils';
import { normalizeRank, toFiniteNumber } from '../../../../config/shared/numeric';
import { isWfmSlug, sanitizeWfmSlug } from '../../../../config/shared/textNormalize';
import { WFM_HEADERS } from '../../../../config/shared/wfm';

const DAY_MS = 24 * 60 * 60 * 1000;
const DOC_TTL_SEC = 30 * 24 * 60 * 60;
// Spans the current day plus the seven complete days the aggregate reads. The current
// day is dropped before merging, so the kept rows are exactly the published window.
const SWEEP_WINDOW_DAYS = 8;
const AGGREGATE_WINDOW_DAYS = 7;
const TOP_TRADED_LIMIT = 100;
// A full pass republishes; between passes the doc is rebuilt at most hourly.
const AGGREGATE_MIN_INTERVAL_MS = 60 * 60 * 1000;
const MAX_SWEEP_BATCH = 300;
const MAX_STATS_ENTRIES = 4000;
// Same bound the archive writer keeps, so a corrupt day cannot burn the CPU budget.
const MAX_DAY_ROWS = 50000;
const MAX_NAME_LENGTH = 120;
const MAX_THUMB_LENGTH = 300;
const MAX_DOC_BYTES = 512 * 1024;
const STATS_WINDOW_KEY = '90days';

interface SweepState {
	cursor: number;
	slugsHash: string;
	lastCompletedAt: number;
	failures: number;
}

interface TopTradedItem {
	slug: string;
	name: string;
	volume: number;
	median: number;
	value: number;
	thumb?: string;
}

interface TopTradedDoc {
	generatedAt: number;
	windowDays: number;
	items: TopTradedItem[];
	/** The same items ordered by value; the client joins back on slug. */
	byValue: string[];
}

interface SweepResult {
	status: 'progress' | 'complete' | 'no_catalog' | 'disabled' | 'error';
	slugs: number;
	cursorBefore: number;
	cursorAfter: number;
	processed: number;
	failures: number;
	dates: number;
	filled: number;
	added: number;
	published: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function utcDate(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

function isDateId(value: unknown): value is string {
	return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Identifies the list the cursor indexes without storing a second copy of it: a
// catalog that gains or loses slugs mid-pass restarts the pass instead of skipping.
function slugListHash(slugs: string[]): string {
	let hash = 0x811c9dc5;
	for (const slug of slugs) {
		for (let index = 0; index < slug.length; index += 1) {
			hash ^= slug.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193);
		}
		hash ^= 0x2c;
		hash = Math.imul(hash, 0x01000193);
	}
	return `${slugs.length}-${(hash >>> 0).toString(16)}`;
}

function parseSweepState(value: Record<string, unknown> | null): SweepState {
	const cursor = toFiniteNumber(value?.cursor);
	const lastCompletedAt = toFiniteNumber(value?.lastCompletedAt);
	const failures = toFiniteNumber(value?.failures);
	return {
		cursor: cursor != null && cursor > 0 ? Math.floor(cursor) : 0,
		slugsHash: typeof value?.slugsHash === 'string' ? value.slugsHash : '',
		lastCompletedAt: lastCompletedAt != null && lastCompletedAt > 0 ? Math.floor(lastCompletedAt) : 0,
		failures: failures != null && failures > 0 ? Math.floor(failures) : 0,
	};
}

function statsEntries(payload: unknown): unknown[] | null {
	if (!isRecord(payload) || !isRecord(payload.payload)) return null;
	const closed = payload.payload.statistics_closed;
	if (!isRecord(closed)) return null;
	const rows = closed[STATS_WINDOW_KEY];
	return Array.isArray(rows) ? rows : null;
}

function statsDate(value: unknown): string | null {
	const date = typeof value === 'string' ? value.slice(0, 10) : '';
	return isDateId(date) ? date : null;
}

// Complete days only: today's volume is still growing and a merged row is never
// replaced, so a partial value would freeze and read as a complete day tomorrow.
// The rank rule mirrors the seed and the live bare price, so the volume belongs
// to the same sales the stored median came from.
function volumeRowsFromStats(payload: unknown, rank: number | null, oldest: string, today: string): Map<string, VolumeSample> | null {
	const entries = statsEntries(payload);
	if (!entries) return null;

	const rows = new Map<string, VolumeSample>();
	const limit = Math.min(entries.length, MAX_STATS_ENTRIES);
	for (let index = 0; index < limit; index += 1) {
		const entry = entries[index];
		if (!isRecord(entry)) continue;
		const entryRank = normalizeRank(entry.mod_rank ?? entry.rank);
		if (rank == null ? entryRank != null : entryRank !== rank) continue;
		const date = statsDate(entry.datetime);
		if (!date || date < oldest || date >= today) continue;
		const volume = toFiniteNumber(entry.volume);
		if (volume == null || volume < 0) continue;
		const rawMedian = toFiniteNumber(entry.median);
		if (rawMedian == null) continue;
		const median = Math.round(Math.abs(rawMedian));
		if (median <= 0) continue;
		rows.set(date, { median, volume: Math.round(volume) });
	}
	return rows;
}

/** null means the request failed or the payload was not the statistics shape. */
async function fetchVolumeRows(
	slug: string,
	rank: number | null,
	oldest: string,
	today: string,
): Promise<Map<string, VolumeSample> | null> {
	let response: Response;
	try {
		response = await fetch(`https://api.warframe.market/v1/items/${encodeURIComponent(slug)}/statistics`, { headers: WFM_HEADERS });
	} catch {
		return null;
	}
	if (!response.ok) return null;

	try {
		return volumeRowsFromStats(await response.json(), rank, oldest, today);
	} catch {
		return null;
	}
}

interface CatalogLabel {
	name: string;
	thumb: string | null;
}

async function readCatalogLabels(env: Env): Promise<Map<string, CatalogLabel>> {
	const labels = new Map<string, CatalogLabel>();
	const catalog = await readClientCatalogFromKv(env);
	if (!catalog) return labels;

	for (const item of catalog.items) {
		const slug = sanitizeWfmSlug(item.slug);
		if (!slug || labels.has(slug)) continue;
		labels.set(slug, {
			name: typeof item.name === 'string' ? item.name.slice(0, MAX_NAME_LENGTH) : '',
			thumb: typeof item.thumb === 'string' && item.thumb ? item.thumb.slice(0, MAX_THUMB_LENGTH) : null,
		});
	}
	return labels;
}

interface Rollup {
	volume: number;
	median: number;
}

/**
 * Rebuilds `top-traded:v1` from the last complete UTC days of the price archive. Only
 * bare-slug rows carry volume; the snapshot copy's `{slug}:rank-v3:r{n}` keys never do.
 */
export async function buildTopTraded(env: Env, options: { now?: number; force?: boolean } = {}): Promise<'built' | 'skipped' | 'no_data'> {
	const now = options.now ?? Date.now();
	if (!options.force) {
		const existing = await getJsonFromKv(env.ITEM_META, TOP_TRADED_DOC_KEY);
		const generatedAt = toFiniteNumber(existing?.generatedAt) ?? 0;
		if (now - generatedAt < AGGREGATE_MIN_INTERVAL_MS) return 'skipped';
	}

	const totals = new Map<string, Rollup>();
	// Oldest first so the newest day that priced a slug owns its median.
	for (let back = AGGREGATE_WINDOW_DAYS; back >= 1; back -= 1) {
		const date = utcDate(now - back * DAY_MS);
		const day = await getJsonFromKv(env.ITEM_META, `${ARCHIVE_PRICES_PREFIX}${date}`);
		if (!Array.isArray(day?.rows)) continue;

		for (const row of day.rows.slice(0, MAX_DAY_ROWS)) {
			if (!Array.isArray(row) || row.length < 3) continue;
			const key = typeof row[0] === 'string' ? row[0] : '';
			if (!isWfmSlug(key)) continue;
			const median = toFiniteNumber(row[1]);
			const volume = toFiniteNumber(row[2]);
			if (median == null || median <= 0 || volume == null || volume <= 0) continue;
			const current = totals.get(key);
			if (current) {
				current.volume += volume;
				current.median = median;
			} else {
				totals.set(key, { volume, median });
			}
		}
	}
	if (totals.size === 0) {
		logEvent({ type: 'cron', route: 'top-traded:aggregate', status: 204, error: 'no_volume_rows' });
		return 'no_data';
	}

	const labels = await readCatalogLabels(env);
	const ranked = [...totals.entries()]
		.map(([slug, rollup]): TopTradedItem => {
			const label = labels.get(slug);
			const volume = Math.round(rollup.volume);
			const median = Math.round(rollup.median);
			return {
				slug,
				name: label?.name ?? '',
				volume,
				median,
				value: volume * median,
				...(label?.thumb ? { thumb: label.thumb } : {}),
			};
		})
		.sort((a, b) => b.volume - a.volume || a.slug.localeCompare(b.slug))
		.slice(0, TOP_TRADED_LIMIT);

	const byValue = [...ranked].sort((a, b) => b.value - a.value || a.slug.localeCompare(b.slug)).map((item) => item.slug);
	const doc: TopTradedDoc = { generatedAt: now, windowDays: AGGREGATE_WINDOW_DAYS, items: ranked, byValue };
	const body = JSON.stringify(doc);
	const bytes = byteLength(body);
	if (bytes > MAX_DOC_BYTES) {
		logEvent({ type: 'error', route: 'top-traded:aggregate', status: 500, bytes, error: 'doc_too_large' });
		return 'no_data';
	}

	await env.ITEM_META.put(TOP_TRADED_DOC_KEY, body, { expirationTtl: DOC_TTL_SEC });
	logEvent({ type: 'cron', route: 'top-traded:aggregate', status: 200, count: ranked.length, bytes });
	return 'built';
}

/**
 * One batch of the rolling volume sweep. The cursor wraps continuously, so a slug that
 * failed is simply asked again on the next pass and nothing latches off.
 */
export async function sweepTopTraded(env: Env, options: { now?: number; batchSize?: number } = {}): Promise<SweepResult> {
	const now = options.now ?? Date.now();
	const config = getWorkerConfig(env);
	const base: SweepResult = {
		status: 'disabled',
		slugs: 0,
		cursorBefore: 0,
		cursorAfter: 0,
		processed: 0,
		failures: 0,
		dates: 0,
		filled: 0,
		added: 0,
		published: false,
	};
	if (!config.historyArchiveEnabled || !config.topTradedEnabled) return base;

	try {
		const slugs = await fetchCatalogSlugs(env, false);
		if (slugs.length === 0) {
			logEvent({ type: 'cron', route: 'top-traded:sweep', status: 204, error: 'catalog_unavailable' });
			return { ...base, status: 'no_catalog' };
		}

		const rankedSlugs = await readRankedSlugsFromKv(env);
		if (!rankedSlugs) {
			// Without the ranked catalog a mod's rank 0 volume cannot be told from its
			// max-rank volume, and the merged row would not match its own median.
			logEvent({ type: 'cron', route: 'top-traded:sweep', status: 204, error: 'ranked_catalog_unavailable' });
			return { ...base, status: 'no_catalog', slugs: slugs.length };
		}

		const state = parseSweepState(await getJsonFromKv(env.ITEM_META, TOP_TRADED_SWEEP_KEY));
		const hash = slugListHash(slugs);
		const batchSize = clamp(options.batchSize ?? config.topTradedBatchSize, 1, MAX_SWEEP_BATCH);
		const cursorBefore = state.slugsHash === hash ? Math.min(state.cursor, slugs.length) : 0;
		const cursorAfter = Math.min(cursorBefore + batchSize, slugs.length);
		const complete = cursorAfter >= slugs.length;
		const oldest = utcDate(now - (SWEEP_WINDOW_DAYS - 1) * DAY_MS);
		const today = utcDate(now);

		const result: SweepResult = {
			...base,
			status: complete ? 'complete' : 'progress',
			slugs: slugs.length,
			cursorBefore,
			cursorAfter,
		};

		// Serialized like the prewarm sweep: one upstream request at a time, never a burst.
		const byDate = new Map<string, Map<string, VolumeSample>>();
		for (let index = cursorBefore; index < cursorAfter; index += 1) {
			const slug = slugs[index];
			const rows = await fetchVolumeRows(slug, barePriceFetchRank(slug, rankedSlugs), oldest, today);
			result.processed += 1;
			if (!rows) {
				result.failures += 1;
				continue;
			}
			for (const [date, sample] of rows) {
				const dateRows = byDate.get(date);
				if (dateRows) dateRows.set(slug, sample);
				else byDate.set(date, new Map([[slug, sample]]));
			}
		}

		const merged = await mergeVolumes(env, byDate, { now });
		result.dates = merged.dates.length;
		result.filled = merged.filled;
		result.added = merged.added;

		const failures = complete ? 0 : state.failures + result.failures;
		await env.ITEM_META.put(
			TOP_TRADED_SWEEP_KEY,
			JSON.stringify({
				cursor: complete ? 0 : cursorAfter,
				slugsHash: hash,
				lastCompletedAt: complete ? now : state.lastCompletedAt,
				failures,
				updatedAt: now,
			}),
		);

		if (complete) {
			const passFailures = state.failures + result.failures;
			logEvent({
				type: 'cron',
				route: 'top-traded:sweep',
				status: passFailures > 0 ? 206 : 200,
				count: passFailures > 0 ? passFailures : slugs.length,
				...(passFailures > 0 ? { error: 'pass_failures' } : {}),
			});
		}

		result.published = (await buildTopTraded(env, { now, force: complete })) === 'built';
		return result;
	} catch (err) {
		logEvent({
			type: 'error',
			route: 'top-traded:sweep',
			status: 500,
			error: err instanceof Error ? err.message : 'unknown_error',
		});
		return { ...base, status: 'error' };
	}
}

/** Validated published doc for the public route; null when no pass has published yet. */
export async function readTopTradedDoc(env: Env): Promise<TopTradedDoc | null> {
	const stored = await getJsonFromKv(env.ITEM_META, TOP_TRADED_DOC_KEY);
	const generatedAt = toFiniteNumber(stored?.generatedAt);
	if (generatedAt == null || generatedAt <= 0 || !Array.isArray(stored?.items)) return null;

	const items: TopTradedItem[] = [];
	const known = new Set<string>();
	for (const row of stored.items) {
		if (!isRecord(row)) continue;
		const slug = sanitizeWfmSlug(row.slug);
		if (!slug || known.has(slug)) continue;
		const volume = toFiniteNumber(row.volume);
		const median = toFiniteNumber(row.median);
		if (volume == null || volume <= 0 || median == null || median <= 0) continue;
		known.add(slug);
		items.push({
			slug,
			name: typeof row.name === 'string' ? row.name.slice(0, MAX_NAME_LENGTH) : '',
			volume: Math.round(volume),
			median: Math.round(median),
			value: Math.round(toFiniteNumber(row.value) ?? volume * median),
			...(typeof row.thumb === 'string' && row.thumb ? { thumb: row.thumb.slice(0, MAX_THUMB_LENGTH) } : {}),
		});
		if (items.length >= TOP_TRADED_LIMIT) break;
	}
	if (items.length === 0) return null;

	const byValue = Array.isArray(stored.byValue)
		? stored.byValue.filter((slug): slug is string => typeof slug === 'string' && known.has(slug)).slice(0, TOP_TRADED_LIMIT)
		: [];
	const windowDays = toFiniteNumber(stored.windowDays);

	return {
		generatedAt: Math.floor(generatedAt),
		windowDays: windowDays != null && windowDays > 0 ? Math.floor(windowDays) : AGGREGATE_WINDOW_DAYS,
		items,
		byValue,
	};
}
