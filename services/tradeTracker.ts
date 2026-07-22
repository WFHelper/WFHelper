/**
 * Persists trade events detected from EE.log trade
 * confirmation dialogs.
 *
 * Trade detection is driven exclusively by EE.log parsing in eeLogMonitor.ts:
 *   1. "Are you sure you want to accept this trade?" dialog is buffered.
 *   2. "The trade was successful!" confirmation fires recordTradeFromLog().
 *
 * Inventory-diff based detection was removed because it produced false
 * positives (mission rewards, Baro, store purchases all change items + plat).
 *
 * Stored in %APPDATA%/WFHelper/trade-log.json.
 */

import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { withScope } from "./logger";
import { writeFileAtomicSync } from "./atomicFile";
import * as statsTracker from "./statsTracker";
import * as wfmCatalog from "./wfmCatalog";
import { stripPlatformGlyphs, isLogFrameworkLine, stripDialogArgTail } from "./tradeLogSanitize";
import type { TradeType, TradeDirection, TradeItem, TradeEvent } from "../config/shared/statsTypes";

const log = withScope("tradeTracker");

const MAX_EVENTS = 2000;
const MAX_IMPORT_EVENTS = 10_000;
const MAX_ITEMS_PER_TRADE = 12;
const MIN_COOLDOWN_MS = 10_000; // 10 s - suppresses duplicate events

let _lastEventTime = 0;
let _tradeLog: TradeEvent[] = [];

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function sanitizeTradeItem(value: unknown): TradeItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  // Repair names corrupted by pre-fix parser versions: platform glyphs,
  // Dialog arg tails, and raw EE.log lines recorded as items.
  const rawName = boundedString(item.displayName, 160);
  const displayName = rawName ? stripPlatformGlyphs(stripDialogArgTail(rawName)) || null : null;
  if (displayName && isLogFrameworkLine(displayName)) return null;
  const internalName =
    typeof item.internalName === "string" && item.internalName.length <= 240
      ? item.internalName
      : null;
  const count = Number(item.count);
  const direction =
    item.direction === "given" || item.direction === "received" ? item.direction : null;
  if (
    !displayName ||
    internalName == null ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 9999 ||
    !direction
  ) {
    return null;
  }

  const wfmSlug = boundedString(item.wfmSlug, 160);
  const wfmThumb = boundedString(item.wfmThumb, 2048);
  return {
    internalName,
    displayName,
    count,
    direction,
    ...(wfmSlug ? { wfmSlug } : {}),
    ...(wfmThumb ? { wfmThumb } : {}),
  };
}

function sanitizeTradeEvent(value: unknown): TradeEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const id = boundedString(event.id, 180);
  const date = boundedString(event.date, 64);
  const type =
    event.type === "sale" || event.type === "purchase" || event.type === "trade"
      ? event.type
      : null;
  const platChange = Number(event.platChange);
  if (!id || !date || !Number.isFinite(Date.parse(date)) || !type) return null;
  if (!Number.isInteger(platChange) || platChange < 0 || platChange > 10_000_000) return null;
  if (!Array.isArray(event.items) || event.items.length > MAX_ITEMS_PER_TRADE) return null;

  // Drop corrupt items (glyph-only names, raw log lines) but keep the event;
  // an event whose items were ALL corrupt is itself garbage - drop it.
  const items = event.items
    .map(sanitizeTradeItem)
    .filter((item): item is TradeItem => item != null);
  if (event.items.length > 0 && items.length === 0) return null;
  if (items.length < event.items.length) {
    log.info(`[TradeTracker] Dropped ${event.items.length - items.length} corrupt item(s) from trade ${id}`);
  }
  const rawPartner = boundedString(event.partner, 120);
  const partner = rawPartner ? stripPlatformGlyphs(rawPartner) || null : null;
  return {
    id,
    date,
    type,
    platChange,
    items,
    ...(partner ? { partner } : {}),
    ...(event.wfmClosed === true ? { wfmClosed: true } : {}),
  };
}

function _logPath(): string {
  return path.join(app.getPath("userData"), "trade-log.json");
}

function _saveLog(): void {
  try {
    writeFileAtomicSync(_logPath(), JSON.stringify(_tradeLog, null, 2));
  } catch (err: unknown) {
    log.warn("[TradeTracker] Failed to save trade log:", String(err));
  }
}

/**
 * Load persisted trade log from disk. Call once on startup.
 */
export function loadTradeLog(): void {
  try {
    const raw = fs.readFileSync(_logPath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      _tradeLog = parsed
        .slice(0, MAX_IMPORT_EVENTS)
        .map(sanitizeTradeEvent)
        .filter((event): event is TradeEvent => event != null)
        .slice(0, MAX_EVENTS);
      log.info(`[TradeTracker] Loaded ${_tradeLog.length} trade events`);
    }
  } catch (err) {
    _tradeLog = [];
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.warn(`[TradeTracker] Failed to load trade log:`, err);
    }
  }
}

/**
 * Record a trade detected from the EE.log trade confirmation dialog.
 * Returns the created TradeEvent (or null if suppressed by cooldown).
 */
export function recordTradeFromLog(parsed: {
  partner: string;
  platChange: number;
  type: TradeType;
  items: Array<{ displayName: string; count: number; direction: TradeDirection }>;
}): TradeEvent | null {
  const now = Date.now();
  if (now - _lastEventTime < MIN_COOLDOWN_MS) return null;

  const id = `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 6)}`;
  const partner = stripPlatformGlyphs(parsed.partner);

  const items: TradeItem[] = parsed.items.map((i) => {
    const displayName = stripPlatformGlyphs(i.displayName);
    const catalogItem =
      wfmCatalog.lookupByName(displayName) ||
      wfmCatalog.lookupByName(displayName.replace(/ Blueprint$/i, ""));
    return {
      internalName: "",
      displayName,
      count: i.count,
      direction: i.direction,
      ...(catalogItem?.url_name ? { wfmSlug: catalogItem.url_name } : {}),
      ...(catalogItem?.thumb ? { wfmThumb: catalogItem.thumb } : {}),
    };
  });

  const event: TradeEvent = {
    id,
    date: new Date().toISOString(),
    type: parsed.type,
    platChange: parsed.platChange,
    items,
    ...(partner ? { partner } : {}),
  };

  _tradeLog.unshift(event);
  if (_tradeLog.length > MAX_EVENTS) _tradeLog = _tradeLog.slice(0, MAX_EVENTS);
  _lastEventTime = now;
  _saveLog();
  statsTracker.incrementTodayTrades();

  log.info(
    `[TradeTracker] EE.log trade: ${event.type} ${event.platChange}p with ${parsed.partner}, ${items.length} item(s)`,
  );

  return event;
}

/**
 * Mark an existing trade event as having had its WFM order auto-closed.
 */
export function markTradeWfmClosed(tradeId: string): void {
  const trade = _tradeLog.find((t) => t.id === tradeId);
  if (trade) {
    trade.wfmClosed = true;
    _saveLog();
  }
}

/**
 * Import trade events from an external trade export.
 * Deduplicates by id. Returns the number of newly added events.
 */
export function importTradeLog(events: unknown[]): number {
  const existingIds = new Set(_tradeLog.map((t) => t.id));
  let added = 0;
  for (const raw of events.slice(0, MAX_IMPORT_EVENTS)) {
    const e = sanitizeTradeEvent(raw);
    if (!e) continue;
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
    log.info(`[TradeTracker] Imported ${added} trade events`);
  }
  return added;
}

/**
 * Returns all persisted trade events (newest first).
 */
export function getTradeLog(): TradeEvent[] {
  return _tradeLog;
}

export function __resetTradeTrackerForTest(): void {
  _lastEventTime = 0;
  _tradeLog = [];
}
