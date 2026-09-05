import { normalizeRank } from '../../../../config/shared/numeric';
import { WFM_HEADERS } from '../../../../config/shared/wfm';
import { isRecord, utcDate } from '../utils';

const DAY_MS = 24 * 60 * 60 * 1000;
// warframe.market serves 90 daily closed-trade rows per item under this one key.
const STATS_WINDOW_KEY = '90days';
// A payload far past the served window is malformed, so one bad item cannot burn
// the CPU budget of the whole batch.
const MAX_STATS_ENTRIES = 4000;

/** The UTC day id `days` days before `now`, the form both sweep windows are bounded by. */
export function utcDayBefore(now: number, days: number): string {
	return utcDate(now - days * DAY_MS);
}

export function isDateId(value: unknown): value is string {
	return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
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

interface StatsDayEntry {
	date: string;
	entry: Record<string, unknown>;
}

/** Dated closed-trade entries for one rank; a null rank keeps the rankless ones, the way the
 *  live bare price reads an unranked item. Null means the payload was not the statistics
 *  shape, and a caller must not read that as "the item had no sales". */
export function statsDayEntries(payload: unknown, rank: number | null): StatsDayEntry[] | null {
	const entries = statsEntries(payload);
	if (!entries) return null;

	const rows: StatsDayEntry[] = [];
	const limit = Math.min(entries.length, MAX_STATS_ENTRIES);
	for (let index = 0; index < limit; index += 1) {
		const entry = entries[index];
		if (!isRecord(entry)) continue;
		const entryRank = normalizeRank(entry.mod_rank ?? entry.rank);
		if (rank == null ? entryRank != null : entryRank !== rank) continue;
		const date = statsDate(entry.datetime);
		if (!date) continue;
		rows.push({ date, entry });
	}
	return rows;
}

/** null means the request failed or the payload was not the statistics shape. */
export async function fetchItemStatistics(slug: string): Promise<unknown | null> {
	let response: Response;
	try {
		response = await fetch(`https://api.warframe.market/v1/items/${encodeURIComponent(slug)}/statistics`, { headers: WFM_HEADERS });
	} catch {
		return null;
	}
	if (!response.ok) return null;

	try {
		return await response.json();
	} catch {
		return null;
	}
}
