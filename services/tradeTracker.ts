/** Persist confirmed EE.log trades; inventory diffs produce unrelated false positives. */

import fs from "node:fs";
import { withScope } from "./logger";
import { userDataPath } from "./userDataPath";
import { writeFileAtomicSync } from "./atomicFile";
import * as statsTracker from "./statsTracker";
import { lookupTradedCatalogItem } from "./tradeItemName";
import { stripPlatformGlyphs, isLogFrameworkLine, stripDialogArgTail } from "./tradeLogSanitize";
import {
  applyLedgerPatch,
  eventYear,
  mergeIntoArchives,
  rotateOlderYears,
  selectLedgerEvents,
} from "./tradeLedgerStore";
import type {
  TradeType,
  TradeDirection,
  TradeItem,
  TradeEvent,
  TradeEventSource,
} from "../config/shared/statsTypes";
import type { LedgerEventPatch } from "../config/shared/tradeLedgerTypes";
import { TRADE_EVENT_SCHEMA_VERSION } from "../config/shared/tradeLedgerTypes";
import { MAX_TRADE_IMPORT_ROWS } from "../config/shared/statsImport";

const log = withScope("tradeTracker");

const MAX_EVENTS = 2000;
const MAX_ITEMS_PER_TRADE = 12;
// Stamped dialogs dedupe exactly; unstamped input uses the delivery window.
const DUPLICATE_WINDOW_MS = 30_000;

interface RecentTrade {
  at: number;
  stamps: Set<string>;
}

let _recentSignatures = new Map<string, RecentTrade>();
let _tradeLog: TradeEvent[] = [];

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function sanitizeTradeItem(value: unknown): TradeItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  // Repair entries written by older parsers.
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

function asTradeEventSource(value: unknown): TradeEventSource | null {
  return value === "live" || value === "gdpr" || value === "aleca" || value === "manual"
    ? value
    : null;
}

function boundedCurrency(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 10_000_000_000) return null;
  return Math.round(value);
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

  // Keep partially repairable trades.
  const items = event.items
    .map(sanitizeTradeItem)
    .filter((item): item is TradeItem => item != null);
  if (event.items.length > 0 && items.length === 0) {
    log.warn(
      `[TradeTracker] Dropping trade ${id} (${date}): all ${event.items.length} item(s) corrupt`,
    );
    return null;
  }
  if (items.length < event.items.length) {
    log.info(
      `[TradeTracker] Dropped ${event.items.length - items.length} corrupt item(s) from trade ${id}`,
    );
  }
  const rawPartner = boundedString(event.partner, 120);
  const partner = rawPartner ? stripPlatformGlyphs(rawPartner) || null : null;
  const source = asTradeEventSource(event.source);
  const sourceRecordId = boundedString(event.sourceRecordId, 180);
  const importBatchId = boundedString(event.importBatchId, 180);
  const editedAt = boundedString(event.editedAt, 64);
  const credits = boundedCurrency(event.credits);
  const tradeTax = boundedCurrency(event.tradeTax);
  return {
    id,
    date,
    type,
    platChange,
    items,
    ...(partner ? { partner } : {}),
    ...(event.wfmClosed === true ? { wfmClosed: true } : {}),
    // Legacy rows are stamped in place; their ids never change.
    schemaVersion: TRADE_EVENT_SCHEMA_VERSION,
    source: source ?? "live",
    ...(sourceRecordId ? { sourceRecordId } : {}),
    ...(importBatchId ? { importBatchId } : {}),
    ...(credits != null ? { credits } : {}),
    ...(tradeTax != null ? { tradeTax } : {}),
    ...(editedAt ? { editedAt } : {}),
  };
}

function _logPath(): string {
  return userDataPath("trade-log.json");
}

function _saveLog(): void {
  try {
    writeFileAtomicSync(_logPath(), JSON.stringify(_tradeLog, null, 2));
  } catch (err: unknown) {
    log.warn("[TradeTracker] Failed to save trade log:", String(err));
  }
}

/** Trim the live log by archiving the overflow instead of dropping it. Rows whose
 *  archive write failed stay live, so the cap can never destroy a trade. No slack
 *  above MAX_EVENTS: an older release slices the file to 2000 on load, so any row
 *  parked past the cap would be truncated unarchived after a rollback. */
function enforceLiveCap(): void {
  if (_tradeLog.length <= MAX_EVENTS) return;
  const overflow = _tradeLog.slice(MAX_EVENTS);
  const failed = new Set(mergeIntoArchives(overflow).map((event) => event.id));
  _tradeLog = _tradeLog.slice(0, MAX_EVENTS).concat(overflow.filter((e) => failed.has(e.id)));
}

/** Load the persisted trade log once at startup, then rotate finished years. */
export function loadTradeLog(): void {
  try {
    const raw = fs.readFileSync(_logPath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      _tradeLog = parsed
        .slice(0, MAX_TRADE_IMPORT_ROWS)
        .map(sanitizeTradeEvent)
        .filter((event): event is TradeEvent => event != null);
      log.info(`[TradeTracker] Loaded ${_tradeLog.length} trade events`);
    }
  } catch (err) {
    _tradeLog = [];
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.warn(`[TradeTracker] Failed to load trade log:`, err);
    }
  }

  // Startup path: a ledger problem must never stop the app from loading trades.
  try {
    const rotation = rotateOlderYears(_tradeLog, new Date().getUTCFullYear(), _logPath());
    const before = _tradeLog.length;
    _tradeLog = rotation.retained;
    enforceLiveCap();
    // Only rewrite when rotation moved rows; archives are already fsynced.
    if (rotation.rotated > 0 || _tradeLog.length !== before) _saveLog();
  } catch (err) {
    log.warn("[TradeTracker] Ledger rotation failed, keeping the live log intact:", err);
  }
}

/** Record a confirmed EE.log trade, or null when deduplicated. */
export function recordTradeFromLog(parsed: {
  partner: string;
  platChange: number;
  type: TradeType;
  items: Array<{ displayName: string; count: number; direction: TradeDirection }>;
  logStamp?: string | null;
}): TradeEvent | null {
  const now = Date.now();
  const partner = stripPlatformGlyphs(parsed.partner);

  const items: TradeItem[] = parsed.items.map((i) => {
    const displayName = stripPlatformGlyphs(i.displayName);
    const catalogItem = lookupTradedCatalogItem(displayName);
    // gameRef is DE's uniqueName, which is what the renderer joins the item
    // database on. The signature below still keys off the display name.
    return {
      internalName: catalogItem?.gameRef ?? "",
      displayName,
      count: i.count,
      direction: i.direction,
      ...(catalogItem?.url_name ? { wfmSlug: catalogItem.url_name } : {}),
      ...(catalogItem?.thumb ? { wfmThumb: catalogItem.thumb } : {}),
    };
  });

  const signature = [
    parsed.type,
    parsed.platChange,
    partner.toLowerCase(),
    ...items.map((i) => `${i.direction}:${i.displayName.toLowerCase()}:${i.count}`).sort(),
  ].join("|");
  for (const [key, seen] of _recentSignatures) {
    if (now - seen.at > DUPLICATE_WINDOW_MS) _recentSignatures.delete(key);
  }
  const stamp = typeof parsed.logStamp === "string" ? parsed.logStamp : null;
  const seen = _recentSignatures.get(signature);
  if (seen) {
    const distinctTrade = stamp != null && seen.stamps.size > 0 && !seen.stamps.has(stamp);
    if (!distinctTrade) return null;
    seen.stamps.add(stamp);
    seen.at = now;
  } else {
    _recentSignatures.set(signature, { at: now, stamps: new Set(stamp ? [stamp] : []) });
  }

  const id = `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 6)}`;

  const event: TradeEvent = {
    id,
    date: new Date().toISOString(),
    type: parsed.type,
    platChange: parsed.platChange,
    items,
    ...(partner ? { partner } : {}),
    schemaVersion: TRADE_EVENT_SCHEMA_VERSION,
    source: "live",
  };

  _tradeLog.unshift(event);
  enforceLiveCap();
  _saveLog();
  statsTracker.incrementTodayTrades();

  log.info(
    `[TradeTracker] EE.log trade: ${event.type} ${event.platChange}p with ${parsed.partner}, ${items.length} item(s)`,
  );

  return event;
}

/** Mark a trade's WFM order as automatically closed. */
export function markTradeWfmClosed(tradeId: string): void {
  const trade = _tradeLog.find((t) => t.id === tradeId);
  if (trade) {
    trade.wfmClosed = true;
    _saveLog();
  }
}

/** Import external trades by id and return the number added. */
export function importTradeLog(events: unknown[]): number {
  // addLedgerEvents caps, sanitizes and dedups over the archives too, so a
  // second import of the same export cannot resurrect rotated-out rows.
  return addLedgerEvents(events).applied;
}

/** The live log, newest first: this year plus any row whose archive write failed. */
export function getTradeLog(): TradeEvent[] {
  return _tradeLog;
}

/** Live rows plus every readable archive, newest first. */
export function getLedgerEvents(): TradeEvent[] {
  return selectLedgerEvents({}, _tradeLog).events;
}

/** The stats view's trade list: full history, bounded to the old live-log size. */
export function getRecentTradeLog(): TradeEvent[] {
  return selectLedgerEvents({}, _tradeLog).events.slice(0, MAX_EVENTS);
}

/** Patch a live row. Archived rows are patched through the ledger store. */
export function patchLiveTradeEvent(id: string, patch: LedgerEventPatch): boolean {
  const index = _tradeLog.findIndex((event) => event.id === id);
  if (index < 0) return false;
  _tradeLog[index] = applyLedgerPatch(_tradeLog[index], patch);
  _saveLog();
  return true;
}

export interface LedgerAppendResult {
  applied: number;
  skippedDuplicates: number;
}

/**
 * Write imported rows: this year live, older years into their archives. Rows
 * arrive unsanitized, so this is the one gate and dedup every import passes.
 */
export function addLedgerEvents(events: readonly unknown[]): LedgerAppendResult {
  const knownIds = new Set<string>();
  const knownRecords = new Set<string>();
  for (const event of selectLedgerEvents({}, _tradeLog).events) {
    knownIds.add(event.id);
    if (event.sourceRecordId) knownRecords.add(event.sourceRecordId);
  }

  const currentYear = new Date().getUTCFullYear();
  const fresh: TradeEvent[] = [];
  const toArchive: TradeEvent[] = [];
  let skippedDuplicates = 0;
  for (const raw of events.slice(0, MAX_TRADE_IMPORT_ROWS)) {
    const event = sanitizeTradeEvent(raw);
    if (!event) continue;
    if (
      knownIds.has(event.id) ||
      (event.sourceRecordId && knownRecords.has(event.sourceRecordId))
    ) {
      skippedDuplicates++;
      continue;
    }
    knownIds.add(event.id);
    if (event.sourceRecordId) knownRecords.add(event.sourceRecordId);
    const year = eventYear(event.date);
    if (year != null && year < currentYear) toArchive.push(event);
    else fresh.push(event);
  }

  const failed = new Set(mergeIntoArchives(toArchive).map((event) => event.id));
  const live = fresh.concat(toArchive.filter((event) => failed.has(event.id)));
  if (live.length > 0) {
    _tradeLog.push(...live);
    _tradeLog.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
    enforceLiveCap();
    _saveLog();
  }

  const applied = fresh.length + toArchive.length;
  if (applied > 0) log.info(`[TradeTracker] Applied ${applied} imported ledger row(s)`);
  return { applied, skippedDuplicates };
}

export function __resetTradeTrackerForTest(): void {
  _recentSignatures = new Map();
  _tradeLog = [];
}
