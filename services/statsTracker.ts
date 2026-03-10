"use strict";

/**
 * statsTracker.ts — Tracks per-session and daily inventory stat deltas.
 *
 * Tracks PremiumCredits (plat), RegularCredits, and FusionPoints (endo).
 * On each inventory update, diffs against the session baseline and persists
 * a daily entry to %APPDATA%/warframe-companion/stats-history.json.
 */

const path = require("node:path") as typeof import("node:path");
const fs = require("node:fs") as typeof import("node:fs");
const { app } = require("electron") as typeof import("electron");
const { withScope } = require("./logger") as typeof import("./logger");

const log = withScope("statsTracker");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DailyStatEntry {
  date: string;        // "2026-03-10"
  platDelta: number;   // net plat change that session/day
  creditsDelta: number;
  endoDelta: number;
}

export interface SessionStats {
  platDelta: number;
  creditsDelta: number;
  endoDelta: number;
  currentPlat: number | null;
  currentCredits: number | null;
  currentEndo: number | null;
  hasData: boolean;
}

// ── State ─────────────────────────────────────────────────────────────────────

let _baselinePlat: number | null = null;
let _baselineCredits: number | null = null;
let _baselineEndo: number | null = null;

let _currentPlat: number | null = null;
let _currentCredits: number | null = null;
let _currentEndo: number | null = null;

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

  const entry: DailyStatEntry = { date: today, platDelta, creditsDelta, endoDelta };
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
      _history = parsed as DailyStatEntry[];
      log.log(`[StatsTracker] Loaded ${_history.length} history entries`);
    }
  } catch {
    _history = [];
  }
}

/**
 * Call this whenever a new inventory payload is received (from file watch or initial load).
 */
export function onInventoryData(data: Record<string, unknown>): void {
  const plat = typeof data.PremiumCredits === "number" ? data.PremiumCredits : null;
  const credits = typeof data.RegularCredits === "number" ? data.RegularCredits : null;
  const endo = typeof data.FusionPoints === "number" ? data.FusionPoints : null;

  // Set session baseline on first load
  if (_baselinePlat === null && plat !== null) _baselinePlat = plat;
  if (_baselineCredits === null && credits !== null) _baselineCredits = credits;
  if (_baselineEndo === null && endo !== null) _baselineEndo = endo;

  _currentPlat = plat;
  _currentCredits = credits;
  _currentEndo = endo;

  _upsertToday();
}

/**
 * Returns the full daily history array (last HISTORY_MAX_DAYS entries).
 */
export function getHistory(): DailyStatEntry[] {
  return _history;
}

/**
 * Import daily history entries from an external source (e.g. AlecaFrame JSON export).
 * Normalises common field-name variations from AlecaFrame's format:
 *   platinum / plat / platDelta / platinumDelta
 *   credits / creditsDelta / regularCredits
 *   endo / endoDelta / fusionPoints
 *
 * Existing local entries for the same date are preserved; imported entries only
 * fill in dates that don't already exist locally.
 * Returns the number of entries merged.
 */
export function importHistory(raw: unknown[]): number {
  let imported = 0;
  const existingDates = new Set(_history.map((e) => e.date));

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;

    // Resolve date field
    const date =
      typeof r.date === "string" ? r.date :
      typeof r.day  === "string" ? r.day  : null;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    // Skip dates we already have local data for
    if (existingDates.has(date)) continue;

    // Resolve platinum delta (may be a net field or earned−spent)
    let platDelta = 0;
    if (typeof r.platDelta === "number") platDelta = r.platDelta;
    else if (typeof r.platinumDelta === "number") platDelta = r.platinumDelta;
    else if (typeof r.platinum === "number") platDelta = r.platinum;
    else if (typeof r.plat === "number") platDelta = r.plat;
    else if (typeof r.platinumEarned === "number" || typeof r.platinumSpent === "number") {
      platDelta = (Number(r.platinumEarned) || 0) - (Number(r.platinumSpent) || 0);
    }

    // Resolve credits delta
    let creditsDelta = 0;
    if (typeof r.creditsDelta === "number") creditsDelta = r.creditsDelta;
    else if (typeof r.credits === "number") creditsDelta = r.credits;
    else if (typeof r.regularCredits === "number") creditsDelta = r.regularCredits;

    // Resolve endo delta
    let endoDelta = 0;
    if (typeof r.endoDelta === "number") endoDelta = r.endoDelta;
    else if (typeof r.endo === "number") endoDelta = r.endo;
    else if (typeof r.fusionPoints === "number") endoDelta = r.fusionPoints;

    _history.push({ date, platDelta, creditsDelta, endoDelta });
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
    _currentPlat !== null || _currentCredits !== null || _currentEndo !== null;
  return {
    platDelta:
      _currentPlat !== null && _baselinePlat !== null ? _currentPlat - _baselinePlat : 0,
    creditsDelta:
      _currentCredits !== null && _baselineCredits !== null
        ? _currentCredits - _baselineCredits
        : 0,
    endoDelta:
      _currentEndo !== null && _baselineEndo !== null ? _currentEndo - _baselineEndo : 0,
    currentPlat: _currentPlat,
    currentCredits: _currentCredits,
    currentEndo: _currentEndo,
    hasData,
  };
}
