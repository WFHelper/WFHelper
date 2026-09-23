import {
  MISSION_REWARDS_MAX_PAGE_SIZE,
  MISSION_REWARDS_MAX_QUERY_NAMES,
  type MissionRewardItem,
  type MissionRewardSummary,
  type MissionRewardsQuery,
  type MissionRewardsTotals,
} from "../config/shared/missionRewardsTypes";
import { createJsonCache } from "./jsonCache";

const HISTORY_VERSION = 2;
const NODE_ID = /^[A-Za-z0-9_]{1,64}$/;
const MISSION_TYPE_ID = /^MT_[A-Z_]{1,40}$/;
const MAX_ITEMS_PER_SUMMARY = 5_000;
const MAX_UNIQUE_NAME_CHARS = 256;
const MAX_QUERY_OFFSET = 10_000_000;

/** One mission as stored: items are [name index, count] pairs into the shared name table. */
interface StoredMission {
  id: string;
  endedAt: number;
  readAt: number;
  missionCount: number;
  missionType?: string;
  node?: string;
  credits: number;
  endo: number;
  items: number[];
}

interface StoredHistory {
  version: number;
  names: string[];
  /** Oldest first, so recording a mission only appends. */
  missions: StoredMission[];
}

interface HistoryPage {
  summaries: MissionRewardSummary[];
  matched: number;
  totals: MissionRewardsTotals;
  latest: MissionRewardSummary | null;
  recorded: number;
  missionTypes: string[];
  itemTypes: string[];
}

const historyCache = createJsonCache<StoredHistory>("mission-history.json", reviveHistory);
// The ten-entry list 2.x wrote before every mission was kept; read once to migrate.
const legacyCache = createJsonCache<MissionRewardSummary[]>(
  "mission-rewards.json",
  reviveLegacyHistory,
);

let names: string[] = [];
let nameIndex = new Map<string, number>();
let missions: StoredMission[] = [];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUniqueName(value: unknown): value is string {
  return (
    typeof value === "string" && value.startsWith("/") && value.length <= MAX_UNIQUE_NAME_CHARS
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

/** Validates everything but the items, which the two stored shapes encode differently. */
function reviveSummaryFields(raw: unknown): Omit<MissionRewardSummary, "items"> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { id, endedAt, readAt, missionCount, missionType, node, credits, endo } = raw as Record<
    string,
    unknown
  >;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
  if (!isFiniteNumber(endedAt) || !isFiniteNumber(readAt)) return null;
  if (!isPositiveInteger(missionCount)) return null;
  if (!isFiniteNumber(credits) || credits < 0 || !isFiniteNumber(endo) || endo < 0) return null;
  return {
    id,
    endedAt,
    readAt,
    missionCount,
    ...(typeof missionType === "string" && MISSION_TYPE_ID.test(missionType)
      ? { missionType }
      : {}),
    ...(typeof node === "string" && NODE_ID.test(node) ? { node } : {}),
    credits,
    endo,
  };
}

function reviveLegacyItems(raw: unknown): MissionRewardItem[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS_PER_SUMMARY) return null;
  const items: MissionRewardItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const { uniqueName, count } = entry as Record<string, unknown>;
    if (!isUniqueName(uniqueName) || !isPositiveInteger(count)) return null;
    items.push({ uniqueName, count });
  }
  return items;
}

function reviveLegacyHistory(parsed: unknown): MissionRewardSummary[] | null {
  if (!Array.isArray(parsed)) return null;
  const summaries: MissionRewardSummary[] = [];
  for (const entry of parsed) {
    const fields = reviveSummaryFields(entry);
    const items = fields && reviveLegacyItems((entry as Record<string, unknown>).items);
    if (fields && items) summaries.push({ ...fields, items });
  }
  return summaries;
}

function reviveStoredItems(
  raw: unknown,
  storedNames: readonly (string | null)[],
): MissionRewardItem[] | null {
  if (!Array.isArray(raw) || raw.length % 2 !== 0 || raw.length > MAX_ITEMS_PER_SUMMARY * 2) {
    return null;
  }
  const items: MissionRewardItem[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const at: unknown = raw[i];
    const count: unknown = raw[i + 1];
    const uniqueName = Number.isInteger(at) ? storedNames[at as number] : null;
    if (!uniqueName || !isPositiveInteger(count)) return null;
    items.push({ uniqueName, count });
  }
  return items;
}

/** Re-interns every valid mission, so unreferenced or malformed names drop out. */
function reviveHistory(parsed: unknown): StoredHistory | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!Number.isInteger(record.version) || (record.version as number) < HISTORY_VERSION) {
    return null;
  }
  if (!Array.isArray(record.names) || !Array.isArray(record.missions)) return null;
  const storedNames = record.names.map((name: unknown) => (isUniqueName(name) ? name : null));
  const revived: StoredHistory = { version: HISTORY_VERSION, names: [], missions: [] };
  const index = new Map<string, number>();
  for (const entry of record.missions) {
    const fields = reviveSummaryFields(entry);
    const items =
      fields && reviveStoredItems((entry as Record<string, unknown>).items, storedNames);
    if (!fields || !items) continue;
    const pairs: number[] = [];
    for (const item of items) {
      let at = index.get(item.uniqueName);
      if (at === undefined) {
        at = revived.names.length;
        revived.names.push(item.uniqueName);
        index.set(item.uniqueName, at);
      }
      pairs.push(at, item.count);
    }
    revived.missions.push({ ...fields, items: pairs });
  }
  return revived;
}

function intern(uniqueName: string): number {
  let at = nameIndex.get(uniqueName);
  if (at === undefined) {
    at = names.length;
    names.push(uniqueName);
    nameIndex.set(uniqueName, at);
  }
  return at;
}

function encode(summary: MissionRewardSummary): StoredMission {
  const { items, ...fields } = summary;
  const pairs: number[] = [];
  for (const item of items) pairs.push(intern(item.uniqueName), item.count);
  return { ...fields, items: pairs };
}

function decode(mission: StoredMission): MissionRewardSummary {
  const { items, ...fields } = mission;
  const decoded: MissionRewardItem[] = [];
  for (let i = 0; i < items.length; i += 2) {
    decoded.push({ uniqueName: names[items[i]], count: items[i + 1] });
  }
  return { ...fields, items: decoded };
}

function persist(): void {
  historyCache.write({ version: HISTORY_VERSION, names, missions });
}

function adopt(history: StoredHistory): void {
  names = history.names;
  nameIndex = new Map(names.map((name, at) => [name, at]));
  const ids = new Set<string>();
  missions = history.missions.filter((mission) => {
    if (ids.has(mission.id)) return false;
    ids.add(mission.id);
    return true;
  });
}

/** Loads every recorded mission; the legacy ten-entry file joins the new one on the next write. */
export function loadHistory(): void {
  const stored = historyCache.read();
  if (stored) {
    adopt(stored);
    return;
  }
  adopt({ version: HISTORY_VERSION, names: [], missions: [] });
  const legacy = legacyCache.read();
  if (!legacy || legacy.length === 0) return;
  missions = [...legacy].reverse().map(encode);
  adopt({ version: HISTORY_VERSION, names, missions });
}

export function unloadHistory(): void {
  names = [];
  nameIndex = new Map();
  missions = [];
}

export function appendSummary(summary: MissionRewardSummary): void {
  missions.push(encode(summary));
  persist();
}

export function recordedCountForTest(): number {
  return missions.length;
}

/** Newest first. */
export function recentSummaries(limit: number): MissionRewardSummary[] {
  const out: MissionRewardSummary[] = [];
  for (let i = missions.length - 1; i >= 0 && out.length < limit; i -= 1) {
    out.push(decode(missions[i]));
  }
  return out;
}

/** Untrusted renderer input to a bounded query; null when it is not one. */
export function normalizeMissionRewardsQuery(raw: unknown): MissionRewardsQuery | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { offset, limit, since, missionType, uniqueNames } = raw as Record<string, unknown>;
  if (!Number.isInteger(offset) || (offset as number) < 0) return null;
  if (!Number.isInteger(limit) || (limit as number) < 1) return null;
  const query: MissionRewardsQuery = {
    offset: Math.min(offset as number, MAX_QUERY_OFFSET),
    limit: Math.min(limit as number, MISSION_REWARDS_MAX_PAGE_SIZE),
  };
  if (isFiniteNumber(since)) query.since = since;
  if (typeof missionType === "string" && MISSION_TYPE_ID.test(missionType)) {
    query.missionType = missionType;
  }
  if (Array.isArray(uniqueNames)) {
    query.uniqueNames = uniqueNames
      .slice(0, MISSION_REWARDS_MAX_QUERY_NAMES)
      .filter((name): name is string => isUniqueName(name));
  }
  return query;
}

function receivedAny(mission: StoredMission, wanted: ReadonlySet<number>): boolean {
  for (let i = 0; i < mission.items.length; i += 2) {
    if (wanted.has(mission.items[i])) return true;
  }
  return false;
}

/** Newest first; totals cover every match, the summaries only the requested slice. */
export function queryHistory(query: MissionRewardsQuery): HistoryPage {
  let wanted: Set<number> | null = null;
  if (query.uniqueNames) {
    wanted = new Set();
    for (const name of query.uniqueNames) {
      const at = nameIndex.get(name);
      if (at !== undefined) wanted.add(at);
    }
  }

  const summaries: MissionRewardSummary[] = [];
  const itemCounts = new Map<number, number>();
  const missionTypes = new Set<string>();
  const totals: MissionRewardsTotals = {
    summaries: 0,
    missions: 0,
    credits: 0,
    endo: 0,
    items: [],
  };
  for (let i = missions.length - 1; i >= 0; i -= 1) {
    const mission = missions[i];
    if (mission.missionType) missionTypes.add(mission.missionType);
    if (query.since !== undefined && mission.endedAt < query.since) continue;
    if (query.missionType !== undefined && mission.missionType !== query.missionType) continue;
    if (wanted && !receivedAny(mission, wanted)) continue;
    if (totals.summaries >= query.offset && summaries.length < query.limit) {
      summaries.push(decode(mission));
    }
    totals.summaries += 1;
    totals.missions += mission.missionCount;
    totals.credits += mission.credits;
    totals.endo += mission.endo;
    for (let j = 0; j < mission.items.length; j += 2) {
      const at = mission.items[j];
      itemCounts.set(at, (itemCounts.get(at) ?? 0) + mission.items[j + 1]);
    }
  }
  totals.items = [...itemCounts]
    .map(([at, count]) => ({ uniqueName: names[at], count }))
    .sort((a, b) => b.count - a.count);

  return {
    summaries,
    matched: totals.summaries,
    totals,
    latest: missions.length > 0 ? decode(missions[missions.length - 1]) : null,
    recorded: missions.length,
    missionTypes: [...missionTypes].sort(),
    itemTypes: names.slice(),
  };
}
