"use strict";

/**
 * tradeTracker.ts — Detects and persists trade events by diffing consecutive
 * raw inventory snapshots.
 *
 * A "trade event" is inferred when:
 *   1. PremiumCredits (plat) changes between two updates, AND
 *   2. At least one MiscItem or LevelKey count also changed (items moved)
 *
 * The first inventory update in a session sets the baseline; no event is
 * emitted then.  A 10-second minimum cooldown prevents duplicate events from
 * rapid file-watch re-fires.
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
  partner?: string;        // trading partner username (from EE.log, best-effort)
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_EVENTS = 2000;
const MIN_COOLDOWN_MS = 10_000; // 10 s — suppresses duplicate file-watch events

// ── State ─────────────────────────────────────────────────────────────────────

type RawEntry = { ItemType?: string; ItemCount?: number; [k: string]: unknown };

let _prevSnapshot: Record<string, unknown> | null = null;
let _lastEventTime = 0;
let _tradeLog: TradeEvent[] = [];
// Last username seen in EE.log trade initiation line; consumed on next trade event.
let _pendingPartner: string | null = null;
let _pendingPartnerAt = 0;
const PARTNER_TTL_MS = 120_000; // discard if no trade event within 2 min

// ── Helpers ───────────────────────────────────────────────────────────────────

function _logPath(): string {
  return path.join(app.getPath("userData"), "trade-log.json");
}

function _displayName(itemType: string): string {
  return itemType.split("/").filter(Boolean).pop() ?? itemType;
}

function _saveLog(): void {
  try {
    fs.writeFileSync(_logPath(), JSON.stringify(_tradeLog, null, 2), "utf-8");
  } catch (err: unknown) {
    log.warn("[TradeTracker] Failed to save trade log:", String(err));
  }
}

function _diffItems(
  prev: RawEntry[],
  curr: RawEntry[],
  _platWasGained: boolean,
): TradeItem[] {
  const prevMap = new Map<string, number>();
  const currMap = new Map<string, number>();

  for (const e of prev) {
    if (e.ItemType) prevMap.set(e.ItemType, typeof e.ItemCount === "number" ? e.ItemCount : 0);
  }
  for (const e of curr) {
    if (e.ItemType) currMap.set(e.ItemType, typeof e.ItemCount === "number" ? e.ItemCount : 0);
  }

  const result: TradeItem[] = [];
  const allKeys = new Set([...prevMap.keys(), ...currMap.keys()]);

  for (const key of allKeys) {
    const prevCount = prevMap.get(key) ?? 0;
    const currCount = currMap.get(key) ?? 0;
    const diff = currCount - prevCount;
    if (diff === 0) continue;

    // For a sale (plat gained): items we gave = decreased; items we received = increased (unlikely but possible for barter)
    // For a purchase (plat spent): items we received = increased; items we gave = decreased (unlikely)
    const direction: TradeItem["direction"] = diff > 0 ? "received" : "given";

    result.push({
      internalName: key,
      displayName: _displayName(key),
      count: Math.abs(diff),
      direction,
    });
  }

  return result;
}

function _toArray(val: unknown): RawEntry[] {
  return Array.isArray(val) ? (val as RawEntry[]) : [];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Notify the tracker of a trading partner username detected in EE.log.
 * The next recorded trade event will carry this name.
 */
export function setTradingPartner(username: string): void {
  _pendingPartner = username;
  _pendingPartnerAt = Date.now();
}

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
 * Call on every raw inventory update (same listener as statsTracker).
 * Compares with previous snapshot and emits a TradeEvent if a trade is detected.
 */
export function onInventoryData(data: Record<string, unknown>): void {
  if (_prevSnapshot === null) {
    _prevSnapshot = data;
    return;
  }

  const prevPlat =
    typeof _prevSnapshot.PremiumCredits === "number" ? _prevSnapshot.PremiumCredits : null;
  const currPlat = typeof data.PremiumCredits === "number" ? data.PremiumCredits : null;

  if (prevPlat === null || currPlat === null || prevPlat === currPlat) {
    _prevSnapshot = data;
    return;
  }

  const platDiff = currPlat - prevPlat;
  const now = Date.now();

  // Debounce: suppress events within 10 s of the last one
  if (now - _lastEventTime < MIN_COOLDOWN_MS) {
    _prevSnapshot = data;
    return;
  }

  const platWasGained = platDiff > 0;

  // Diff tradable item arrays
  const miscPrev = _toArray(_prevSnapshot.MiscItems);
  const miscCurr = _toArray(data.MiscItems);
  const relicPrev = _toArray(_prevSnapshot.LevelKeys);
  const relicCurr = _toArray(data.LevelKeys);

  const items: TradeItem[] = [
    ..._diffItems(miscPrev, miscCurr, platWasGained),
    ..._diffItems(relicPrev, relicCurr, platWasGained),
  ];

  // Only emit if items also moved (filters out store purchases, plat gifting, etc.)
  if (items.length === 0) {
    _prevSnapshot = data;
    return;
  }

  const id = `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 6)}`;

  // Consume the buffered EE.log partner name (if recent enough)
  let partner: string | undefined;
  if (_pendingPartner && Date.now() - _pendingPartnerAt < PARTNER_TTL_MS) {
    partner = _pendingPartner;
  }
  _pendingPartner = null;

  const event: TradeEvent = {
    id,
    date: new Date().toISOString(),
    type: platWasGained ? "sale" : "purchase",
    platChange: Math.abs(platDiff),
    items,
    ...(partner ? { partner } : {}),
  };

  _tradeLog.unshift(event); // newest first
  if (_tradeLog.length > MAX_EVENTS) _tradeLog = _tradeLog.slice(0, MAX_EVENTS);
  _lastEventTime = now;
  _saveLog();
  statsTracker.incrementTodayTrades();

  log.log(
    `[TradeTracker] Trade detected: ${event.type} +${event.platChange}p, ${items.length} item(s) changed`,
  );

  _prevSnapshot = data;
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
