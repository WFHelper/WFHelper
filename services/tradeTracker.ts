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

import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { withScope } from "./logger";
import * as statsTracker from "./statsTracker";
import * as wfmCatalog from "./wfmCatalog";
import type { TradeType, TradeDirection, TradeItem, TradeEvent } from "../config/shared/statsTypes";

const log = withScope("tradeTracker");

const MAX_EVENTS = 2000;
const MIN_COOLDOWN_MS = 10_000; // 10 s — suppresses duplicate events

let _lastEventTime = 0;
let _tradeLog: TradeEvent[] = [];


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


/**
 * Load persisted trade log from disk. Call once on startup.
 */
export function loadTradeLog(): void {
  try {
    const raw = fs.readFileSync(_logPath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      _tradeLog = parsed as TradeEvent[];
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

  const items: TradeItem[] = parsed.items.map((i) => {
    const catalogItem = wfmCatalog.lookupByName(i.displayName)
      || wfmCatalog.lookupByName(i.displayName.replace(/ Blueprint$/i, ""));
    return {
      internalName: "",
      displayName: i.displayName,
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
    ...(parsed.partner ? { partner: parsed.partner } : {}),
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
