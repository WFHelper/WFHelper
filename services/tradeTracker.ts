"use strict";

/**
 * tradeTracker.ts — Persists trade events detected from EE.log trade
 * confirmation dialogs.
 *
 * Trade detection is driven exclusively by EE.log parsing in eeLogMonitor.ts:
 *   1. "Are you sure you want to accept this trade?" dialog is buffered.
 *   2. "The trade was successful!" confirmation fires recordTradeFromLog().
 *
 * Inventory-diff based detection was removed because it produced false
 * positives (mission rewards, Baro, store purchases all change items + plat).
 *
 * Stored in %APPDATA%/warframe-companion/trade-log.json.
 */

const path = require("node:path") as typeof import("node:path");
const fs = require("node:fs") as typeof import("node:fs");
const { app } = require("electron") as typeof import("electron");
const { withScope } = require("./logger") as typeof import("./logger");
const statsTracker = require("./statsTracker") as typeof import("./statsTracker");

const log = withScope("tradeTracker");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TradeItem {
  internalName: string; // full ItemType path, e.g. "/Lotus/Types/Items/MiscItems/Aya"
  displayName: string;  // last path segment used as fallback display name
  count: number;        // absolute quantity that changed
  direction: "received" | "given";
}

export interface TradeEvent {
  id: string;              // unique — ISO timestamp + random suffix
  date: string;            // ISO datetime string
  type: "sale" | "purchase"; // sale = plat gained, purchase = plat spent
  platChange: number;      // always positive (absolute delta)
  items: TradeItem[];      // items that changed alongside the plat
  partner?: string;        // trading partner username (from EE.log)
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_EVENTS = 2000;
const MIN_COOLDOWN_MS = 10_000; // 10 s — suppresses duplicate events

// ── State ─────────────────────────────────────────────────────────────────────

let _lastEventTime = 0;
let _tradeLog: TradeEvent[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function _logPath(): string {
  return path.join(app.getPath("userData"), "trade-log.json");
}

function _saveLog(): void {
  try {
    fs.writeFileSync(_logPath(), JSON.stringify(_tradeLog, null, 2), "utf-8");
  } catch (err: unknown) {
    log.warn("[TradeTracker] Failed to save trade log:", String(err));
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load persisted trade log from disk. Call once on startup.
 */
export function loadTradeLog(): void {
  try {
    const raw = fs.readFileSync(_logPath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      _tradeLog = parsed as TradeEvent[];
      log.log(`[TradeTracker] Loaded ${_tradeLog.length} trade events`);
    }
  } catch {
    _tradeLog = [];
  }
}

/**
 * Record a trade detected from the EE.log trade confirmation dialog.
 * Returns the created TradeEvent (or null if suppressed by cooldown).
 */
export function recordTradeFromLog(parsed: {
  partner: string;
  platChange: number;
  type: "sale" | "purchase";
  items: Array<{ displayName: string; count: number; direction: "given" | "received" }>;
}): TradeEvent | null {
  const now = Date.now();
  if (now - _lastEventTime < MIN_COOLDOWN_MS) return null;

  const id = `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 6)}`;

  const items: TradeItem[] = parsed.items.map((i) => ({
    internalName: "",
    displayName: i.displayName,
    count: i.count,
    direction: i.direction,
  }));

  const event: TradeEvent = {
    id,
    date: new Date().toISOString(),
    type: parsed.type,
    platChange: parsed.platChange,
    items,
    ...(parsed.partner ? { partner: parsed.partner } : {}),
  };

  _tradeLog.unshift(event);
  if (_tradeLog.length > MAX_EVENTS) _tradeLog = _tradeLog.slice(0, MAX_EVENTS);
  _lastEventTime = now;
  _saveLog();
  statsTracker.incrementTodayTrades();

  log.log(
    `[TradeTracker] EE.log trade: ${event.type} ${event.platChange}p with ${parsed.partner}, ${items.length} item(s)`,
  );

  return event;
}

/**
 * Import trade events from an external source (e.g. AlecaFrame export).
 * Deduplicates by id. Returns the number of newly added events.
 */
export function importTradeLog(events: TradeEvent[]): number {
  const existingIds = new Set(_tradeLog.map((t) => t.id));
  let added = 0;
  for (const e of events) {
    if (!e.id || existingIds.has(e.id)) continue;
    _tradeLog.push(e);
    existingIds.add(e.id);
    added++;
  }
  if (added > 0) {
    // Sort newest first by date
    _tradeLog.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
    if (_tradeLog.length > MAX_EVENTS) _tradeLog = _tradeLog.slice(0, MAX_EVENTS);
    _saveLog();
    log.log(`[TradeTracker] Imported ${added} trade events`);
  }
  return added;
}

/**
 * Returns all persisted trade events (newest first).
 */
export function getTradeLog(): TradeEvent[] {
  return _tradeLog;
}
