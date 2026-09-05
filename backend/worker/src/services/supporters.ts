import { SUPPORTERS_KEY, SUPPORTER_EXCLUSIONS_KEY, LEGACY_PATREON_KEYS } from '../constants';
import { getWorkerConfig } from '../config';
import { isRecord } from '../utils';
import { logEvent } from './logging';
import type { Env, Supporter, SupporterTier, SupportersPayload } from '../types';
import { getJsonFromKv } from '../utils';

const DISCORD_API_ORIGIN = 'https://discord.com';
const MEMBERS_PAGE_SIZE = 1000;
// Caps on untrusted upstream and KV data.
const MAX_MEMBER_PAGES = 20;
const MAX_SUPPORTERS = 5000;
const MAX_SUPPORTER_NAME_LENGTH = 100;
const MAX_EXCLUSIONS = 1000;
const MAX_EXCLUSION_LENGTH = 200;

const TIER_RANK: Record<SupporterTier, number> = { basic: 1, big: 2, biggest: 3 };

type SupporterSyncResult =
	| { ok: true; status: 'synced'; count: number }
	| { ok: true; status: 'not_configured'; count: 0 }
	| { ok: false; error: string };

interface ParsedMember {
	id: string;
	name: string;
	tier: SupporterTier;
}

type MemberWalkResult = { status: 'ok'; members: ParsedMember[] } | { status: 'unauthorized' } | { status: 'error'; error: string };

function trimmedString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function sanitizeSupporterName(value: unknown): string {
	return trimmedString(value).replace(/\s+/g, ' ').slice(0, MAX_SUPPORTER_NAME_LENGTH);
}

function sanitizeSupporters(value: unknown): Supporter[] {
	if (!Array.isArray(value)) return [];
	const supporters: Supporter[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const name = sanitizeSupporterName(entry.name);
		const tier = entry.tier;
		if (!name) continue;
		if (tier !== 'basic' && tier !== 'big' && tier !== 'biggest') continue;
		supporters.push({ name, tier });
		if (supporters.length >= MAX_SUPPORTERS) break;
	}
	return supporters;
}

function sortSupporters(supporters: Supporter[]): Supporter[] {
	return [...supporters].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || a.name.localeCompare(b.name));
}

function sanitizeExclusionList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const entries: string[] = [];
	for (const entry of value) {
		const trimmed = trimmedString(entry).slice(0, MAX_EXCLUSION_LENGTH);
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		entries.push(trimmed);
		if (entries.length >= MAX_EXCLUSIONS) break;
	}
	return entries;
}

async function readExclusions(env: Env): Promise<string[]> {
	const raw = await env.ITEM_META.get(SUPPORTER_EXCLUSIONS_KEY);
	if (!raw) return [];
	try {
		return sanitizeExclusionList(JSON.parse(raw));
	} catch {
		return [];
	}
}

// Published names are whitespace-collapsed by sanitizeSupporterName, so the
// exclusion side must collapse the same way or a double-spaced entry never matches.
function exclusionNameKey(value: string): string {
	return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function excludeSupporters(members: ParsedMember[], exclusions: string[]): ParsedMember[] {
	if (exclusions.length === 0) return members;
	const byId = new Set(exclusions);
	const byName = new Set(exclusions.map(exclusionNameKey));
	return members.filter((member) => !byId.has(member.id) && !byName.has(exclusionNameKey(member.name)));
}

export async function readPublishedSupporters(env: Env): Promise<SupportersPayload> {
	const stored = await getJsonFromKv(env.ITEM_META, SUPPORTERS_KEY);
	const supporters = sanitizeSupporters(stored?.supporters);
	const updatedAt = trimmedString(stored?.updatedAt);
	if (supporters.length === 0) return { updatedAt: null, supporters: [] };
	return { updatedAt: updatedAt || null, supporters };
}

async function writeSupporters(env: Env, supporters: Supporter[], updatedAt: string): Promise<void> {
	await env.ITEM_META.put(SUPPORTERS_KEY, JSON.stringify({ updatedAt, supporters }));
}

// The retired Patreon pipeline left profile names and OAuth tokens in KV.
async function purgeLegacyPatreonKeys(env: Env): Promise<void> {
	for (const key of LEGACY_PATREON_KEYS) {
		try {
			await env.ITEM_META.delete(key);
		} catch {
			// Best-effort: a failed delete just leaves an unread orphan.
		}
	}
}

function membersUrl(guildId: string, after: string | null): string {
	const url = new URL(`${DISCORD_API_ORIGIN}/api/v10/guilds/${encodeURIComponent(guildId)}/members`);
	url.searchParams.set('limit', String(MEMBERS_PAGE_SIZE));
	if (after) url.searchParams.set('after', after);
	return url.toString();
}

function highestTier(roleIds: string[], roleTierMap: Record<string, SupporterTier>): SupporterTier | null {
	let best: SupporterTier | null = null;
	for (const roleId of roleIds) {
		const tier = roleTierMap[roleId];
		if (!tier) continue;
		if (!best || TIER_RANK[tier] > TIER_RANK[best]) best = tier;
	}
	return best;
}

function parseRoleIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => trimmedString(entry)).filter((roleId) => roleId.length > 0);
}

interface ParsedMembersPage {
	members: ParsedMember[];
	lastUserId: string | null;
	rawCount: number;
}

function parseMembersPage(payload: unknown, roleTierMap: Record<string, SupporterTier>): ParsedMembersPage | null {
	if (!Array.isArray(payload)) return null;

	const members: ParsedMember[] = [];
	let lastUserId: string | null = null;
	for (const entry of payload) {
		if (!isRecord(entry)) continue;
		const user = entry.user;
		if (!isRecord(user)) continue;
		const id = trimmedString(user.id);
		if (!id) continue;
		lastUserId = id;
		if (user.bot === true) continue;

		const tier = highestTier(parseRoleIds(entry.roles), roleTierMap);
		if (!tier) continue;

		const name = sanitizeSupporterName(entry.nick) || sanitizeSupporterName(user.global_name) || sanitizeSupporterName(user.username);
		if (!name) continue;

		members.push({ id, name, tier });
	}
	return { members, lastUserId, rawCount: payload.length };
}

async function walkMembers(guildId: string, botToken: string, roleTierMap: Record<string, SupporterTier>): Promise<MemberWalkResult> {
	const members: ParsedMember[] = [];
	const seenIds = new Set<string>();
	let after: string | null = null;

	for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
		let response: Response;
		try {
			response = await fetch(membersUrl(guildId, after), {
				headers: { authorization: `Bot ${botToken}`, accept: 'application/json' },
			});
		} catch {
			return { status: 'error', error: 'discord_unreachable' };
		}

		if (response.status === 401) return { status: 'unauthorized' };
		// 403 means the bot lacks the Server Members intent or guild access.
		if (!response.ok) return { status: 'error', error: `discord_http_${response.status}` };

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return { status: 'error', error: 'discord_invalid_payload' };
		}
		const parsed = parseMembersPage(payload, roleTierMap);
		if (!parsed) return { status: 'error', error: 'discord_invalid_payload' };

		for (const member of parsed.members) {
			if (seenIds.has(member.id)) continue;
			seenIds.add(member.id);
			members.push(member);
			if (members.length >= MAX_SUPPORTERS) return { status: 'ok', members };
		}

		if (parsed.rawCount < MEMBERS_PAGE_SIZE || !parsed.lastUserId) break;
		after = parsed.lastUserId;
	}

	return { status: 'ok', members };
}

export async function syncSupporters(env: Env, reason: 'cron' | 'manual'): Promise<SupporterSyncResult> {
	const { discordGuildId, discordRoleTierMap } = getWorkerConfig(env);
	const botToken = trimmedString(env.DISCORD_BOT_TOKEN);
	if (!discordGuildId || !botToken || Object.keys(discordRoleTierMap).length === 0) {
		// Unconfigured deploys are a no-op, not an error.
		logEvent({ type: reason === 'cron' ? 'cron' : 'admin', route: 'supporters:sync', status: 204 });
		return { ok: true, status: 'not_configured', count: 0 };
	}

	const walk = await walkMembers(discordGuildId, botToken, discordRoleTierMap);
	if (walk.status === 'unauthorized') {
		logEvent({ type: 'error', route: 'supporters:sync', status: 401, error: 'discord_unauthorized' });
		return { ok: false, error: 'discord_unauthorized' };
	}
	if (walk.status === 'error') {
		logEvent({ type: 'error', route: 'supporters:sync', status: 502, error: walk.error });
		return { ok: false, error: walk.error };
	}

	const exclusions = await readExclusions(env);
	const supporters = sortSupporters(excludeSupporters(walk.members, exclusions).map(({ name, tier }) => ({ name, tier })));
	await writeSupporters(env, supporters, new Date().toISOString());
	await purgeLegacyPatreonKeys(env);

	logEvent({ type: reason === 'cron' ? 'cron' : 'admin', route: 'supporters:sync', status: 200, count: supporters.length });
	return { ok: true, status: 'synced', count: supporters.length };
}

export async function replaceSupporterExclusions(env: Env, value: unknown): Promise<{ exclusions: number; removed: number }> {
	const exclusions = sanitizeExclusionList(value);
	await env.ITEM_META.put(SUPPORTER_EXCLUSIONS_KEY, JSON.stringify(exclusions));

	// Raw member ids are never retained, so an id exclusion applies at the next
	// sync; a name exclusion is applied to the published list immediately.
	const published = await readPublishedSupporters(env);
	const byName = new Set(exclusions.map(exclusionNameKey));
	const kept = published.supporters.filter((supporter) => !byName.has(exclusionNameKey(supporter.name)));
	const removed = published.supporters.length - kept.length;
	if (removed > 0) await writeSupporters(env, kept, published.updatedAt || new Date().toISOString());

	logEvent({ type: 'admin', route: 'supporters:exclusions', status: 200, count: exclusions.length });
	return { exclusions: exclusions.length, removed };
}
