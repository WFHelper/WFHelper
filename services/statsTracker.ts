import fs from "node:fs";
import { withScope } from "./logger";
import { userDataPath } from "./userDataPath";
import { writeFileAtomicSync } from "./atomicFile";
import {
  collectRelicInventoryCounts,
  totalRelicInventoryCount,
} from "../config/shared/relicCounts";
import { localDayKey } from "../config/shared/dayKey";
import {
  readStatResourceDay,
  writeLegacyStatFields,
  STAT_RESOURCES,
  STAT_RESOURCES_VERSION,
} from "../config/shared/statsTypes";

const log = withScope("statsTracker");

import type { DailyStatEntry, SessionStats, StatResourceDay } from "../config/shared/statsTypes";

// Per-resource session state, keyed by catalog id. A missing key means "no
// reading yet", which is what the old per-currency `null` baselines meant.
const _baselines = new Map<string, number>();
// Last known amount per resource. A payload that cannot report a resource
// leaves the previous reading in place instead of erasing the day's numbers.
const _currents = new Map<string, number>();
// Resumed daily deltas, so a restart cannot overwrite them with fresh baselines.
const _resumed = new Map<string, number>();
// Reused across updates so a poll never allocates a lookup per MiscItems scan.
const _miscScratch = new Map<string, number>();

// Relic tracking: accumulate decreases in total LevelKeys count throughout the day
let _lastRelicTotal: number | null = null;
let _todayRelicsOpened = 0;
let _todayDateForRelics = ""; // tracks which day the relics counter belongs to
let _todayDailyTrades = 0;
let _todayDateForTrades = "";

let _history: DailyStatEntry[] = [];
const HISTORY_MAX_DAYS = 90;

// Schema marker for the persisted history file. v2 = day keys are in the
// user's LOCAL timezone. v1 (and unversioned legacy files) used UTC.
const HISTORY_SCHEMA_VERSION = 2;

function _historyPath(): string {
  return userDataPath("stats-history.json");
}

function _todayStr(): string {
  return localDayKey(new Date());
}

/** Reads every tracked resource out of one inventory payload into `_currents`. */
function _readResourceAmounts(data: Record<string, unknown>): void {
  _miscScratch.clear();
  const hasMisc = Array.isArray(data.MiscItems);
  const misc = hasMisc ? (data.MiscItems as Array<Record<string, unknown>>) : [];
  // First entry wins, matching the single-pass `find` this replaced.
  for (const entry of misc) {
    const type = entry?.ItemType;
    const count = entry?.ItemCount;
    if (typeof type === "string" && typeof count === "number" && !_miscScratch.has(type)) {
      _miscScratch.set(type, count);
    }
  }
  for (const resource of STAT_RESOURCES) {
    // DE drops a MiscItems row once the count hits zero, so an absent row in a
    // payload that HAS the array reads as 0. Without the array nothing was
    // reported and the last known amount stands.
    const value =
      resource.source.kind === "field"
        ? _num(data[resource.source.field])
        : hasMisc
          ? (_miscScratch.get(resource.source.uniqueName) ?? 0)
          : null;
    if (value !== null) _currents.set(resource.id, value);
  }
}

function _deltaFor(id: string): number {
  const resumed = _resumed.get(id) ?? 0;
  const current = _currents.get(id);
  const baseline = _baselines.get(id);
  if (current === undefined || baseline === undefined) return resumed;
  return resumed + (current - baseline);
}

function _saveHistory(): void {
  try {
    // Wrap entries in a small envelope so the schema version travels with the
    // data. On load we still accept a bare-array legacy format for v1/untagged.
    const payload = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries: _history,
    };
    writeFileAtomicSync(_historyPath(), JSON.stringify(payload, null, 2));
  } catch (err: unknown) {
    log.warn("[StatsTracker] Failed to save history:", String(err));
  }
}

function _upsertToday(): void {
  const today = _todayStr();

  const resources: Record<string, StatResourceDay> = {};
  for (const resource of STAT_RESOURCES) {
    const delta = _deltaFor(resource.id);
    const current = _currents.get(resource.id);
    if (current === undefined && delta === 0) continue;
    resources[resource.id] = current === undefined ? { delta } : { delta, abs: current };
  }

  const entry: DailyStatEntry = {
    date: today,
    platDelta: 0,
    creditsDelta: 0,
    endoDelta: 0,
    ducatsDelta: 0,
    ayaDelta: 0,
    vitusDelta: 0,
    relicsOpened: _todayRelicsOpened,
    daysPlayed: 1,
    dailyTrades: _todayDailyTrades,
    resourcesVersion: STAT_RESOURCES_VERSION,
    resources,
  };
  for (const id of Object.keys(resources)) {
    writeLegacyStatFields(entry, id, resources[id]);
  }

  const idx = _history.findIndex((e) => e.date === today);
  if (idx >= 0) {
    _history[idx] = entry;
  } else {
    _history.push(entry);
    if (_history.length > HISTORY_MAX_DAYS) {
      _history = _history.slice(-HISTORY_MAX_DAYS);
    }
  }

  _saveHistory();
}

export function loadHistory(): void {
  try {
    const raw = fs.readFileSync(_historyPath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    // Track the loaded schema while accepting both the legacy array and v2 envelope.
    let entries: unknown = null;
    let loadedVersion = 1;
    if (Array.isArray(parsed)) {
      entries = parsed;
      loadedVersion = 1;
    } else if (parsed && typeof parsed === "object") {
      const env = parsed as { schemaVersion?: unknown; entries?: unknown };
      if (Array.isArray(env.entries)) {
        entries = env.entries;
        loadedVersion = typeof env.schemaVersion === "number" ? env.schemaVersion : 1;
      }
    }
    if (Array.isArray(entries)) {
      // Back-fill any fields missing from older schema so the shape is always complete
      const backFillDefaults: Pick<
        DailyStatEntry,
        "ducatsDelta" | "ayaDelta" | "vitusDelta" | "relicsOpened" | "daysPlayed" | "dailyTrades"
      > = {
        ducatsDelta: 0,
        ayaDelta: 0,
        vitusDelta: 0,
        relicsOpened: 0,
        daysPlayed: 1,
        dailyTrades: 0,
      };
      _history = (entries as DailyStatEntry[]).map((e) => ({
        ...backFillDefaults,
        ...e,
      }));
      if (loadedVersion < HISTORY_SCHEMA_VERSION) {
        log.info(
          `[StatsTracker] Migrating history schema v${loadedVersion} -> v${HISTORY_SCHEMA_VERSION} ` +
            `(day boundaries now local timezone; legacy UTC-keyed entries retained as-is).`,
        );
        // Preserve old date keys because aggregates lack timestamps for re-attribution.
        _saveHistory();
      }
      // Restore today's counters and deltas so app restarts don't reset them.
      // Claiming the day markers matters even at zero: the first inventory
      // update treats an unclaimed day as a rollover and would wipe the
      // deltas resumed just below.
      const today = _todayStr();
      const todayEntry = _history.find((e) => e.date === today);
      if (todayEntry) {
        _todayRelicsOpened = todayEntry.relicsOpened;
        _todayDateForRelics = today;
        _todayDailyTrades = todayEntry.dailyTrades;
        _todayDateForTrades = today;
        // Entries written before the resource map resume from their flat fields.
        _resumed.clear();
        for (const resource of STAT_RESOURCES) {
          const day = readStatResourceDay(todayEntry, resource.id);
          if (day && day.delta !== 0) _resumed.set(resource.id, day.delta);
        }
      }
      log.info(`[StatsTracker] Loaded ${_history.length} history entries`);
    }
  } catch (err) {
    _history = [];
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.warn(`[StatsTracker] Failed to load history:`, err);
    }
  }
}

export function onInventoryData(data: Record<string, unknown>): void {
  const today = _todayStr();

  // Reset accumulator when the day rolls over
  if (_todayDateForRelics !== today) {
    _todayRelicsOpened = 0;
    _todayDateForRelics = today;
    _lastRelicTotal = null; // avoid a spurious spike across midnight
    // Reset resumed deltas and baselines for the new day
    _resumed.clear();
    _baselines.clear();
  }
  if (_todayDateForTrades !== today) {
    _todayDailyTrades = 0;
    _todayDateForTrades = today;
  }

  const relicTotal = totalRelicInventoryCount(collectRelicInventoryCounts(data));
  if (_lastRelicTotal !== null && relicTotal < _lastRelicTotal) {
    _todayRelicsOpened += _lastRelicTotal - relicTotal;
  }
  _lastRelicTotal = relicTotal;

  _readResourceAmounts(data);
  // A baseline survives a payload that omits its resource, so a partial read
  // cannot re-baseline the day mid-session.
  for (const [id, value] of _currents) {
    if (!_baselines.has(id)) _baselines.set(id, value);
  }

  _upsertToday();
}

export function incrementTodayTrades(): void {
  const today = _todayStr();
  if (_todayDateForTrades !== today) {
    _todayDailyTrades = 0;
    _todayDateForTrades = today;
  }
  _todayDailyTrades++;
  _upsertToday();
}

export function getHistory(): DailyStatEntry[] {
  return _history;
}

const _num = (v: unknown): number | null => (typeof v === "number" ? v : null);

export function importHistory(raw: DailyStatEntry[]): number {
  let imported = 0;
  const today = _todayStr();
  const byDate = new Map(_history.map((entry) => [entry.date, entry]));

  for (const entry of raw) {
    if (entry.date === today) continue;
    byDate.set(entry.date, entry);
    imported++;
  }

  if (imported > 0) {
    _history = [...byDate.values()].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
    );
    if (_history.length > HISTORY_MAX_DAYS) {
      _history = _history.slice(-HISTORY_MAX_DAYS);
    }
    _saveHistory();
  }
  return imported;
}

export function getCurrentSession(): SessionStats {
  const resources: Record<string, { delta: number; current: number | null }> = {};
  for (const resource of STAT_RESOURCES) {
    resources[resource.id] = {
      delta: _deltaFor(resource.id),
      current: _currents.get(resource.id) ?? null,
    };
  }
  return {
    platDelta: resources.plat.delta,
    creditsDelta: resources.credits.delta,
    endoDelta: resources.endo.delta,
    ducatsDelta: resources.ducats.delta,
    ayaDelta: resources.aya.delta,
    vitusDelta: resources.vitus.delta,
    currentPlat: resources.plat.current,
    currentCredits: resources.credits.current,
    currentEndo: resources.endo.current,
    currentDucats: resources.ducats.current,
    currentAya: resources.aya.current,
    currentVitus: resources.vitus.current,
    resources,
    hasData: _currents.size > 0,
  };
}
