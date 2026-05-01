/**
 * statsTracker.ts — Tracks per-session and daily inventory stat deltas.
 *
 * Tracked fields per day:
 *   platDelta     — net PremiumCredits change (platinum)
 *   creditsDelta  — net RegularCredits change
 *   endoDelta     — net FusionPoints change (endo)
 *   ducatsDelta   — net Void Ducats change (MiscItems/PrimeBucks)
 *   relicsOpened  — number of relics consumed (LevelKeys total decrease)
 *   daysPlayed    — 1 if inventory data was received today, else 0
 */

import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { withScope } from "./logger";

const log = withScope("statsTracker");


// Single source of truth for DailyStatEntry and SessionStats.
// Re-exported so existing consumers importing from this module keep working.
import type { DailyStatEntry, SessionStats } from "../config/shared/statsTypes";


// Session baselines (set on first inventory update)
let _baselinePlat: number | null = null;
let _baselineCredits: number | null = null;
let _baselineEndo: number | null = null;
let _baselineDucats: number | null = null;
let _baselineAya: number | null = null;

// Latest absolute values
let _currentPlat: number | null = null;
let _currentCredits: number | null = null;
let _currentEndo: number | null = null;
let _currentDucats: number | null = null;
let _currentAya: number | null = null;

// Relic tracking: accumulate decreases in total LevelKeys count throughout the day
let _lastRelicTotal: number | null = null;
let _todayRelicsOpened = 0;
let _todayDateForRelics = ""; // tracks which day the relics counter belongs to
let _todayDailyTrades = 0;
let _todayDateForTrades = "";

// Resumed deltas from previous app sessions today.
// When the app restarts mid-day, loadHistory() captures the saved daily deltas
// so they can be added on top of the new session's baseline-relative deltas.
// This prevents _upsertToday() from overwriting accumulated daily totals with 0.
let _resumedPlatDelta = 0;
let _resumedCreditsDelta = 0;
let _resumedEndoDelta = 0;
let _resumedDucatsDelta = 0;
let _resumedAyaDelta = 0;

let _history: DailyStatEntry[] = [];
const HISTORY_MAX_DAYS = 90;

// Schema marker for the persisted history file. v2 = day keys are in the
// user's LOCAL timezone. v1 (and unversioned legacy files) used UTC.
const HISTORY_SCHEMA_VERSION = 2;
let _historySchemaVersion = HISTORY_SCHEMA_VERSION;


function _historyPath(): string {
  return path.join(app.getPath("userData"), "stats-history.json");
}

/**
 * Returns today's date as YYYY-MM-DD in the user's LOCAL timezone.
 * Previously used UTC (`toISOString().slice(0, 10)`), which meant users in
 * negative UTC offsets saw their evening play attributed to "tomorrow."
 * Schema v2 keys are local; legacy v1/unversioned entries remain keyed in UTC
 * and are left untouched — per-event timestamps aren't available, so the
 * migration can't faithfully re-attribute old aggregates.
 */
function _todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Look up an item's count inside the MiscItems inventory array. */
function _findMiscItemCount(data: Record<string, unknown>, itemType: string): number | null {
  const misc = Array.isArray(data.MiscItems) ? data.MiscItems as Array<Record<string, unknown>> : [];
  const entry = misc.find((e) => e.ItemType === itemType);
  return entry && typeof entry.ItemCount === "number" ? entry.ItemCount : null;
}

function _saveHistory(): void {
  try {
    // Wrap entries in a small envelope so the schema version travels with the
    // data. On load we still accept a bare-array legacy format for v1/untagged.
    const payload = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries: _history,
    };
    fs.writeFileSync(_historyPath(), JSON.stringify(payload, null, 2), "utf-8");
  } catch (err: unknown) {
    log.warn("[StatsTracker] Failed to save history:", String(err));
  }
}

function _upsertToday(): void {
  const today = _todayStr();

  const platDelta = _resumedPlatDelta +
    (_currentPlat !== null && _baselinePlat !== null ? _currentPlat - _baselinePlat : 0);
  const creditsDelta = _resumedCreditsDelta +
    (_currentCredits !== null && _baselineCredits !== null
      ? _currentCredits - _baselineCredits
      : 0);
  const endoDelta = _resumedEndoDelta +
    (_currentEndo !== null && _baselineEndo !== null ? _currentEndo - _baselineEndo : 0);
  const ducatsDelta = _resumedDucatsDelta +
    (_currentDucats !== null && _baselineDucats !== null
      ? _currentDucats - _baselineDucats
      : 0);
  const ayaDelta = _resumedAyaDelta +
    (_currentAya !== null && _baselineAya !== null ? _currentAya - _baselineAya : 0);

  const entry: DailyStatEntry = {
    date: today,
    platDelta,
    creditsDelta,
    endoDelta,
    ducatsDelta,
    ayaDelta,
    relicsOpened: _todayRelicsOpened,
    daysPlayed: 1,
    dailyTrades: _todayDailyTrades,
    ...((_currentPlat    !== null) ? { absPlat: _currentPlat } : {}),
    ...((_currentCredits !== null) ? { absCredits: _currentCredits } : {}),
    ...((_currentEndo    !== null) ? { absEndo: _currentEndo } : {}),
    ...((_currentDucats  !== null) ? { absDucats: _currentDucats } : {}),
    ...((_currentAya     !== null) ? { absAya: _currentAya } : {}),
  };

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


/**
 * Load persisted history from disk. Call once on app startup before registering IPC.
 */
export function loadHistory(): void {
  try {
    const raw = fs.readFileSync(_historyPath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    // Accept both the v1 legacy format (bare array) and the v2 envelope
    // ({ schemaVersion, entries }). Tag loaded data with whichever version
    // was on disk so we know whether to log a migration notice.
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
      const backFillDefaults: Pick<DailyStatEntry, "ducatsDelta" | "ayaDelta" | "relicsOpened" | "daysPlayed" | "dailyTrades"> = {
        ducatsDelta: 0,
        ayaDelta: 0,
        relicsOpened: 0,
        daysPlayed: 1,
        dailyTrades: 0,
      };
      _history = (entries as DailyStatEntry[]).map((e) => ({
        ...backFillDefaults,
        ...e,
      }));
      _historySchemaVersion = loadedVersion;
      if (loadedVersion < HISTORY_SCHEMA_VERSION) {
        log.log(
          `[StatsTracker] Migrating history schema v${loadedVersion} -> v${HISTORY_SCHEMA_VERSION} ` +
            `(day boundaries now local timezone; legacy UTC-keyed entries retained as-is).`,
        );
        // Persist the envelope + version so future loads don't re-log. Existing
        // entry date keys are intentionally preserved — without per-event
        // timestamps, re-attributing old aggregates is not possible.
        _saveHistory();
        _historySchemaVersion = HISTORY_SCHEMA_VERSION;
      }
      // Restore today's relic accumulator so app restarts don't reset the daily count to 0
      const today = _todayStr();
      const todayEntry = _history.find((e) => e.date === today);
      if (todayEntry && todayEntry.relicsOpened > 0) {
        _todayRelicsOpened = todayEntry.relicsOpened;
        _todayDateForRelics = today;
      }
      if (todayEntry && todayEntry.dailyTrades > 0) {
        _todayDailyTrades = todayEntry.dailyTrades;
        _todayDateForTrades = today;
      }
      // Resume accumulated deltas from today's saved entry so app restarts
      // don't overwrite the daily total with a fresh session baseline of 0.
      if (todayEntry) {
        _resumedPlatDelta = todayEntry.platDelta;
        _resumedCreditsDelta = todayEntry.creditsDelta;
        _resumedEndoDelta = todayEntry.endoDelta;
        _resumedDucatsDelta = todayEntry.ducatsDelta;
        _resumedAyaDelta = todayEntry.ayaDelta;
      }
      log.log(`[StatsTracker] Loaded ${_history.length} history entries`);
    }
  } catch {
    _history = [];
  }
}

/**
 * Call this whenever a new inventory payload is received (from file watch or initial load).
 * data is the raw (unwrapped) Warframe inventory JSON object.
 */
export function onInventoryData(data: Record<string, unknown>): void {
  const plat    = typeof data.PremiumCredits === "number" ? data.PremiumCredits : null;
  const credits = typeof data.RegularCredits === "number" ? data.RegularCredits : null;
  const endo    = typeof data.FusionPoints   === "number" ? data.FusionPoints   : null;
  // Ducats are stored as a MiscItem entry, not a top-level field
  const ducats  = _findMiscItemCount(data, "/Lotus/Types/Items/MiscItems/PrimeBucks");
  // PrimeTokens is the raw field name for Aya in the Warframe inventory JSON
  const aya     = typeof data.PrimeTokens    === "number" ? data.PrimeTokens    : null;

  // Relics (VoidProjection items) appear in LevelKeys for some inventory
  // export formats, but in modern Warframe exports they live in MiscItems.
  // We scan both arrays, counting only items whose ItemType path contains
  // "VoidProjection" or "/Lotus/Relics/" so we don't conflate mission keys
  // (e.g. DojoKey, TestKeyErisBoss) with actual void relics.
  const today = _todayStr();

  // Reset accumulator when the day rolls over
  if (_todayDateForRelics !== today) {
    _todayRelicsOpened = 0;
    _todayDateForRelics = today;
    _lastRelicTotal = null; // avoid a spurious spike across midnight
    // Reset resumed deltas and baselines for the new day
    _resumedPlatDelta = 0;
    _resumedCreditsDelta = 0;
    _resumedEndoDelta = 0;
    _resumedDucatsDelta = 0;
    _resumedAyaDelta = 0;
    _baselinePlat = null;
    _baselineCredits = null;
    _baselineEndo = null;
    _baselineDucats = null;
    _baselineAya = null;
  }
  if (_todayDateForTrades !== today) {
    _todayDailyTrades = 0;
    _todayDateForTrades = today;
  }

  const relicArrays: Array<Record<string, unknown>>[] = [
    Array.isArray(data.LevelKeys) ? (data.LevelKeys as Array<Record<string, unknown>>) : [],
    Array.isArray(data.MiscItems) ? (data.MiscItems as Array<Record<string, unknown>>) : [],
  ];

  function _isRelicEntry(e: Record<string, unknown>): boolean {
    const t = typeof e.ItemType === "string" ? e.ItemType : "";
    return /VoidProjection/i.test(t) || /\/Lotus\/Relics\//i.test(t);
  }

  const relicTotal = relicArrays.flat().reduce(
    (sum, e) => (_isRelicEntry(e) && typeof e.ItemCount === "number" ? sum + e.ItemCount : sum),
    0,
  );
  if (_lastRelicTotal !== null && relicTotal < _lastRelicTotal) {
    _todayRelicsOpened += _lastRelicTotal - relicTotal;
  }
  _lastRelicTotal = relicTotal;

  if (_baselinePlat    === null && plat    !== null) _baselinePlat    = plat;
  if (_baselineCredits === null && credits !== null) _baselineCredits = credits;
  if (_baselineEndo    === null && endo    !== null) _baselineEndo    = endo;
  if (_baselineDucats  === null && ducats  !== null) _baselineDucats  = ducats;
  if (_baselineAya     === null && aya     !== null) _baselineAya     = aya;

  _currentPlat    = plat;
  _currentCredits = credits;
  _currentEndo    = endo;
  _currentDucats  = ducats;
  _currentAya     = aya;

  _upsertToday();
}

/**
 * Increment today's trade counter by 1. Called by tradeTracker when a trade is detected.
 */
export function incrementTodayTrades(): void {
  const today = _todayStr();
  if (_todayDateForTrades !== today) {
    _todayDailyTrades = 0;
    _todayDateForTrades = today;
  }
  _todayDailyTrades++;
  _upsertToday();
}

/**
 * Returns the full daily history array (last HISTORY_MAX_DAYS entries).
 */
export function getHistory(): DailyStatEntry[] {
  return _history;
}

/**
 * Import daily history entries from an external source (e.g. the AlecaFrame JSON export).
 *
 * Expects entries that are already normalised to deltas (the StatsView renderer
 * pre-processes AlecaFrame's absolute values into deltas before calling this).
 * Existing local entries for the same date are **overwritten** by the imported data,
 * except for today's live-tracked entry which is always preserved.
 * Returns the count of newly added or updated entries.
 */
export function importHistory(raw: unknown[]): number {
  let imported = 0;
  const today = _todayStr();

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;

    // Resolve date field (YYYY-MM-DD)
    const date =
      typeof r.date === "string" ? r.date :
      typeof r.day  === "string" ? r.day  : null;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    // Never overwrite today's live-tracked entry
    if (date === today) continue;

    // Platinum delta (pre-processed; fall back to common field names)
    let platDelta = 0;
    if (typeof r.platDelta === "number") platDelta = r.platDelta;
    else if (typeof r.platinumDelta === "number") platDelta = r.platinumDelta;
    else if (typeof r.platGain === "number") platDelta = r.platGain;

    // Credits delta
    let creditsDelta = 0;
    if (typeof r.creditsDelta === "number") creditsDelta = r.creditsDelta;

    // Endo delta
    let endoDelta = 0;
    if (typeof r.endoDelta === "number") endoDelta = r.endoDelta;

    // Ducats delta (pre-processed from absolute by the renderer)
    let ducatsDelta = 0;
    if (typeof r.ducatsDelta === "number") ducatsDelta = r.ducatsDelta;

    // Aya delta (pre-processed from absolute by the renderer)
    let ayaDelta = 0;
    if (typeof r.ayaDelta === "number") ayaDelta = r.ayaDelta;

    // Relics opened (already a count per day in AlecaFrame; also stored as relicsOpened)
    let relicsOpened = 0;
    if (typeof r.relicsOpened === "number") relicsOpened = r.relicsOpened;
    else if (typeof r.relicOpened === "number") relicsOpened = r.relicOpened;

    // Daily trade count
    let dailyTrades = 0;
    if (typeof r.dailyTrades === "number") dailyTrades = r.dailyTrades;

    const daysPlayed = typeof r.daysPlayed === "number" ? r.daysPlayed : 1;

    const entry: DailyStatEntry = { date, platDelta, creditsDelta, endoDelta, ducatsDelta, ayaDelta, relicsOpened, daysPlayed, dailyTrades };

    // Store absolute values if provided (from AlecaFrame import)
    if (typeof r.absPlat    === "number") entry.absPlat    = r.absPlat;
    if (typeof r.absCredits === "number") entry.absCredits = r.absCredits;
    if (typeof r.absEndo    === "number") entry.absEndo    = r.absEndo;
    if (typeof r.absDucats  === "number") entry.absDucats  = r.absDucats;
    if (typeof r.absAya     === "number") entry.absAya     = r.absAya;

    const idx = _history.findIndex((e) => e.date === date);
    if (idx >= 0) {
      _history[idx] = entry;
    } else {
      _history.push(entry);
    }
    imported++;
  }

  if (imported > 0) {
    _history.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (_history.length > HISTORY_MAX_DAYS) {
      _history = _history.slice(-HISTORY_MAX_DAYS);
    }
    _saveHistory();
  }
  return imported;
}

/**
 * Returns current session delta stats.
 */
export function getCurrentSession(): SessionStats {
  const hasData =
    _currentPlat !== null ||
    _currentCredits !== null ||
    _currentEndo !== null ||
    _currentDucats !== null ||
    _currentAya !== null;
  return {
    platDelta: _resumedPlatDelta +
      (_currentPlat !== null && _baselinePlat !== null ? _currentPlat - _baselinePlat : 0),
    creditsDelta: _resumedCreditsDelta +
      (_currentCredits !== null && _baselineCredits !== null
        ? _currentCredits - _baselineCredits
        : 0),
    endoDelta: _resumedEndoDelta +
      (_currentEndo !== null && _baselineEndo !== null ? _currentEndo - _baselineEndo : 0),
    ducatsDelta: _resumedDucatsDelta +
      (_currentDucats !== null && _baselineDucats !== null
        ? _currentDucats - _baselineDucats
        : 0),
    ayaDelta: _resumedAyaDelta +
      (_currentAya !== null && _baselineAya !== null ? _currentAya - _baselineAya : 0),
    currentPlat:    _currentPlat,
    currentCredits: _currentCredits,
    currentEndo:    _currentEndo,
    currentDucats:  _currentDucats,
    currentAya:     _currentAya,
    hasData,
  };
}
