import {
	BARO_HISTORY_KEY,
	BARO_HISTORY_MAX_ITEMS,
	BARO_HISTORY_MAX_VISITS,
	normalizeBaroHistory,
	type BaroHistory,
	type BaroHistoryItem,
	type BaroHistoryVisit,
} from '../../../../config/shared/baroHistory';
import { getWorkerConfig } from '../config';
import { storeItemPath } from '../../../../config/shared/itemPath';
import { ARCHIVE_BARO_PREFIX, ARCHIVE_INDEX_PREFIX, MAX_ARCHIVE_BYTES } from '../constants';
import type { Env } from '../types';
import { byteLength, isRecord, parseJsonRecord } from '../utils';
import { logEvent } from './logging';

const DAY_MS = 86_400_000;
const RECOVERY_KEY = 'baro:history:recovery:v1';
const ARCHIVE_RECOVERY_KEY = 'baro:history:recovery:archives:v1';
const READ_BATCH_SIZE = 8;
const writes = new WeakMap<KVNamespace, Promise<unknown>>();

function emptyHistory(now: number): BaroHistory {
	return { version: 1, updatedAt: now, coverageStart: null, visits: [], lastSeen: [] };
}

function archiveCost(value: unknown, version: number): number | null {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
	// Version 1 encoded missing prices as zero, so those zeros are ambiguous.
	return value === 0 && version === 1 ? null : value;
}

function parseArchive(raw: string, id: string, now: number): BaroHistoryVisit | null {
	const source = byteLength(raw) <= MAX_ARCHIVE_BYTES ? parseJsonRecord(raw) : null;
	if (!isRecord(source) || (source.v !== 1 && source.v !== 2) || source.visitId !== id || !Array.isArray(source.rows)) return null;
	if (source.rows.length === 0 || source.rows.length > 500) return null;
	const activation = typeof source.activation === 'string' ? Date.parse(source.activation) : NaN;
	const expiry = typeof source.expiry === 'string' ? Date.parse(source.expiry) : NaN;
	if (activation > now) return null;
	const items = new Map<string, BaroHistoryItem>();
	for (const row of source.rows) {
		if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0].startsWith('/Lotus/') || row[0].length > 512) return null;
		const uniqueName = storeItemPath(row[0]);
		if (!uniqueName.includes('BaroTreasureBox') && !items.has(uniqueName)) {
			items.set(uniqueName, { uniqueName, ducats: archiveCost(row[1], source.v), credits: archiveCost(row[2], source.v) });
		}
	}
	const visit = { id, activation, expiry, node: typeof source.node === 'string' ? source.node : '', items: [...items.values()] };
	return normalizeBaroHistory({ ...emptyHistory(now), visits: [visit] })?.visits[0] ?? null;
}

/**
 * A visit is its activation. DE reuses one VoidTraders _id for every visit (its ObjectId dates
 * from 2019), which the first collector used as the archive id.
 */
export function baroVisitId(activation: number): string {
	return `d${activation}`;
}

function activationKeyed(visit: BaroHistoryVisit): boolean {
	return visit.id === baroVisitId(visit.activation);
}

function combineVisits(previous: BaroHistoryVisit | undefined, visit: BaroHistoryVisit, preserveSchedule: boolean): BaroHistoryVisit {
	// Where a legacy ObjectId record meets the activation-keyed one, the latter's observation wins.
	const incomingFirst = !previous || activationKeyed(visit) || !activationKeyed(previous);
	const items = new Map(previous?.items.map((entry) => [entry.uniqueName, entry]));
	for (const item of visit.items) {
		if (item.uniqueName.includes('BaroTreasureBox')) continue;
		const known = items.get(item.uniqueName);
		const [first, second] = incomingFirst ? [item, known] : [known, item];
		items.set(item.uniqueName, {
			uniqueName: item.uniqueName,
			ducats: first?.ducats ?? second?.ducats ?? null,
			credits: first?.credits ?? second?.credits ?? null,
		});
	}
	if (!previous) return { ...visit, items: [...items.values()] };
	// Re-reading a raw archive of the same id kind keeps a corrected schedule.
	const keepSchedule = !incomingFirst || (preserveSchedule && activationKeyed(previous) === activationKeyed(visit));
	return {
		id: incomingFirst ? visit.id : previous.id,
		activation: previous.activation,
		expiry: keepSchedule ? previous.expiry : Math.max(previous.activation + 1, visit.expiry),
		node: incomingFirst ? visit.node : previous.node,
		items: [...items.values()],
	};
}

function mergeVisit(
	history: BaroHistory,
	visit: BaroHistoryVisit,
	now: number,
	retentionDays: number,
	preserveSchedule = false,
): BaroHistory {
	const canonicalId = baroVisitId(visit.activation);
	const same = (entry: BaroHistoryVisit) => entry.id === visit.id || entry.id === canonicalId || entry.activation === visit.activation;
	const matches = history.visits.filter(same);
	let merged = combineVisits(
		matches.reduce<BaroHistoryVisit | undefined>((acc, entry) => combineVisits(acc, entry, false), undefined),
		visit,
		preserveSchedule,
	);
	if (matches.some((entry) => entry.id !== visit.id)) merged = { ...merged, id: canonicalId };
	const lastSeen = new Map(
		history.lastSeen.filter((item) => !item.uniqueName.includes('BaroTreasureBox')).map((item) => [item.uniqueName, item]),
	);
	for (const [uniqueName, item] of lastSeen) {
		if (item.lastSeen === merged.activation && item.visitId !== merged.id) lastSeen.set(uniqueName, { ...item, visitId: merged.id });
	}
	for (const item of merged.items) {
		const previousItem = lastSeen.get(item.uniqueName);
		if (previousItem && previousItem.lastSeen > merged.activation) continue;
		const sameVisit = previousItem?.lastSeen === merged.activation ? previousItem : null;
		lastSeen.set(item.uniqueName, {
			...item,
			ducats: item.ducats ?? sameVisit?.ducats ?? null,
			credits: item.credits ?? sameVisit?.credits ?? null,
			visitId: merged.id,
			lastSeen: merged.activation,
		});
	}
	if (lastSeen.size > BARO_HISTORY_MAX_ITEMS) throw new Error('baro_history_item_limit');
	return {
		version: 1,
		updatedAt: Math.max(history.updatedAt, now),
		coverageStart: Math.min(history.coverageStart ?? merged.activation, merged.activation),
		visits: [...history.visits.filter((entry) => !same(entry)), merged]
			.filter((entry) => entry.expiry >= now - retentionDays * DAY_MS)
			.sort((a, b) => b.activation - a.activation || a.id.localeCompare(b.id))
			.slice(0, BARO_HISTORY_MAX_VISITS),
		lastSeen: [...lastSeen.values()].sort((a, b) => a.uniqueName.localeCompare(b.uniqueName)),
	};
}

export async function readBaroHistory(env: Env): Promise<BaroHistory | null> {
	const durable = await env.ITEM_META.get(BARO_HISTORY_KEY);
	if (durable === null) return null;
	if (byteLength(durable) > MAX_ARCHIVE_BYTES) return null;
	return normalizeBaroHistory(parseJsonRecord(durable));
}

function salvageHistory(raw: string | null, now: number, retentionDays: number): BaroHistory {
	let history = emptyHistory(now);
	const source = raw === null || byteLength(raw) > MAX_ARCHIVE_BYTES ? null : parseJsonRecord(raw);
	if (!source) return history;
	const names = new Map<string, BaroHistory['lastSeen'][number]>();
	if (Array.isArray(source.lastSeen)) {
		if (source.lastSeen.length > BARO_HISTORY_MAX_ITEMS) throw new Error('baro_history_item_limit');
		for (const item of source.lastSeen) {
			const valid = normalizeBaroHistory({ ...emptyHistory(now), lastSeen: [item] })?.lastSeen[0];
			if (!valid || valid.uniqueName.includes('BaroTreasureBox')) continue;
			const previous = names.get(valid.uniqueName);
			if (!previous || previous.lastSeen < valid.lastSeen) names.set(valid.uniqueName, valid);
		}
	}
	history.lastSeen = [...names.values()];
	history.coverageStart = history.lastSeen.length ? Math.min(...history.lastSeen.map((item) => item.lastSeen)) : null;
	if (Array.isArray(source.visits)) {
		if (source.visits.length > BARO_HISTORY_MAX_VISITS) throw new Error('baro_history_visit_limit');
		for (const entry of source.visits) {
			const valid = normalizeBaroHistory({ ...emptyHistory(now), visits: [entry] })?.visits[0];
			if (valid && valid.activation <= now) history = mergeVisit(history, valid, now, retentionDays);
		}
	}
	return history;
}

async function reconcileHistory(env: Env, now: number): Promise<{ history: BaroHistory; complete: boolean; archivedVisits: string[] }> {
	const raw = await env.ITEM_META.get(BARO_HISTORY_KEY);
	if (raw !== null && byteLength(raw) > MAX_ARCHIVE_BYTES) throw new Error('baro_history_too_large');
	const source = raw === null ? null : parseJsonRecord(raw);
	const parsed = normalizeBaroHistory(source);
	const acknowledged = new Set(parsed?.visits.map((entry) => entry.id));
	if (parsed && Array.isArray(source?.archivedVisits) && source.archivedVisits.length <= BARO_HISTORY_MAX_VISITS) {
		for (const id of source.archivedVisits) {
			if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) acknowledged.add(id);
		}
	}
	const retentionDays = getWorkerConfig(env).historyRetentionDays;
	let history = parsed ?? salvageHistory(raw, now, retentionDays);
	history = {
		...history,
		visits: history.visits
			.filter((entry) => entry.expiry >= now - retentionDays * DAY_MS)
			.map((entry) => ({
				...entry,
				items: entry.items.filter((item) => !item.uniqueName.includes('BaroTreasureBox')),
			})),
		lastSeen: history.lastSeen.filter((item) => !item.uniqueName.includes('BaroTreasureBox')),
	};
	// An arrival stored under both its ObjectId and its activation id becomes one visit.
	if (new Set(history.visits.map((entry) => entry.activation)).size < history.visits.length) {
		history = history.visits.reduce<BaroHistory>((merged, entry) => mergeVisit(merged, entry, now, retentionDays), {
			...history,
			visits: [],
		});
	}
	if (raw !== null && !parsed) {
		// Preserve the source before repair, including records the validator cannot recover.
		await env.ITEM_META.put(RECOVERY_KEY, raw);
		logEvent({ type: 'error', route: 'archive:baro', status: 200, error: 'baro_history_repaired', count: history.lastSeen.length });
	}
	const indexRaw = await env.ITEM_META.get(`${ARCHIVE_INDEX_PREFIX}baro:v1`);
	const index = parseJsonRecord(indexRaw);
	if (indexRaw !== null && (!index || !Array.isArray(index.entries))) throw new Error('invalid_baro_archive_index');
	const ids = new Set(
		(Array.isArray(index?.entries) ? index.entries : [])
			.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id))
			.slice(-BARO_HISTORY_MAX_VISITS),
	);
	// A failed durable write leaves its manifest outside the index. Rediscover it after departure.
	const listed = await env.ITEM_META.list({ prefix: ARCHIVE_BARO_PREFIX, limit: BARO_HISTORY_MAX_VISITS });
	if (!listed.list_complete) throw new Error('baro_archive_scan_limit');
	for (const key of listed.keys) {
		const id = key.name.slice(ARCHIVE_BARO_PREFIX.length);
		if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) ids.add(id);
	}
	if (ids.size > BARO_HISTORY_MAX_VISITS) throw new Error('baro_archive_scan_limit');
	const entries = [...ids];
	let complete = true;
	let recovered: Record<string, unknown> | null = null;
	for (let start = 0; start < entries.length; start += READ_BATCH_SIZE) {
		const batch = entries.slice(start, start + READ_BATCH_SIZE);
		const archives = await Promise.allSettled(batch.map((id) => env.ITEM_META.get(`${ARCHIVE_BARO_PREFIX}${id}`)));
		for (const [offset, result] of archives.entries()) {
			const visit = result.status === 'fulfilled' && result.value !== null ? parseArchive(result.value, batch[offset], now) : null;
			if (visit) {
				history = mergeVisit(history, visit, now, retentionDays, true);
				acknowledged.add(visit.id);
			} else if (!acknowledged.has(batch[offset])) {
				if (result.status !== 'fulfilled' || result.value === null || byteLength(result.value) > MAX_ARCHIVE_BYTES) {
					complete = false;
					continue;
				}
				const archiveSource = parseJsonRecord(result.value);
				if (typeof archiveSource?.activation === 'string' && Date.parse(archiveSource.activation) > now) {
					complete = false;
					continue;
				}
				if (!recovered) {
					const recoveryRaw = await env.ITEM_META.get(ARCHIVE_RECOVERY_KEY);
					recovered = recoveryRaw === null ? {} : parseJsonRecord(recoveryRaw);
					if (!recovered) throw new Error('invalid_baro_archive_recovery');
				}
				recovered = { ...recovered, [batch[offset]]: result.value };
				const recoveryBody = JSON.stringify(recovered);
				if (Object.keys(recovered).length > BARO_HISTORY_MAX_VISITS || byteLength(recoveryBody) > MAX_ARCHIVE_BYTES)
					throw new Error('baro_archive_recovery_limit');
				// Quarantine unreadable manifests before allowing their indexed copies to expire.
				await env.ITEM_META.put(ARCHIVE_RECOVERY_KEY, recoveryBody);
				acknowledged.add(batch[offset]);
				logEvent({ type: 'error', route: 'archive:baro', status: 200, error: 'baro_archive_quarantined', count: 1 });
			}
		}
	}
	return { history, complete, archivedVisits: entries.filter((id) => acknowledged.has(id)) };
}

async function serializeWrite<T>(env: Env, work: () => Promise<T>): Promise<T> {
	const preceding = writes.get(env.ITEM_META) ?? Promise.resolve();
	const write = preceding.catch(() => undefined).then(work);
	writes.set(env.ITEM_META, write);
	try {
		return await write;
	} finally {
		if (writes.get(env.ITEM_META) === write) writes.delete(env.ITEM_META);
	}
}

async function saveHistory(env: Env, history: BaroHistory, archivedVisits: string[]): Promise<void> {
	if (!normalizeBaroHistory(history)) throw new Error('invalid_baro_history_merge');
	const raw = JSON.stringify({ ...history, archivedVisits });
	if (byteLength(raw) > MAX_ARCHIVE_BYTES) throw new Error('baro_history_too_large');
	await env.ITEM_META.put(BARO_HISTORY_KEY, raw);
}

export async function migrateBaroHistory(env: Env, now = Date.now(), visit?: BaroHistoryVisit): Promise<BaroHistory> {
	const valid = visit ? normalizeBaroHistory({ ...emptyHistory(now), visits: [visit] })?.visits[0] : undefined;
	if (visit && (!valid || visit.activation > now || visit.items.length === 0)) throw new Error('invalid_baro_visit');
	return serializeWrite(env, async () => {
		const result = await reconcileHistory(env, now);
		const history = valid ? mergeVisit(result.history, valid, now, getWorkerConfig(env).historyRetentionDays) : result.history;
		await saveHistory(env, history, result.archivedVisits);
		if (!result.complete) throw new Error('baro_history_migration_incomplete');
		return history;
	});
}
