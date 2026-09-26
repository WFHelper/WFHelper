import { WFCD_RELICS_DOC_KEY, WFCD_RELICS_STATE_KEY } from '../constants';
import { getWorkerConfig } from '../config';
import { logEvent } from './logging';
import type { Env } from '../types';
import { byteLength, getJsonFromKv, isRecord } from '../utils';
import { withAbortTimeout } from '../../../../config/shared/fetchWithTimeout';
import { normalizeDucats, toFiniteNumber } from '../../../../config/shared/numeric';
import { readResponseText } from '../../../../config/shared/readResponseText';
import {
	compareWfcdVersions,
	hasTooManyWfcdRewardNames,
	isWfcdRelicIdentity,
	isWfcdRelicRarity,
	isWfcdRelicRowCount,
	isWfcdRewardChance,
	isWfcdRewardCount,
	isWfcdRewardName,
	isWfcdVersion,
	WFCD_RELIC_MAX_STRING,
	WFCD_RELICS_MAX_BYTES,
	type WfcdRelicRarity,
} from '../../../../config/shared/wfcdRelicRules';

// The abbreviated install doc has no per-version publish time, so this is the full
// packument: 4.5 MB raw, 368 KB gzipped on the wire for 1,279 versions (2026-09-26).
const REGISTRY_URL = 'https://registry.npmjs.org/@wfcd%2Fitems';
const WORKER_UA = 'WFHelper-worker/1.0 (+https://wfhelper.com)';
const REGISTRY_TIMEOUT_MS = 15_000;
const DATA_TIMEOUT_MS = 30_000;
// Relics.json of 1.1276.6 is 8.8 MB raw; the trimmed doc is 4.9 MB against KV's 25 MiB.
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
const MAX_DATA_BYTES = 32 * 1024 * 1024;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const STATE_TTL_SEC = 7 * 24 * 60 * 60;
interface WfcdMarketRef {
	id?: string;
	urlName?: string;
}

interface WfcdRewardItem {
	uniqueName: string;
	name: string;
	imageName?: string;
	ducats?: number;
	warframeMarket?: WfcdMarketRef;
}

interface WfcdReward {
	chance: number;
	rarity: WfcdRelicRarity;
	item: WfcdRewardItem;
}

interface WfcdRelic {
	uniqueName: string;
	name: string;
	vaulted: boolean;
	imageName?: string;
	dropCount: number;
	rewards: WfcdReward[];
}

interface WfcdRelease {
	version: string;
	publishedAt: string;
}

interface StoredDocMeta extends WfcdRelease {
	generatedAt: string;
	count: number;
	relicsHash?: string;
}

function hasOverlongString(value: unknown): boolean {
	if (typeof value === 'string') return value.length > WFCD_RELIC_MAX_STRING;
	if (Array.isArray(value)) return value.some(hasOverlongString);
	if (isRecord(value)) return Object.values(value).some(hasOverlongString);
	return false;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

function trimMarketRef(value: unknown): WfcdMarketRef | undefined {
	if (!isRecord(value)) return undefined;
	const id = nonEmptyString(value.id);
	const urlName = nonEmptyString(value.urlName) ?? nonEmptyString(value.url_name);
	if (!id && !urlName) return undefined;
	return { ...(id ? { id } : {}), ...(urlName ? { urlName } : {}) };
}

function trimReward(value: unknown): WfcdReward | null {
	if (!isRecord(value)) return null;
	const { chance, rarity, item } = value;
	if (!isWfcdRewardChance(chance) || !isWfcdRelicRarity(rarity) || !isRecord(item)) return null;
	const name = item.name;
	if (!isWfcdRewardName(name) || typeof item.uniqueName !== 'string') return null;
	const imageName = nonEmptyString(item.imageName);
	const ducats = normalizeDucats(item.ducats);
	const warframeMarket = trimMarketRef(item.warframeMarket);
	return {
		chance,
		rarity,
		item: {
			uniqueName: item.uniqueName,
			name,
			...(imageName ? { imageName } : {}),
			...(ducats != null ? { ducats } : {}),
			...(warframeMarket ? { warframeMarket } : {}),
		},
	};
}

function trimRelic(value: unknown): WfcdRelic | null {
	if (!isRecord(value)) return null;
	const { uniqueName, name, rewards } = value;
	if (!isWfcdRelicIdentity(uniqueName, name) || typeof uniqueName !== 'string' || typeof name !== 'string') return null;
	if (!Array.isArray(rewards) || !isWfcdRewardCount(rewards.length)) return null;
	const trimmedRewards: WfcdReward[] = [];
	for (const reward of rewards) {
		const trimmed = trimReward(reward);
		if (!trimmed) return null;
		trimmedRewards.push(trimmed);
	}
	const imageName = nonEmptyString(value.imageName);
	const relic: WfcdRelic = {
		uniqueName,
		name,
		vaulted: Boolean(value.vaulted),
		...(imageName ? { imageName } : {}),
		// 1.1276.6 flags 61 relics vaulted while still listing their drops, the Citrine ones among them.
		dropCount: Array.isArray(value.drops) ? value.drops.length : 0,
		rewards: trimmedRewards,
	};
	return hasOverlongString(relic) ? null : relic;
}

/** Null when the table is not an array or keeps a row count outside the floor. */
export function trimWfcdRelics(rows: unknown): { relics: WfcdRelic[]; dropped: number } | null {
	if (!Array.isArray(rows)) return null;
	const relics: WfcdRelic[] = [];
	for (const row of rows) {
		const relic = trimRelic(row);
		if (relic) relics.push(relic);
	}
	if (!isWfcdRelicRowCount(relics.length) || hasTooManyWfcdRewardNames(relics)) return null;
	return { relics, dropped: rows.length - relics.length };
}

/** Newest plain x.y.z release that is old enough, not deprecated and not above dist-tags.latest. */
export function pickWfcdRelease(packument: unknown, now: number, minAgeMs: number): WfcdRelease | null {
	if (!isRecord(packument) || !isRecord(packument.versions) || !isRecord(packument.time)) return null;
	const { versions, time } = packument;
	const tags = isRecord(packument['dist-tags']) ? packument['dist-tags'] : {};
	const latest = isWfcdVersion(tags.latest) ? tags.latest : null;

	let best: { version: string; publishedMs: number } | null = null;
	for (const [version, published] of Object.entries(time)) {
		if (!isWfcdVersion(version) || typeof published !== 'string') continue;
		const manifest = versions[version];
		if (!isRecord(manifest) || manifest.deprecated) continue;
		const publishedMs = Date.parse(published);
		if (!Number.isFinite(publishedMs) || now - publishedMs < minAgeMs) continue;
		if (latest && compareWfcdVersions(version, latest) > 0) continue;
		if (!best || compareWfcdVersions(version, best.version) > 0) best = { version, publishedMs };
	}
	return best ? { version: best.version, publishedAt: new Date(best.publishedMs).toISOString() } : null;
}

function parseStoredMeta(value: unknown): StoredDocMeta | null {
	if (!isRecord(value)) return null;
	const { version, publishedAt, generatedAt, count, relicsHash } = value;
	if (!isWfcdVersion(version)) return null;
	if (typeof publishedAt !== 'string' || typeof generatedAt !== 'string') return null;
	if (typeof count !== 'number' || !isWfcdRelicRowCount(count)) return null;
	return { version, publishedAt, generatedAt, count, ...(typeof relicsHash === 'string' ? { relicsHash } : {}) };
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function writeState(env: Env, checkedAt: number, seenVersion: string | null, docVersion: string | undefined): Promise<void> {
	const state = { checkedAt, ...(seenVersion && docVersion ? { seenVersion, docVersion } : {}) };
	await env.ITEM_META.put(WFCD_RELICS_STATE_KEY, JSON.stringify(state), { expirationTtl: STATE_TTL_SEC });
}

async function fetchText(url: string, timeoutMs: number, maxBytes: number): Promise<string | null> {
	try {
		return await withAbortTimeout(timeoutMs, async (signal) => {
			const response = await fetch(url, {
				headers: { 'user-agent': WORKER_UA, accept: 'application/json' },
				signal,
			});
			if (!response.ok) return null;
			return await readResponseText(response, maxBytes);
		});
	} catch {
		return null;
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

// Kept apart so the packument is garbage before the 8.8 MB relic table is fetched.
async function fetchNewestRelease(now: number, minAgeMs: number): Promise<{ release: WfcdRelease | null } | null> {
	const text = await fetchText(REGISTRY_URL, REGISTRY_TIMEOUT_MS, MAX_REGISTRY_BYTES);
	const packument = text == null ? null : parseJson(text);
	if (!isRecord(packument) || !isRecord(packument.versions) || !isRecord(packument.time)) return null;
	return { release: pickWfcdRelease(packument, now, minAgeMs) };
}

async function fetchTrimmedRelics(version: string): Promise<ReturnType<typeof trimWfcdRelics> | 'unavailable'> {
	const url = `https://cdn.jsdelivr.net/npm/@wfcd/items@${version}/data/json/Relics.json`;
	const text = await fetchText(url, DATA_TIMEOUT_MS, MAX_DATA_BYTES);
	if (text == null) return 'unavailable';
	return trimWfcdRelics(parseJson(text));
}

async function readStoredMeta(env: Env): Promise<StoredDocMeta | null> {
	const { value, metadata } = await env.ITEM_META.getWithMetadata(WFCD_RELICS_DOC_KEY, 'stream');
	if (!value) return null;
	await value.cancel();
	return parseStoredMeta(metadata);
}

function logFailure(error: 'wfcd_unavailable' | 'wfcd_invalid', source: 'registry' | 'jsdelivr'): void {
	logEvent({ type: 'cron', route: 'wfcd-relics:refresh', status: 204, error, source });
}

// Keep the last complete document if npm, jsDelivr or validation fails.
export async function refreshWfcdRelics(
	env: Env,
	options: { now?: number; force?: boolean } = {},
): Promise<'built' | 'unchanged' | 'skipped' | 'failed'> {
	const now = options.now ?? Date.now();
	const state = await getJsonFromKv(env.ITEM_META, WFCD_RELICS_STATE_KEY);
	if (!options.force) {
		const checkedAt = toFiniteNumber(state?.checkedAt) ?? 0;
		if (now - checkedAt < CHECK_INTERVAL_MS && checkedAt <= now) return 'skipped';
	}
	const stored = await readStoredMeta(env);
	// A remembered release only vouches for the doc it was compared with, even after a lost state write.
	const seenVersion = stored && isWfcdVersion(state?.seenVersion) && state.docVersion === stored.version ? state.seenVersion : null;
	const minAgeMs = getWorkerConfig(env).wfcdReleaseAgeHours * 60 * 60 * 1000;
	const newest = await fetchNewestRelease(now, minAgeMs);
	if (!newest) {
		logFailure('wfcd_unavailable', 'registry');
		return 'failed';
	}
	// Written once as the check ends, since KV answers 429 to a second write of one key within a
	// second. A failing relic table still waits for the next hourly check instead of every tick.
	const saveState = (seen: string | null) => writeState(env, now, seen, stored?.version);

	// The newest eligible release decides, so a release npm later deprecates or unpublishes gets replaced.
	const { release } = newest;
	if (!release || release.version === stored?.version || release.version === seenVersion) {
		await saveState(seenVersion);
		return 'unchanged';
	}

	const trimmed = await fetchTrimmedRelics(release.version);
	if (trimmed === 'unavailable') {
		logFailure('wfcd_unavailable', 'jsdelivr');
		await saveState(seenVersion);
		return 'failed';
	}
	if (!trimmed) {
		logFailure('wfcd_invalid', 'jsdelivr');
		await saveState(seenVersion);
		return 'failed';
	}

	// Most npm releases leave the relics alone; a new version would make every app download them again.
	const relicsHash = await sha256Hex(JSON.stringify(trimmed.relics));
	if (stored?.relicsHash === relicsHash && compareWfcdVersions(release.version, stored.version) > 0) {
		await saveState(release.version);
		return 'unchanged';
	}

	const generatedAt = new Date(now).toISOString();
	// `version` leads so the route can splice `ok` in without reparsing the doc.
	const body = JSON.stringify({ version: release.version, publishedAt: release.publishedAt, generatedAt, relics: trimmed.relics });
	const bytes = byteLength(body);
	if (bytes > WFCD_RELICS_MAX_BYTES) {
		logFailure('wfcd_invalid', 'jsdelivr');
		await saveState(seenVersion);
		return 'failed';
	}
	const metadata: StoredDocMeta = { ...release, generatedAt, count: trimmed.relics.length, relicsHash };
	await env.ITEM_META.put(WFCD_RELICS_DOC_KEY, body, { metadata });
	await saveState(null);
	logEvent({
		type: 'cron',
		route: 'wfcd-relics:refresh',
		status: 200,
		count: trimmed.relics.length,
		dropped: trimmed.dropped,
		bytes,
	});
	return 'built';
}

/** The stored doc as the exact response body, served without reparsing its 4.9 MB. */
export async function readWfcdRelicsBody(env: Env): Promise<{ version: string; body: string } | null> {
	const { value, metadata } = await env.ITEM_META.getWithMetadata(WFCD_RELICS_DOC_KEY, 'text');
	const meta = parseStoredMeta(metadata);
	if (!value || !meta || !value.startsWith(`{"version":${JSON.stringify(meta.version)},`)) return null;
	return { version: meta.version, body: `{"ok":true,${value.slice(1)}` };
}
