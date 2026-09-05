/** Yearly trade archives under <userData>/trade-ledger plus one read surface
 *  over the live log and those archives. A year that fails to load is reported,
 *  never thrown and never rewritten, so a corrupt file cannot eat its data. */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { writeFileAtomicSync } from "./atomicFile";
import { withScope } from "./logger";
import { userDataPath } from "./userDataPath";
import { toLocalDayKey } from "../config/shared/dayKey";
import { normalizeErrorMessage } from "../config/shared/errors";
import type { TradeEvent, TradeItem } from "../config/shared/statsTypes";
import type { LedgerEventPatch, LedgerQuery, LedgerPage } from "../config/shared/tradeLedgerTypes";
import { LEDGER_QUERY_MAX_LIMIT } from "../config/shared/tradeLedgerTypes";

const log = withScope("tradeLedgerStore");

const LEDGER_DIR = "trade-ledger";
const BACKUP_DIR = "backup";
const MANIFEST_FILE = "manifest.json";
const MANIFEST_SCHEMA_VERSION = 1;
/** Guard against a pathological archive; real years are orders of magnitude smaller. */
const MAX_ARCHIVE_EVENTS = 200_000;
const MAX_ITEMS_PER_TRADE = 12;
const EARLIEST_YEAR = 2012;

interface ArchiveRead {
  ok: boolean;
  events: TradeEvent[];
}

interface LedgerManifest {
  schemaVersion: number;
  years: Record<string, { count: number; updatedAt: string }>;
  liveBackup?: { file: string; at: string };
}

interface CachedArchive {
  key: string;
  events: TradeEvent[];
}

let _cache = new Map<number, CachedArchive>();

function ledgerDir(): string {
  return userDataPath(LEDGER_DIR);
}

function archivePath(year: number): string {
  return path.join(ledgerDir(), `${year}.json.gz`);
}

function manifestPath(): string {
  return path.join(ledgerDir(), MANIFEST_FILE);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Year from an ISO date, or null when the row carries an unusable date. */
export function eventYear(date: string): number | null {
  const prefix = /^(\d{4})-\d{2}-\d{2}/.exec(date);
  const year = prefix ? Number(prefix[1]) : new Date(date).getUTCFullYear();
  if (!Number.isInteger(year) || year < EARLIEST_YEAR || year > 9999) return null;
  return year;
}

// Archives only ever receive rows the tracker already sanitized, so this is a
// structural revive against disk corruption, not a second repair pass.
function reviveArchivedEvent(value: unknown): TradeEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const { id, date, type, platChange } = raw;
  if (typeof id !== "string" || !id || id.length > 180) return null;
  if (typeof date !== "string" || !Number.isFinite(Date.parse(date))) return null;
  if (type !== "sale" && type !== "purchase" && type !== "trade") return null;
  if (typeof platChange !== "number" || !Number.isFinite(platChange) || platChange < 0) return null;
  if (!Array.isArray(raw.items) || raw.items.length > MAX_ITEMS_PER_TRADE) return null;

  const items: TradeItem[] = [];
  for (const entry of raw.items) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const displayName = typeof item.displayName === "string" ? item.displayName : "";
    const count = Number(item.count);
    const direction = item.direction === "received" ? "received" : "given";
    if (!displayName || !Number.isInteger(count) || count < 1) continue;
    items.push({
      internalName: typeof item.internalName === "string" ? item.internalName : "",
      displayName,
      count,
      direction,
      ...(typeof item.wfmSlug === "string" ? { wfmSlug: item.wfmSlug } : {}),
      ...(typeof item.wfmThumb === "string" ? { wfmThumb: item.wfmThumb } : {}),
    });
  }

  const optionalString = (key: string, max: number): string | null => {
    const val = raw[key];
    return typeof val === "string" && val.length > 0 && val.length <= max ? val : null;
  };
  const optionalNumber = (key: string): number | null => {
    const val = raw[key];
    return typeof val === "number" && Number.isFinite(val) ? val : null;
  };
  const partner = optionalString("partner", 120);
  const source = raw.source;
  const sourceRecordId = optionalString("sourceRecordId", 180);
  const importBatchId = optionalString("importBatchId", 180);
  const editedAt = optionalString("editedAt", 64);
  const credits = optionalNumber("credits");
  const tradeTax = optionalNumber("tradeTax");
  const schemaVersion = optionalNumber("schemaVersion");

  return {
    id,
    date,
    type,
    platChange: Math.round(platChange),
    items,
    ...(partner ? { partner } : {}),
    ...(raw.wfmClosed === true ? { wfmClosed: true } : {}),
    ...(schemaVersion != null ? { schemaVersion } : {}),
    ...(source === "live" || source === "gdpr" || source === "aleca" || source === "manual"
      ? { source }
      : {}),
    ...(sourceRecordId ? { sourceRecordId } : {}),
    ...(importBatchId ? { importBatchId } : {}),
    ...(credits != null ? { credits } : {}),
    ...(tradeTax != null ? { tradeTax } : {}),
    ...(editedAt ? { editedAt } : {}),
  };
}

function readManifest(): LedgerManifest {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath(), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const raw = parsed as Record<string, unknown>;
      const years =
        raw.years && typeof raw.years === "object" && !Array.isArray(raw.years)
          ? (raw.years as LedgerManifest["years"])
          : {};
      const backup = raw.liveBackup;
      const liveBackup =
        backup &&
        typeof backup === "object" &&
        typeof (backup as { file?: unknown }).file === "string"
          ? (backup as LedgerManifest["liveBackup"])
          : undefined;
      return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        years,
        ...(liveBackup ? { liveBackup } : {}),
      };
    }
  } catch {
    /* missing or unreadable manifest rebuilds from the archives on disk */
  }
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, years: {} };
}

function writeManifest(manifest: LedgerManifest): void {
  try {
    ensureDir(ledgerDir());
    writeFileAtomicSync(manifestPath(), JSON.stringify(manifest, null, 2));
  } catch (err) {
    log.warn("[Ledger] Failed to write manifest:", normalizeErrorMessage(err));
  }
}

function listArchiveYears(): number[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(ledgerDir());
  } catch {
    return [];
  }
  const years: number[] = [];
  for (const name of entries) {
    const match = /^(\d{4})\.json\.gz$/.exec(name);
    if (!match) continue;
    const year = Number(match[1]);
    if (year >= EARLIEST_YEAR && year <= 9999) years.push(year);
  }
  return years.sort((a, b) => a - b);
}

/** Read one year. `ok:false` means the file exists but could not be decoded. */
function readArchiveYear(year: number): ArchiveRead {
  const file = archivePath(year);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true, events: [] };
    log.warn(`[Ledger] Cannot stat archive ${year}:`, normalizeErrorMessage(err));
    return { ok: false, events: [] };
  }

  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = _cache.get(year);
  if (cached && cached.key === key) return { ok: true, events: cached.events };

  try {
    const parsed: unknown = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf-8"));
    if (!Array.isArray(parsed)) throw new Error("archive root is not an array");
    const events = parsed
      .slice(0, MAX_ARCHIVE_EVENTS)
      .map(reviveArchivedEvent)
      .filter((event): event is TradeEvent => event != null);
    _cache.set(year, { key, events });
    return { ok: true, events };
  } catch (err) {
    log.warn(`[Ledger] Archive ${year} is unreadable:`, normalizeErrorMessage(err));
    return { ok: false, events: [] };
  }
}

function writeArchiveYear(year: number, events: TradeEvent[]): boolean {
  try {
    ensureDir(ledgerDir());
    const ordered = sortNewestFirst(events).slice(0, MAX_ARCHIVE_EVENTS);
    writeFileAtomicSync(archivePath(year), zlib.gzipSync(Buffer.from(JSON.stringify(ordered))));
    _cache.delete(year);
    const manifest = readManifest();
    manifest.years[String(year)] = { count: ordered.length, updatedAt: new Date().toISOString() };
    writeManifest(manifest);
    return true;
  } catch (err) {
    log.warn(`[Ledger] Failed to write archive ${year}:`, normalizeErrorMessage(err));
    return false;
  }
}

function sortNewestFirst(events: TradeEvent[]): TradeEvent[] {
  return [...events].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Copy the live trade log aside once, before any rotation rewrites it. */
function ensureLiveLogBackup(liveLogPath: string): boolean {
  const manifest = readManifest();
  const existing = manifest.liveBackup;
  const backupDir = path.join(ledgerDir(), BACKUP_DIR);
  if (existing && fs.existsSync(path.join(backupDir, existing.file))) return true;
  try {
    if (!fs.existsSync(liveLogPath)) return true;
    ensureDir(backupDir);
    const at = new Date();
    const file = `trade-log-${at.toISOString().replace(/[:.]/g, "-")}.json`;
    fs.copyFileSync(liveLogPath, path.join(backupDir, file));
    manifest.liveBackup = { file, at: at.toISOString() };
    writeManifest(manifest);
    log.info(`[Ledger] Backed up the live trade log to ${LEDGER_DIR}/${BACKUP_DIR}/${file}`);
    return true;
  } catch (err) {
    log.warn("[Ledger] Live trade log backup failed:", normalizeErrorMessage(err));
    return false;
  }
}

function groupByYear(events: TradeEvent[]): Map<number, TradeEvent[]> {
  const byYear = new Map<number, TradeEvent[]>();
  for (const event of events) {
    const year = eventYear(event.date);
    if (year == null) continue;
    const bucket = byYear.get(year);
    if (bucket) bucket.push(event);
    else byYear.set(year, [event]);
  }
  return byYear;
}

/** Merge rows into their year archives; incoming rows win on id collision. */
function mergeYear(year: number, incoming: TradeEvent[]): boolean {
  const existing = readArchiveYear(year);
  // Never rewrite a year we could not read: that would destroy its rows.
  if (!existing.ok) return false;
  const byId = new Map<string, TradeEvent>();
  for (const event of existing.events) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return writeArchiveYear(year, [...byId.values()]);
}

/** Merge rows into archives. Returns the rows whose year could not be written.
 *  A row with no usable year belongs to no archive, so it counts as failed and
 *  the caller keeps it in the live log rather than dropping it. */
export function mergeIntoArchives(events: TradeEvent[]): TradeEvent[] {
  const failed = events.filter((event) => eventYear(event.date) == null);
  for (const [year, rows] of groupByYear(events)) {
    if (!mergeYear(year, rows)) failed.push(...rows);
  }
  return failed;
}

interface RotationResult {
  retained: TradeEvent[];
  rotated: number;
}

/** Move rows older than `currentYear` into their archives. Order is backup ->
 *  archive write -> caller rewrites the live file, so a crash can only duplicate
 *  rows (dedup by id on the next merge), never lose them. */
export function rotateOlderYears(
  events: TradeEvent[],
  currentYear: number,
  liveLogPath: string,
): RotationResult {
  const stale = events.filter((event) => {
    const year = eventYear(event.date);
    return year != null && year < currentYear;
  });
  if (stale.length === 0) return { retained: events, rotated: 0 };

  if (!ensureLiveLogBackup(liveLogPath)) {
    log.warn("[Ledger] Skipping rotation because the live log could not be backed up");
    return { retained: events, rotated: 0 };
  }

  const failed = new Set(mergeIntoArchives(stale).map((event) => event.id));
  const archived = new Set(stale.filter((event) => !failed.has(event.id)).map((e) => e.id));
  if (archived.size === 0) return { retained: events, rotated: 0 };

  log.info(`[Ledger] Rotated ${archived.size} trade(s) out of the live log`);
  return { retained: events.filter((event) => !archived.has(event.id)), rotated: archived.size };
}

interface CollectedLedger {
  events: TradeEvent[];
  unreadableYears: number[];
}

/** Live rows plus every readable archive, newest first, deduped by id. */
function collectAll(liveEvents: TradeEvent[]): CollectedLedger {
  const byId = new Map<string, TradeEvent>();
  const unreadableYears: number[] = [];

  for (const year of listArchiveYears()) {
    const archive = readArchiveYear(year);
    if (!archive.ok) {
      unreadableYears.push(year);
      continue;
    }
    for (const event of archive.events) byId.set(event.id, event);
  }
  // Live rows win: they carry edits made since the archive was written.
  for (const event of liveEvents) byId.set(event.id, event);

  return {
    events: sortNewestFirst([...byId.values()]),
    unreadableYears: unreadableYears.sort((a, b) => a - b),
  };
}

function matchesQuery(event: TradeEvent, query: LedgerQuery): boolean {
  const day = toLocalDayKey(event.date);
  if (query.from && (!day || day < query.from)) return false;
  if (query.to && (!day || day > query.to)) return false;
  if (query.type && event.type !== query.type) return false;
  if (query.text) {
    const needle = query.text.toLowerCase();
    const partnerHit = (event.partner || "").toLowerCase().includes(needle);
    const itemHit = event.items.some((item) => item.displayName.toLowerCase().includes(needle));
    if (!partnerHit && !itemHit) return false;
  }
  return true;
}

/** Every row matching the query across live + archives, newest first. */
export function selectLedgerEvents(query: LedgerQuery, liveEvents: TradeEvent[]): CollectedLedger {
  const all = collectAll(liveEvents);
  return { ...all, events: all.events.filter((event) => matchesQuery(event, query)) };
}

/** One page of the ledger; offset and limit are clamped here, not trusted. */
export function queryLedger(query: LedgerQuery, liveEvents: TradeEvent[]): LedgerPage {
  const selected = selectLedgerEvents(query, liveEvents);
  // A junk or non-positive limit falls back to the page size instead of 0 rows.
  const rawLimit = Number(query.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(Math.trunc(rawLimit), LEDGER_QUERY_MAX_LIMIT)
      : LEDGER_QUERY_MAX_LIMIT;
  const rawOffset = Number(query.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0;
  return {
    events: selected.events.slice(offset, offset + limit),
    total: selected.events.length,
    unreadableYears: selected.unreadableYears,
  };
}

/** Apply a patch, keeping id and provenance and stamping the edit time. */
export function applyLedgerPatch(event: TradeEvent, patch: LedgerEventPatch): TradeEvent {
  const next: TradeEvent = { ...event };
  if (patch.type !== undefined) next.type = patch.type;
  if (patch.platChange !== undefined) next.platChange = patch.platChange;
  if (patch.credits !== undefined) {
    if (patch.credits === null) delete next.credits;
    else next.credits = patch.credits;
  }
  if (patch.tradeTax !== undefined) {
    if (patch.tradeTax === null) delete next.tradeTax;
    else next.tradeTax = patch.tradeTax;
  }
  if (patch.partner !== undefined) {
    if (patch.partner) next.partner = patch.partner;
    else delete next.partner;
  }
  next.editedAt = new Date().toISOString();
  return next;
}

/** Patch a row that lives in an archive. Returns false when no year holds it. */
export function patchArchivedEvent(id: string, patch: LedgerEventPatch): boolean {
  for (const year of listArchiveYears()) {
    const archive = readArchiveYear(year);
    if (!archive.ok) continue;
    const index = archive.events.findIndex((event) => event.id === id);
    if (index < 0) continue;
    const updated = [...archive.events];
    updated[index] = applyLedgerPatch(updated[index], patch);
    return writeArchiveYear(year, updated);
  }
  return false;
}

export function __resetLedgerStoreForTest(): void {
  _cache = new Map();
}
