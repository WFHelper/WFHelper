import fs from "node:fs";
import { withScope } from "./logger";
import { userDataPath } from "./userDataPath";
import { writeFileAtomicSync } from "./atomicFile";
import {
  factionLabel,
  loadRegionTranslation,
  missionLabel,
  nodeLabel,
  type RegionTranslation,
} from "./regionNames";
import { normalizeErrorMessage } from "../config/shared/errors";
import { fetchWithTimeout } from "../config/shared/fetchWithTimeout";
import type {
  ArbiScheduleAlerts,
  ArbiScheduleEntry,
  ArbiSchedulePayload,
} from "../config/shared/arbiScheduleTypes";
import { arbiOccurrenceKey } from "../config/shared/arbiScheduleTypes";

const log = withScope("arbiSchedule");

const ARBYS_URL = "https://browse.wf/arbys.txt";
const FETCH_TIMEOUT_MS = 15_000;
/** Refresh cadence; the schedule is static future data, hourly matches the source site. */
const REFRESH_INTERVAL_MS = 60 * 60_000;
/** GET requests re-fetch when the cache is older than this. */
const STALE_AFTER_MS = 55 * 60_000;
const ALERT_CHECK_MS = 30_000;
const FIRST_FETCH_DELAY_MS = 5_000;
/** Keep entries from the still-active hour; drop older. */
const PAST_WINDOW_MS = 60 * 60_000;
const YEAR_MS = 365 * 24 * 60 * 60_000;
/** Alert-state keys older than this are pruned. */
const FIRED_RETENTION_MS = 2 * 60 * 60_000;

const NODE_ID_PATTERN = /^[A-Za-z0-9_./:-]{2,120}$/;
const OCCURRENCE_KEY_PATTERN = /^\d{10,17}:[A-Za-z0-9_./:-]{2,120}$/;
/** Lead of 0 would make the due-window [start, start) empty - floor at 1. */
const MIN_LEAD_MINUTES = 1;
const MAX_LEAD_MINUTES = 120;
const DEFAULT_LEAD_MINUTES = 5;
const STORE_SCHEMA_VERSION = 1;

export type { RegionTranslation };

interface ArbiScheduleRow {
  epoch: number;
  nodeId: string;
}

interface AlertStore {
  schemaVersion: number;
  occurrences: string[];
  favoriteNodes: string[];
  minutesBefore: number;
  firedKeys: string[];
}

interface DueAlert {
  entry: ArbiScheduleEntry;
  key: string;
}

export function parseArbysText(text: string): ArbiScheduleRow[] {
  const rows: ArbiScheduleRow[] = [];
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const [rawEpoch, rawNodeId] = line.split(",");
    if (!rawEpoch || !rawNodeId) continue;
    const epoch = Number(rawEpoch);
    const nodeId = rawNodeId.trim();
    if (!Number.isFinite(epoch) || epoch <= 0) continue;
    if (!NODE_ID_PATTERN.test(nodeId)) continue;
    rows.push({ epoch, nodeId });
  }
  return rows;
}

export function buildScheduleEntries(
  rows: ArbiScheduleRow[],
  translation: RegionTranslation,
): ArbiScheduleEntry[] {
  return rows.map((row) => {
    const region = translation.regions[row.nodeId];
    return {
      epochMs: row.epoch * 1000,
      nodeId: row.nodeId,
      node: nodeLabel(translation, row.nodeId),
      mission: missionLabel(translation, region),
      faction: factionLabel(region?.faction),
    };
  });
}

/** Site behavior: the still-active hour plus up to a year ahead, ascending. */
export function filterScheduleWindow(
  entries: ArbiScheduleEntry[],
  nowMs: number,
): ArbiScheduleEntry[] {
  return entries
    .filter((e) => e.epochMs >= nowMs - PAST_WINDOW_MS && e.epochMs <= nowMs + YEAR_MS)
    .sort((a, b) => a.epochMs - b.epochMs);
}

/** Return unfired alerts inside their lead window. */
export function computeDueAlerts(
  entries: ArbiScheduleEntry[],
  alerts: ArbiScheduleAlerts,
  firedKeys: ReadonlySet<string>,
  nowMs: number,
): DueAlert[] {
  const leadMs = Math.max(0, alerts.minutesBefore) * 60_000;
  const occurrences = new Set(alerts.occurrences);
  const favorites = new Set(alerts.favoriteNodes);
  const due: DueAlert[] = [];

  for (const entry of entries) {
    if (nowMs < entry.epochMs - leadMs || nowMs >= entry.epochMs) continue;
    const key = arbiOccurrenceKey(entry);
    if (firedKeys.has(key)) continue;
    if (!occurrences.has(key) && !favorites.has(entry.nodeId)) continue;
    due.push({ entry, key });
  }
  return due;
}

/** Drop alert-state keys whose occurrence is comfortably in the past. */
export function pruneAlertKeys(keys: string[], nowMs: number): string[] {
  return keys.filter((key) => {
    const epochMs = Number(key.split(":")[0]);
    return Number.isFinite(epochMs) && epochMs >= nowMs - FIRED_RETENTION_MS;
  });
}

interface ArbiScheduleDeps {
  /** Desktop toast dispatcher (already platform-guarded). */
  notify: (title: string, body: string) => void;
  /** Master world-notifications toggle. */
  notificationsEnabled: () => boolean;
}

let _deps: ArbiScheduleDeps | null = null;
let _entries: ArbiScheduleEntry[] = [];
let _fetchedAt: number | null = null;
let _store: AlertStore = {
  schemaVersion: STORE_SCHEMA_VERSION,
  occurrences: [],
  favoriteNodes: [],
  minutesBefore: DEFAULT_LEAD_MINUTES,
  firedKeys: [],
};
let _refreshTimer: ReturnType<typeof setInterval> | null = null;
let _alertTimer: ReturnType<typeof setInterval> | null = null;
let _firstFetchTimer: ReturnType<typeof setTimeout> | null = null;
let _fetchInFlight: Promise<void> | null = null;

function _cachePath(): string {
  return userDataPath("arbi-sched-cache.json");
}

function _storePath(): string {
  return userDataPath("arbi-sched-alerts.json");
}

function _loadCache(): void {
  try {
    if (!fs.existsSync(_cachePath())) return;
    const raw = JSON.parse(fs.readFileSync(_cachePath(), "utf8")) as {
      fetchedAt?: unknown;
      raw?: unknown;
    };
    if (typeof raw.raw !== "string" || !Number.isFinite(Number(raw.fetchedAt))) return;
    _entries = buildScheduleEntries(parseArbysText(raw.raw), loadRegionTranslation());
    _fetchedAt = Number(raw.fetchedAt);
    log.info(`loaded ${_entries.length} cached schedule entries`);
  } catch (err) {
    log.warn("failed to load schedule cache:", normalizeErrorMessage(err));
  }
}

function _saveCache(rawText: string): void {
  try {
    writeFileAtomicSync(_cachePath(), JSON.stringify({ fetchedAt: _fetchedAt, raw: rawText }));
  } catch (err) {
    log.warn("failed to save schedule cache:", normalizeErrorMessage(err));
  }
}

function _sanitizeStore(raw: unknown): AlertStore {
  const candidate = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strings = (value: unknown, pattern: RegExp): string[] =>
    Array.isArray(value)
      ? [...new Set(value.filter((v): v is string => typeof v === "string" && pattern.test(v)))]
      : [];
  const minutes = Number(candidate.minutesBefore);
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    occurrences: strings(candidate.occurrences, OCCURRENCE_KEY_PATTERN),
    favoriteNodes: strings(candidate.favoriteNodes, NODE_ID_PATTERN),
    minutesBefore:
      Number.isFinite(minutes) && minutes >= MIN_LEAD_MINUTES && minutes <= MAX_LEAD_MINUTES
        ? Math.floor(minutes)
        : DEFAULT_LEAD_MINUTES,
    firedKeys: strings(candidate.firedKeys, OCCURRENCE_KEY_PATTERN),
  };
}

function _loadStore(): void {
  try {
    if (!fs.existsSync(_storePath())) return;
    _store = _sanitizeStore(JSON.parse(fs.readFileSync(_storePath(), "utf8")));
  } catch (err) {
    log.warn("failed to load alert store:", normalizeErrorMessage(err));
  }
}

function _saveStore(): void {
  try {
    writeFileAtomicSync(_storePath(), JSON.stringify(_store, null, 2));
  } catch (err) {
    log.warn("failed to save alert store:", normalizeErrorMessage(err));
  }
}

function _pruneStore(nowMs: number): void {
  const occurrences = pruneAlertKeys(_store.occurrences, nowMs);
  const firedKeys = pruneAlertKeys(_store.firedKeys, nowMs);
  if (
    occurrences.length === _store.occurrences.length &&
    firedKeys.length === _store.firedKeys.length
  ) {
    return;
  }
  _store = { ..._store, occurrences, firedKeys };
  _saveStore();
}

async function _fetchSchedule(): Promise<void> {
  if (_fetchInFlight) return _fetchInFlight;
  _fetchInFlight = (async () => {
    try {
      const resp = await fetchWithTimeout(ARBYS_URL, FETCH_TIMEOUT_MS, {}, new Error("timeout"));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      const rows = parseArbysText(text);
      if (!rows.length) throw new Error("no valid arbitration entries");
      _entries = buildScheduleEntries(rows, loadRegionTranslation());
      _fetchedAt = Date.now();
      _saveCache(text);
      log.info(`fetched ${_entries.length} schedule entries`);
    } catch (err) {
      // Keep serving the previous (possibly disk-cached) schedule.
      log.warn("schedule fetch failed:", normalizeErrorMessage(err));
    } finally {
      _fetchInFlight = null;
    }
  })();
  return _fetchInFlight;
}

function getAlerts(): ArbiScheduleAlerts {
  return {
    occurrences: [..._store.occurrences],
    favoriteNodes: [..._store.favoriteNodes],
    minutesBefore: _store.minutesBefore,
  };
}

export async function getSchedulePayload(): Promise<ArbiSchedulePayload> {
  const stale = _fetchedAt === null || Date.now() - _fetchedAt > STALE_AFTER_MS;
  if (stale) await _fetchSchedule();
  return {
    entries: filterScheduleWindow(_entries, Date.now()),
    fetchedAt: _fetchedAt,
    alerts: getAlerts(),
  };
}

export function setOccurrenceAlert(key: string, enabled: boolean): ArbiScheduleAlerts | null {
  if (!OCCURRENCE_KEY_PATTERN.test(key)) return null;
  const has = _store.occurrences.includes(key);
  if (enabled && !has) _store.occurrences = [..._store.occurrences, key];
  if (!enabled && has) _store.occurrences = _store.occurrences.filter((k) => k !== key);
  _saveStore();
  return getAlerts();
}

export function setFavoriteNode(nodeId: string, enabled: boolean): ArbiScheduleAlerts | null {
  if (!NODE_ID_PATTERN.test(nodeId)) return null;
  const has = _store.favoriteNodes.includes(nodeId);
  if (enabled && !has) _store.favoriteNodes = [..._store.favoriteNodes, nodeId];
  if (!enabled && has) _store.favoriteNodes = _store.favoriteNodes.filter((n) => n !== nodeId);
  _saveStore();
  return getAlerts();
}

export function setLeadMinutes(minutes: number): ArbiScheduleAlerts | null {
  if (!Number.isFinite(minutes) || minutes < MIN_LEAD_MINUTES || minutes > MAX_LEAD_MINUTES) {
    return null;
  }
  _store = { ..._store, minutesBefore: Math.floor(minutes) };
  _saveStore();
  return getAlerts();
}

function _checkAlerts(): void {
  if (!_deps || _entries.length === 0) return;
  const nowMs = Date.now();
  _pruneStore(nowMs);

  // With the master toggle off, leave bells unconsumed - they fire (or get
  // pruned as stale) once notifications come back on.
  if (!_deps.notificationsEnabled()) return;

  const due = computeDueAlerts(_entries, getAlerts(), new Set(_store.firedKeys), nowMs);
  if (due.length === 0) return;

  for (const { entry, key } of due) {
    _store = {
      ..._store,
      firedKeys: [..._store.firedKeys, key],
      occurrences: _store.occurrences.filter((k) => k !== key),
    };

    const minutesLeft = Math.max(0, Math.round((entry.epochMs - nowMs) / 60_000));
    const timing = minutesLeft > 0 ? `starts in ~${minutesLeft} min` : "starting now";
    _deps.notify(
      "Arbitration Alert",
      `${entry.mission} on ${entry.node} vs ${entry.faction} - ${timing}.`,
    );
  }
  _saveStore();
}

export function initArbiSchedule(deps: ArbiScheduleDeps): void {
  _deps = deps;
  _loadStore();
  _loadCache();

  // Delay the first fetch so app startup never waits on the network.
  _firstFetchTimer = setTimeout(() => {
    _firstFetchTimer = null;
    void _fetchSchedule();
  }, FIRST_FETCH_DELAY_MS);
  _firstFetchTimer.unref?.();

  _refreshTimer = setInterval(() => {
    void _fetchSchedule();
  }, REFRESH_INTERVAL_MS);
  _refreshTimer.unref?.();

  _alertTimer = setInterval(() => {
    try {
      _checkAlerts();
    } catch (err) {
      log.warn("alert check failed:", normalizeErrorMessage(err));
    }
  }, ALERT_CHECK_MS);
  _alertTimer.unref?.();
}

export function shutdownArbiSchedule(): void {
  if (_refreshTimer) clearInterval(_refreshTimer);
  if (_alertTimer) clearInterval(_alertTimer);
  if (_firstFetchTimer) clearTimeout(_firstFetchTimer);
  _refreshTimer = null;
  _alertTimer = null;
  _firstFetchTimer = null;
  _deps = null;
}

/** Test-only: reset module state between cases. */
export function _resetArbiScheduleForTest(): void {
  shutdownArbiSchedule();
  _entries = [];
  _fetchedAt = null;
  _fetchInFlight = null;
  _store = {
    schemaVersion: STORE_SCHEMA_VERSION,
    occurrences: [],
    favoriteNodes: [],
    minutesBefore: DEFAULT_LEAD_MINUTES,
    firedKeys: [],
  };
}

/** Test-only: run one alert sweep synchronously. */
export function _checkAlertsForTest(): void {
  _checkAlerts();
}

/** Test-only: inject schedule entries without a network fetch. */
export function _setEntriesForTest(entries: ArbiScheduleEntry[], fetchedAt: number): void {
  _entries = entries;
  _fetchedAt = fetchedAt;
}
