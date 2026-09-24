import {
  MISSION_REWARDS_MAX_PAGE_SIZE,
  MISSION_REWARDS_MAX_QUERY_NAMES,
  type MissionRewardItem,
  type MissionRewardSummary,
  type MissionRewardsQuery,
  type MissionRewardsTotals,
} from "../config/shared/missionRewardsTypes";
import { asRecord } from "../config/shared/objectValidation";
import { createJsonCache } from "./jsonCache";
import { withScope } from "./logger";

const log = withScope("missionRewardsHistory");

const HISTORY_VERSION = 2;
const MAX_MISSIONS = 10_000;
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

let names: string[] = [];
let nameIndex = new Map<string, number>();
let missions: StoredMission[] = [];
let writable = true;

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

function reviveSummaryFields(raw: unknown): Omit<MissionRewardSummary, "items"> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { id, endedAt, readAt, missionCount, missionType, node, credits, endo } = record;
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

/** Re-interns every valid mission, so unreferenced or malformed names drop out. A newer
 *  file revives to its version alone: this version can neither read nor replace it. */
function reviveHistory(parsed: unknown): StoredHistory | null {
  const record = asRecord(parsed);
  if (!record || !Number.isInteger(record.version)) return null;
  const version = record.version as number;
  if (version > HISTORY_VERSION) return { version, names: [], missions: [] };
  if (version !== HISTORY_VERSION) return null;
  if (!Array.isArray(record.names) || !Array.isArray(record.missions)) return null;
  const storedNames = record.names.map((name: unknown) => (isUniqueName(name) ? name : null));
  const revived: StoredHistory = { version: HISTORY_VERSION, names: [], missions: [] };
  const index = new Map<string, number>();
  const ids = new Set<string>();
  for (const entry of record.missions.slice(-MAX_MISSIONS)) {
    const fields = reviveSummaryFields(entry);
    const items =
      fields && reviveStoredItems((entry as Record<string, unknown>).items, storedNames);
    if (!fields || !items || ids.has(fields.id)) continue;
    ids.add(fields.id);
    const pairs: number[] = [];
    for (const item of items) pairs.push(intern(item.uniqueName, revived.names, index), item.count);
    revived.missions.push({ ...fields, items: pairs });
  }
  return revived;
}

function intern(uniqueName: string, table: string[], index: Map<string, number>): number {
  let at = index.get(uniqueName);
  if (at === undefined) {
    at = table.length;
    table.push(uniqueName);
    index.set(uniqueName, at);
  }
  return at;
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
  if (writable) historyCache.write({ version: HISTORY_VERSION, names, missions });
}

function adopt(history: StoredHistory): void {
  names = history.names;
  nameIndex = new Map(names.map((name, at) => [name, at]));
  missions = history.missions;
}

/** A missing file starts empty and an invalid one is moved aside first; a newer or
 *  unreadable file is left alone and this session's missions are not saved. */
export function loadHistory(): void {
  const loaded = historyCache.load();
  writable = true;
  if (loaded.status === "ok" && loaded.value.version === HISTORY_VERSION) {
    adopt(loaded.value);
    return;
  }
  adopt({ version: HISTORY_VERSION, names: [], missions: [] });
  if (loaded.status === "ok") {
    writable = false;
    log.warn(
      `mission-history.json has version ${loaded.value.version}, newer than ${HISTORY_VERSION}; ` +
        "missions of this session are not saved",
    );
  } else if (loaded.status === "unreadable") {
    writable = false;
    log.warn(
      `mission-history.json could not be read (${loaded.error}); ` +
        "missions of this session are not saved",
    );
  } else if (loaded.status === "invalid") {
    writable = historyCache.quarantine();
  }
}

export function unloadHistory(): void {
  names = [];
  nameIndex = new Map();
  missions = [];
  writable = true;
}

function dropOldest(): void {
  if (missions.length <= MAX_MISSIONS) return;
  const table: string[] = [];
  const index = new Map<string, number>();
  missions = missions.slice(-MAX_MISSIONS).map((mission) => ({
    ...mission,
    items: mission.items.map((value, at) =>
      at % 2 === 0 ? intern(names[value], table, index) : value,
    ),
  }));
  names = table;
  nameIndex = index;
}

/** Applies the file's own checks, so a restart shows the mission exactly as recorded. */
export function appendSummary(summary: MissionRewardSummary): void {
  const fields = reviveSummaryFields(summary);
  if (!fields) {
    log.warn(`Mission ${summary.id} not recorded: its summary fails validation`);
    return;
  }
  const pairs: number[] = [];
  for (const item of summary.items.slice(0, MAX_ITEMS_PER_SUMMARY)) {
    if (!isUniqueName(item.uniqueName) || !isPositiveInteger(item.count)) continue;
    pairs.push(intern(item.uniqueName, names, nameIndex), item.count);
  }
  missions.push({ ...fields, items: pairs });
  dropOldest();
  persist();
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
  const record = asRecord(raw);
  if (!record) return null;
  const { offset, limit, since, missionType, uniqueNames } = record;
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
  const totals: MissionRewardsTotals = { missions: 0, credits: 0, endo: 0, items: [] };
  let matched = 0;
  for (let i = missions.length - 1; i >= 0; i -= 1) {
    const mission = missions[i];
    if (mission.missionType) missionTypes.add(mission.missionType);
    if (query.since !== undefined && mission.endedAt < query.since) continue;
    if (query.missionType !== undefined && mission.missionType !== query.missionType) continue;
    if (wanted && !receivedAny(mission, wanted)) continue;
    if (matched >= query.offset && summaries.length < query.limit) {
      summaries.push(decode(mission));
    }
    matched += 1;
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
    matched,
    totals,
    latest: missions.length > 0 ? decode(missions[missions.length - 1]) : null,
    recorded: missions.length,
    missionTypes: [...missionTypes].sort(),
    itemTypes: names.slice(),
  };
}
