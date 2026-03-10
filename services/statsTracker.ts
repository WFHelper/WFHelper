"use strict";

/**
 * statsTracker.ts — Tracks per-session and daily inventory stat deltas.
 *
 * Tracked fields per day:
 *   platDelta     — net PremiumCredits change (platinum)
 *   creditsDelta  — net RegularCredits change
 *   endoDelta     — net FusionPoints change (endo)
 *   ducatsDelta   — net DUCTCREDITS change (Void Ducats)
 *   relicsOpened  — number of relics consumed (LevelKeys total decrease)
 *   daysPlayed    — 1 if inventory data was received today, else 0
 */

const path = require("node:path") as typeof import("node:path");
const fs = require("node:fs") as typeof import("node:fs");
const { app } = require("electron") as typeof import("electron");
const { withScope } = require("./logger") as typeof import("./logger");

const log = withScope("statsTracker");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DailyStatEntry {
  date: string;          // "2026-03-10"
  platDelta: number;     // net plat change this session/day
  creditsDelta: number;
  endoDelta: number;
  ducatsDelta: number;   // net Void Ducat change
  relicsOpened: number;  // relics consumed (LevelKeys net decrease, ≥0)
  daysPlayed: number;    // 1 = played; 0 = no inventory data (imported gap)
}

export interface SessionStats {
  platDelta: number;
  creditsDelta: number;
  endoDelta: number;
  ducatsDelta: number;
  currentPlat: number | null;
  currentCredits: number | null;
  currentEndo: number | null;
  currentDucats: number | null;
  hasData: boolean;
}

// ── State ─────────────────────────────────────────────────────────────────────

// Session baselines (set on first inventory update)
let _baselinePlat: number | null = null;
let _baselineCredits: number | null = null;
let _baselineEndo: number | null = null;
let _baselineDucats: number | null = null;

// Latest absolute values
let _currentPlat: number | null = null;
let _currentCredits: number | null = null;
let _currentEndo: number | null = null;
let _currentDucats: number | null = null;

// Relic tracking: accumulate decreases in total LevelKeys count throughout the day
let _lastRelicTotal: number | null = null;
let _todayRelicsOpened = 0;
let _todayDateForRelics = ""; // tracks which day the relics counter belongs to

let _history: DailyStatEntry[] = [];
const HISTORY_MAX_DAYS = 90;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _historyPath(): string {
  return path.join(app.getPath("userData"), "stats-history.json");
}

function _todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function _saveHistory(): void {
  try {
    fs.writeFileSync(_historyPath(), JSON.stringify(_history, null, 2), "utf-8");
  } catch (err: unknown) {
    log.warn("[StatsTracker] Failed to save history:", String(err));
  }
}

function _upsertToday(): void {
  const today = _todayStr();

  const platDelta =
    _currentPlat !== null && _baselinePlat !== null ? _currentPlat - _baselinePlat : 0;
  const creditsDelta =
    _currentCredits !== null && _baselineCredits !== null
      ? _currentCredits - _baselineCredits
      : 0;
  const endoDelta =
    _currentEndo !== null && _baselineEndo !== null ? _currentEndo - _baselineEndo : 0;
  const ducatsDelta =
    _currentDucats !== null && _baselineDucats !== null
      ? _currentDucats - _baselineDucats
      : 0;

  const entry: DailyStatEntry = {
    date: today,
    platDelta,
    creditsDelta,
    endoDelta,
    ducatsDelta,
    relicsOpened: _todayRelicsOpened,
    daysPlayed: 1,
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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load persisted history from disk. Call once on app startup before registering IPC.
 */
export function loadHistory(): void {
  try {
    const raw = fs.readFileSync(_historyPath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Back-fill any fields missing from older schema so the shape is always complete
      _history = (parsed as DailyStatEntry[]).map((e) => ({
        ducatsDelta: 0,
        relicsOpened: 0,
        daysPlayed: 1,
        ...e,
      }));
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
  // DUCTCREDITS is the raw field name for Void Ducats in the Warframe inventory JSON
  const ducats  = typeof data.DUCTCREDITS    === "number" ? data.DUCTCREDITS    : null;

  // ── Relics opened tracking ───────────────────────────────────────────────
  // LevelKeys holds relic items; summing their ItemCount gives total relic inventory.
  // Each time the total decreases we know relics were opened (consumed).
  const today = _todayStr();

  // Reset accumulator when the day rolls over
  if (_todayDateForRelics !== today) {
    _todayRelicsOpened = 0;
    _todayDateForRelics = today;
    _lastRelicTotal = null; // avoid a spurious spike across midnight
  }

  const levelKeys = Array.isArray(data.LevelKeys)
    ? (data.LevelKeys as Array<Record<string, unknown>>)
    : [];
  const relicTotal = levelKeys.reduce(
    (sum, e) => sum + (typeof e.ItemCount === "number" ? e.ItemCount : 0),
    0,
  );
  if (_lastRelicTotal !== null && relicTotal < _lastRelicTotal) {
    _todayRelicsOpened += _lastRelicTotal - relicTotal;
  }
  _lastRelicTotal = relicTotal;

  // ── Session baselines (set only once, at first inventory load) ───────────
  if (_baselinePlat    === null && plat    !== null) _baselinePlat    = plat;
  if (_baselineCredits === null && credits !== null) _baselineCredits = credits;
  if (_baselineEndo    === null && endo    !== null) _baselineEndo    = endo;
  if (_baselineDucats  === null && ducats  !== null) _baselineDucats  = ducats;

  _currentPlat    = plat;
  _currentCredits = credits;
  _currentEndo    = endo;
  _currentDucats  = ducats;

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
 * Existing local entries for the same date are preserved.
 * Returns the count of newly merged entries.
 */
export function importHistory(raw: unknown[]): number {
  let imported = 0;
  const existingDates = new Set(_history.map((e) => e.date));

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;

    // Resolve date field (YYYY-MM-DD)
    const date =
      typeof r.date === "string" ? r.date :
      typeof r.day  === "string" ? r.day  : null;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    if (existingDates.has(date)) continue;

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

    // Relics opened (already a count per day in AlecaFrame; also stored as relicsOpened)
    let relicsOpened = 0;
    if (typeof r.relicsOpened === "number") relicsOpened = r.relicsOpened;
    else if (typeof r.relicOpened === "number") relicsOpened = r.relicOpened;

    const daysPlayed = typeof r.daysPlayed === "number" ? r.daysPlayed : 1;

    _history.push({ date, platDelta, creditsDelta, endoDelta, ducatsDelta, relicsOpened, daysPlayed });
    existingDates.add(date);
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
    _currentDucats !== null;
  return {
    platDelta:
      _currentPlat !== null && _baselinePlat !== null ? _currentPlat - _baselinePlat : 0,
    creditsDelta:
      _currentCredits !== null && _baselineCredits !== null
        ? _currentCredits - _baselineCredits
        : 0,
    endoDelta:
      _currentEndo !== null && _baselineEndo !== null ? _currentEndo - _baselineEndo : 0,
    ducatsDelta:
      _currentDucats !== null && _baselineDucats !== null
        ? _currentDucats - _baselineDucats
        : 0,
    currentPlat:   _currentPlat,
    currentCredits: _currentCredits,
    currentEndo:   _currentEndo,
    currentDucats: _currentDucats,
    hasData,
  };
}
