import { ARCHIVE_PRICES_PREFIX, PRICE_SEED_SLUGS_KEY, PRICE_SEED_STATE_KEY } from '../constants';
import { getWorkerConfig } from '../config';
import {
	byteLength,
	dayRetentionTtlSec,
	MAX_ARCHIVE_BYTES,
	MAX_PRICE_ROWS,
	type PriceRow,
	recordArchiveEntries,
	storedPriceRows,
} from './history';
import { logEvent } from './logging';
import { barePriceFetchRank, fetchCatalogSlugs, readRankedSlugsFromKv } from './prewarmCatalog';
import { utcDate } from '../utils';
import { fetchItemStatistics, isDateId, statsDayEntries, utcDayBefore } from './wfmStatistics';
import type { Env } from '../types';
import { clamp, getJsonFromKv } from '../utils';
import { toFiniteNumber } from '../../../../config/shared/numeric';
import { sanitizeWfmSlug } from '../../../../config/shared/textNormalize';

// warframe.market serves 90 daily closed-trade rows per item; that is the whole seed window.
const SEED_WINDOW_DAYS = 90;
const MAX_SEED_BATCH = 40;
const MAX_SEED_SLUGS = 20000;
// A WFM outage during the ~50h sweep would otherwise lose those slugs' 90 days
// for good, so the failures get bounded retry passes before the latch closes.
const MAX_SEED_RETRY_PASSES = 3;

interface SeedWindow {
	oldest: string;
	startedDate: string;
}

interface PriceSeedState {
	startedDate: string;
	cursor: number;
	complete: boolean;
	failures: number;
	/** 0 walks the pinned catalog; every later pass walks only `retrySlugs`. */
	retryPass: number;
	retrySlugs: string[];
	/** Slugs that failed during the pass now running, retried by the next one. */
	failedSlugs: string[];
}

interface PriceSeedResult {
	status: 'progress' | 'complete' | 'idle' | 'no_catalog' | 'disabled' | 'error';
	startedDate: string;
	slugs: number;
	cursorBefore: number;
	cursorAfter: number;
	processed: number;
	failures: number;
	retryPass: number;
	/** Slugs still owed a retry when this tick ended. */
	pending: number;
	dates: number;
	rows: number;
	bytes: number;
}

interface FlushResult {
	dates: string[];
	rows: number;
	bytes: number;
}

// The live daily archive owns the sweep's own day onwards, so the seed stops one day short.
function seedWindow(startedDate: string): SeedWindow {
	return { oldest: utcDayBefore(Date.parse(`${startedDate}T00:00:00.000Z`), SEED_WINDOW_DAYS), startedDate };
}

function inSeedWindow(date: string, dateWindow: SeedWindow): boolean {
	return date >= dateWindow.oldest && date < dateWindow.startedDate;
}

function parseSeedState(value: Record<string, unknown> | null): PriceSeedState | null {
	if (!value || !isDateId(value.startedDate)) return null;
	const cursor = toFiniteNumber(value.cursor);
	const failures = toFiniteNumber(value.failures);
	const retryPass = toFiniteNumber(value.retryPass);
	return {
		startedDate: value.startedDate,
		cursor: cursor != null && cursor > 0 ? Math.floor(cursor) : 0,
		complete: value.complete === true,
		failures: failures != null && failures > 0 ? Math.floor(failures) : 0,
		retryPass: retryPass != null && retryPass > 0 ? Math.floor(retryPass) : 0,
		retrySlugs: sanitizeSlugs(value.retrySlugs),
		failedSlugs: sanitizeSlugs(value.failedSlugs),
	};
}

function sanitizeSlugs(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const slugs: string[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		const slug = sanitizeWfmSlug(entry);
		if (!slug || seen.has(slug)) continue;
		seen.add(slug);
		slugs.push(slug);
		if (slugs.length >= MAX_SEED_SLUGS) break;
	}
	return slugs;
}

/** The slug list is pinned on the first tick so a catalog refresh cannot shift the cursor. */
async function loadSeedSlugs(env: Env, now: number): Promise<string[]> {
	const stored = sanitizeSlugs((await getJsonFromKv(env.ITEM_META, PRICE_SEED_SLUGS_KEY))?.slugs);
	if (stored.length > 0) return stored;

	const slugs = sanitizeSlugs(await fetchCatalogSlugs(env, false));
	if (slugs.length === 0) return [];
	await env.ITEM_META.put(PRICE_SEED_SLUGS_KEY, JSON.stringify({ updatedAt: now, slugs }));
	return slugs;
}

// Same rounding the live median takes, so a seeded day and a live day are one series.
function seedMedian(value: unknown): number | null {
	const parsed = toFiniteNumber(value);
	if (parsed == null) return null;
	const median = Math.round(Math.abs(parsed));
	return median > 0 ? median : null;
}

/**
 * One day row per date: ranked slugs price from mod_rank 0 like the live bare key, unranked
 * ones from the rankless entries, and the last entry of a date wins as it does live.
 */
function seedRowsFromStats(payload: unknown, slug: string, rank: number | null, dateWindow: SeedWindow): Map<string, PriceRow> | null {
	const entries = statsDayEntries(payload, rank);
	if (!entries) return null;

	const rows = new Map<string, PriceRow>();
	for (const { date, entry } of entries) {
		if (!inSeedWindow(date, dateWindow)) continue;
		const median = seedMedian(entry.median);
		if (median == null) continue;
		const volume = toFiniteNumber(entry.volume);
		rows.set(date, volume == null || volume < 0 ? [slug, median] : [slug, median, Math.round(volume)]);
	}
	return rows;
}

/**
 * Read-modify-write of only the days this batch touched. An existing row is never
 * replaced, so a live day keeps its own medians and only gains the keys it lacks.
 */
async function flushSeedDates(env: Env, buffered: Map<string, PriceRow[]>, now: number, retentionDays: number): Promise<FlushResult> {
	const result: FlushResult = { dates: [], rows: 0, bytes: 0 };

	for (const date of [...buffered.keys()].sort()) {
		const key = `${ARCHIVE_PRICES_PREFIX}${date}`;
		const existing = await getJsonFromKv(env.ITEM_META, key);
		const rows = storedPriceRows(existing);
		const known = new Set(rows.map((row) => row[0]));

		let added = 0;
		for (const row of buffered.get(date) ?? []) {
			if (known.has(row[0]) || rows.length >= MAX_PRICE_ROWS) continue;
			known.add(row[0]);
			rows.push(row);
			added += 1;
		}
		if (added === 0) continue;

		const body = JSON.stringify({
			v: 1,
			date,
			generatedAt: toFiniteNumber(existing?.generatedAt) ?? now,
			// A day the live archive already wrote keeps its source and only gains rows.
			source: typeof existing?.source === 'string' ? existing.source : 'wfm-statistics-seed',
			columns: ['key', 'median', 'volume'],
			rows,
		});
		const bytes = byteLength(body);
		if (bytes > MAX_ARCHIVE_BYTES) {
			logEvent({ type: 'error', route: 'archive:price-seed', status: 500, bytes, error: 'archive_too_large' });
			continue;
		}

		await env.ITEM_META.put(key, body, { expirationTtl: dayRetentionTtlSec(date, now, retentionDays) });
		result.dates.push(date);
		result.rows += added;
		result.bytes = Math.max(result.bytes, bytes);
	}
	return result;
}

/**
 * One batch of the one-time 90-day price seed, filling the days before the sweep started.
 * `complete: true` in the state key latches it off for good, redeploys included.
 */
export async function seedPriceHistory(env: Env, options: { now?: number; batchSize?: number } = {}): Promise<PriceSeedResult> {
	const now = options.now ?? Date.now();
	const config = getWorkerConfig(env);
	const base: PriceSeedResult = {
		status: 'disabled',
		startedDate: '',
		slugs: 0,
		cursorBefore: 0,
		cursorAfter: 0,
		processed: 0,
		failures: 0,
		retryPass: 0,
		pending: 0,
		dates: 0,
		rows: 0,
		bytes: 0,
	};
	if (!config.historyArchiveEnabled || !config.priceSeedEnabled) return base;

	try {
		const stored = await getJsonFromKv(env.ITEM_META, PRICE_SEED_STATE_KEY);
		// Checked before anything else so a finished seed costs one KV read and no request.
		if (stored?.complete === true) {
			return { ...base, status: 'idle', startedDate: isDateId(stored.startedDate) ? stored.startedDate : '' };
		}
		const state = parseSeedState(stored);

		const slugs = await loadSeedSlugs(env, now);
		if (slugs.length === 0) {
			logEvent({ type: 'cron', route: 'archive:price-seed', status: 204, error: 'catalog_unavailable' });
			return { ...base, status: 'no_catalog', startedDate: state?.startedDate ?? '' };
		}

		const rankedSlugs = await readRankedSlugsFromKv(env);
		if (!rankedSlugs) {
			// Without the ranked catalog the rank rule cannot be applied, and a mixed-rank
			// median would be archived permanently. Leave the cursor for the next tick.
			logEvent({ type: 'cron', route: 'archive:price-seed', status: 204, error: 'ranked_catalog_unavailable' });
			return { ...base, status: 'no_catalog', startedDate: state?.startedDate ?? '', slugs: slugs.length };
		}

		const startedDate = state?.startedDate ?? utcDate(now);
		const dateWindow = seedWindow(startedDate);
		const batchSize = clamp(options.batchSize ?? config.priceSeedBatchSize, 1, MAX_SEED_BATCH);
		const retryPass = state?.retryPass ?? 0;
		// Pass 0 walks the pinned catalog; every later pass walks only what failed.
		const list = retryPass === 0 ? slugs : (state?.retrySlugs ?? []);
		const cursorBefore = Math.min(state?.cursor ?? 0, list.length);
		const cursorAfter = Math.min(cursorBefore + batchSize, list.length);
		const endOfPass = cursorAfter >= list.length;

		const result: PriceSeedResult = {
			...base,
			status: 'progress',
			startedDate,
			slugs: list.length,
			cursorBefore,
			cursorAfter,
			retryPass,
		};

		// Serialized like the prewarm sweep: one upstream request at a time, never a burst.
		const buffered = new Map<string, PriceRow[]>();
		let failures = state?.failures ?? 0;
		const failedSlugs = [...(state?.failedSlugs ?? [])];
		for (let index = cursorBefore; index < cursorAfter; index += 1) {
			const slug = list[index];
			const payload = await fetchItemStatistics(slug);
			const rows = seedRowsFromStats(payload, slug, barePriceFetchRank(slug, rankedSlugs), dateWindow);
			result.processed += 1;
			if (!rows) {
				// Queued for a retry pass instead of dropped; no negative marker either way.
				result.failures += 1;
				failures += 1;
				if (failedSlugs.length < MAX_SEED_SLUGS && !failedSlugs.includes(slug)) failedSlugs.push(slug);
				continue;
			}
			for (const [date, row] of rows) {
				const dateRows = buffered.get(date);
				if (dateRows) dateRows.push(row);
				else buffered.set(date, [row]);
			}
		}

		const flushed = await flushSeedDates(env, buffered, now, config.historyRetentionDays);
		result.dates = flushed.dates.length;
		result.rows = flushed.rows;
		result.bytes = flushed.bytes;
		if (flushed.dates.length > 0) await recordArchiveEntries(env, 'prices', flushed.dates, config.historyRetentionDays);

		// The latch waits for the retry budget: a slug lost to an outage would otherwise
		// never be asked for again, and WFM serves no window older than 90 days.
		const retrying = endOfPass && failedSlugs.length > 0 && retryPass < MAX_SEED_RETRY_PASSES;
		const complete = endOfPass && !retrying;
		result.status = complete ? 'complete' : 'progress';
		result.pending = failedSlugs.length;
		const nextRetrySlugs = retrying ? failedSlugs : complete || retryPass === 0 ? [] : list;

		await env.ITEM_META.put(
			PRICE_SEED_STATE_KEY,
			JSON.stringify({
				startedDate,
				cursor: retrying ? 0 : cursorAfter,
				complete,
				failures,
				retryPass: retrying ? retryPass + 1 : retryPass,
				retrySlugs: nextRetrySlugs,
				failedSlugs: complete || retrying ? [] : failedSlugs,
				updatedAt: now,
			}),
		);
		if (complete) await env.ITEM_META.delete(PRICE_SEED_SLUGS_KEY);

		if (complete && failedSlugs.length > 0) {
			logEvent({ type: 'cron', route: 'archive:price-seed', status: 206, count: failedSlugs.length, error: 'seed_retries_exhausted' });
		}
		logEvent({ type: 'cron', route: 'archive:price-seed', status: 200, count: result.rows, bytes: result.bytes });
		return result;
	} catch (err) {
		logEvent({
			type: 'error',
			route: 'archive:price-seed',
			status: 500,
			error: err instanceof Error ? err.message : 'unknown_error',
		});
		return { ...base, status: 'error' };
	}
}
