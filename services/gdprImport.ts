/** Import a DE GDPR personal-data trade export into ledger rows. No confirmed
 *  sample exists, so the parser matches CSV/JSON headers by meaning and turns
 *  anything it cannot read into a rejected preview row instead of failing. */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { withScope } from "./logger";
import { lookupTradedCatalogItem } from "./tradeItemName";
import { stripPlatformGlyphs } from "./tradeLogSanitize";
import { normalizeErrorMessage } from "../config/shared/errors";
import { MAX_STATS_IMPORT_FILE_BYTES } from "../config/shared/statsImport";
import type { TradeEvent, TradeItem, TradeType } from "../config/shared/statsTypes";
import type {
  LedgerErrorCode,
  LedgerImportPreview,
  LedgerImportRowPreview,
} from "../config/shared/tradeLedgerTypes";
import { TRADE_EVENT_SCHEMA_VERSION } from "../config/shared/tradeLedgerTypes";

const log = withScope("gdprImport");

const MAX_ROWS = 50_000;
const MAX_PREVIEW_ROWS = 100;
const MAX_ITEMS_PER_TRADE = 12;
const MAX_STAGED_BATCHES = 3;
const MAX_NAME_LENGTH = 160;

type SourceRecord = Record<string, unknown>;

interface StagedBatch {
  batchId: string;
  events: TradeEvent[];
  stagedAt: number;
}

let _staged = new Map<string, StagedBatch>();

function toText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** Stable text for one source row so the same file always hashes the same. */
function canonicalizeRecord(record: SourceRecord, occurrence: number): string {
  const pairs = Object.keys(record)
    .map((key) => `${key.toLowerCase().replace(/[^a-z0-9]/g, "")}=${toText(record[key])}`)
    .sort();
  // The occurrence ordinal keeps two identical source rows distinct while a
  // re-import of the same file reproduces the exact same ids.
  return `gdpr-v1${pairs.join("")}#${occurrence}`;
}

function sha1(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else cell += ch;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

/** Split on newlines that are not inside a quoted cell. */
function splitCsvRows(text: string): string[] {
  const rows: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
      continue;
    }
    if (!quoted && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      rows.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.length > 0) rows.push(current);
  return rows.filter((row) => row.trim().length > 0);
}

function detectDelimiter(headerLine: string): string {
  const candidates = [",", ";", "\t"];
  let best = ",";
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = splitCsvLine(headerLine, candidate).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function parseCsvRecords(text: string): SourceRecord[] {
  const rows = splitCsvRows(text);
  if (rows.length < 2) return [];
  const delimiter = detectDelimiter(rows[0]);
  const headers = splitCsvLine(rows[0], delimiter).map(
    (header, index) => header || `column${index}`,
  );
  const records: SourceRecord[] = [];
  for (const row of rows.slice(1, MAX_ROWS + 1)) {
    const cells = splitCsvLine(row, delimiter);
    const record: SourceRecord = {};
    headers.forEach((header, index) => {
      record[header] = cells[index] ?? "";
    });
    records.push(record);
  }
  return records;
}

function isRecordArray(value: unknown): value is SourceRecord[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => entry != null && typeof entry === "object" && !Array.isArray(entry))
  );
}

/** Take the root array, or the most trade-like array inside the root object. */
function parseJsonRecords(text: string): SourceRecord[] {
  const parsed: unknown = JSON.parse(text);
  if (isRecordArray(parsed)) return parsed.slice(0, MAX_ROWS);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  const root = parsed as Record<string, unknown>;
  const keys = Object.keys(root);
  const preferred = keys.filter((key) =>
    /trade|transaction|record|histor|purchase|sale/i.test(key),
  );
  for (const key of [...preferred, ...keys]) {
    const value = root[key];
    if (isRecordArray(value)) return value.slice(0, MAX_ROWS);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        if (isRecordArray(nested)) return nested.slice(0, MAX_ROWS);
      }
    }
  }
  return [];
}

type FieldName =
  | "date"
  | "type"
  | "itemsGiven"
  | "itemsReceived"
  | "items"
  | "platinum"
  | "credits"
  | "tax"
  | "quantity"
  | "partner";

// Tier 0 is an exact header name, tier 1 a distinctive substring, tier 2 a
// loose guess. Every field competes in one tier before the next tier opens.
const FIELD_PATTERNS: Record<FieldName, RegExp[]> = {
  date: [
    /^(date|time|datetime|timestamp|tradedate|tradetime|createdat|occurredat|when)$/,
    /(datetime|timestamp|tradedate|tradetime|createdat|occurredat)/,
    /(date|time)/,
  ],
  type: [
    /^(type|kind|action|direction|tradetype|transactiontype)$/,
    /(tradetype|transactiontype|direction)/,
    /(type|action|kind)/,
  ],
  itemsGiven: [
    /^(itemsgiven|givenitems|itemssold|solditems|outgoing|offered)$/,
    /(itemsgiven|givenitems|itemssold|outgoingitems|offereditems)/,
    /(given|sold|outgoing|offered)/,
  ],
  itemsReceived: [
    /^(itemsreceived|receiveditems|itemsbought|boughtitems|incoming|requested)$/,
    /(itemsreceived|receiveditems|itemsbought|incomingitems|requesteditems)/,
    /(received|bought|incoming|requested)/,
  ],
  items: [/^(item|items|itemname|itemnames|product|goods|content)$/, /(itemname|itemlist)/, /item/],
  platinum: [
    /^(platinum|plat|premiumcredits|price|cost)$/,
    /(platinum|premiumcredits|platprice|platamount)/,
    /(plat|price|cost|amount|value)/,
  ],
  credits: [/^(credits|regularcredits)$/, /(regularcredits|creditamount)/, /credit/],
  tax: [/^(tax|tradetax|taxpaid)$/, /(tradetax|taxpaid|taxamount)/, /tax/],
  quantity: [/^(quantity|qty|count)$/, /(itemquantity|itemcount)/, /(quantity|qty)/],
  partner: [
    /^(partner|tradepartner|counterparty|otherplayer|withplayer|buyer|seller|recipient)$/,
    /(tradepartner|counterparty|otherplayer|withplayer|partnername)/,
    /(partner|buyer|seller|recipient|player|username|account)/,
  ],
};

const FIELD_ORDER: FieldName[] = [
  "date",
  "type",
  "itemsGiven",
  "itemsReceived",
  "items",
  "platinum",
  "credits",
  "tax",
  "quantity",
  "partner",
];

type FieldMap = Partial<Record<FieldName, string>>;

/** Map source keys onto ledger fields; each key serves at most one field. */
function mapFields(keys: string[]): FieldMap {
  const normalized = keys.map((key) => ({
    key,
    norm: key.toLowerCase().replace(/[^a-z0-9]/g, ""),
  }));
  const usedKeys = new Set<string>();
  const mapped: FieldMap = {};
  for (let tier = 0; tier < 3; tier++) {
    for (const field of FIELD_ORDER) {
      if (mapped[field]) continue;
      const pattern = FIELD_PATTERNS[field][tier];
      const hit = normalized.find((entry) => !usedKeys.has(entry.key) && pattern.test(entry.norm));
      if (hit) {
        mapped[field] = hit.key;
        usedKeys.add(hit.key);
      }
    }
  }
  return mapped;
}

function readField(record: SourceRecord, field: string | undefined): unknown {
  return field === undefined ? undefined : record[field];
}

const DOTTED_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const SLASHED_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/** An export prints wall-clock dates, so a bare date or time is read as local:
 *  a UTC reading would land the row on the wrong calendar day west of Greenwich. */
function localIso(y: number, m: number, d: number, h = 0, min = 0, s = 0): string | null {
  const parsed = new Date(y, m - 1, d, h, min, s);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) return null;
  if (parsed.getFullYear() !== y || parsed.getMonth() !== m - 1) return null;
  return parsed.toISOString();
}

/** ISO datetime from the shapes an export plausibly ships. */
export function parseGdprDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const text = toText(value);
  if (!text) return null;

  if (/^\d{10}$|^\d{13}$/.test(text)) return parseGdprDate(Number(text));

  const dotted = DOTTED_DATE.exec(text);
  if (dotted) {
    const [, d, m, y, h, min, s] = dotted;
    return localIso(
      Number(y),
      Number(m),
      Number(d),
      Number(h || 0),
      Number(min || 0),
      Number(s || 0),
    );
  }
  const slashed = SLASHED_DATE.exec(text);
  if (slashed) {
    const [, first, second, y, h, min, s] = slashed;
    // Ambiguous unless the first field cannot be a month; default to US order.
    const dayFirst = Number(first) > 12;
    const month = dayFirst ? Number(second) : Number(first);
    const day = dayFirst ? Number(first) : Number(second);
    return localIso(Number(y), month, day, Number(h || 0), Number(min || 0), Number(s || 0));
  }

  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (isoDay) return localIso(Number(isoDay[1]), Number(isoDay[2]), Number(isoDay[3]));
  // A datetime with no offset is local per the language spec, so leave it bare.
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]/.test(text) ? text.replace(" ", "T") : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const GROUPED_NUMBER = /^[+-]?\d{1,3}(?:([.,])\d{3})(?:\1\d{3})*$/;

/** The number style is inferred per value the way the date style is, because an
 *  export that prints 04.03.2025 also prints 1.234 for 1234: only groups of
 *  exactly three digits read as thousands, and when both separators appear the
 *  rightmost one is the decimal point. */
function normalizeSeparators(text: string): string {
  const grouped = GROUPED_NUMBER.exec(text);
  if (grouped) return text.split(grouped[1]).join("");
  const commas = text.split(",").length - 1;
  const dots = text.split(".").length - 1;
  if (commas > 0 && dots > 0) {
    const group = text.lastIndexOf(",") > text.lastIndexOf(".") ? "." : ",";
    return text.split(group).join("").replace(",", ".");
  }
  // A separator that repeats cannot be the decimal point, so it groups thousands
  // even where a group is the wrong length ("1,234,56" is 123456, not NaN).
  if (commas > 1) return text.split(",").join("");
  if (dots > 1) return text.split(".").join("");
  return text.replace(",", ".");
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = toText(value).replace(/[^0-9.,+-]/g, "");
  if (!text) return null;
  const parsed = Number(normalizeSeparators(text));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTradeType(value: unknown): TradeType | null {
  const text = toText(value).toLowerCase();
  if (!text) return null;
  if (/(sale|sold|sell|selling|outgoing|gave|given)/.test(text)) return "sale";
  if (/(purchase|purchased|bought|buy|buying|incoming|received)/.test(text)) return "purchase";
  if (/(trade|swap|exchange|barter)/.test(text)) return "trade";
  return null;
}

const COUNT_PREFIX = /^(\d{1,4})\s*[x*]\s*(.+)$/i;
const COUNT_SUFFIX = /^(.+?)\s*[x*]\s*(\d{1,4})$/i;

function parseCountedName(raw: string): { name: string; count: number } | null {
  const text = stripPlatformGlyphs(raw.trim());
  if (!text) return null;
  const prefix = COUNT_PREFIX.exec(text);
  if (prefix) return { name: prefix[2].trim(), count: Number(prefix[1]) };
  const suffix = COUNT_SUFFIX.exec(text);
  if (suffix) return { name: suffix[1].trim(), count: Number(suffix[2]) };
  return { name: text, count: 1 };
}

function itemFromName(
  raw: string,
  direction: TradeItem["direction"],
): { item: TradeItem; resolved: boolean } | null {
  const counted = parseCountedName(raw);
  if (!counted || !counted.name || counted.name.length > MAX_NAME_LENGTH) return null;
  if (!Number.isInteger(counted.count) || counted.count < 1 || counted.count > 9999) return null;
  const catalogItem = lookupTradedCatalogItem(counted.name);
  return {
    resolved: catalogItem != null,
    item: {
      // gameRef is DE's uniqueName; the renderer joins the item database on it.
      internalName: catalogItem?.gameRef ?? "",
      displayName: counted.name,
      count: counted.count,
      direction,
      ...(catalogItem?.url_name ? { wfmSlug: catalogItem.url_name } : {}),
      ...(catalogItem?.thumb ? { wfmThumb: catalogItem.thumb } : {}),
    },
  };
}

function extractItems(
  value: unknown,
  direction: TradeItem["direction"],
): { items: TradeItem[]; unresolved: number } {
  const items: TradeItem[] = [];
  let unresolved = 0;
  const push = (raw: string): void => {
    const parsed = itemFromName(raw, direction);
    if (!parsed) return;
    items.push(parsed.item);
    if (!parsed.resolved) unresolved++;
  };

  const visit = (entry: unknown): void => {
    if (entry == null) return;
    if (typeof entry === "string") {
      for (const part of entry.split(/[;|]|\s\+\s|,/)) {
        if (part.trim()) push(part);
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    if (typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const name = toText(obj.name ?? obj.itemName ?? obj.item ?? obj.displayName ?? obj.type);
      if (!name) return;
      const count = parseNumber(obj.quantity ?? obj.count ?? obj.amount);
      push(count != null && count > 1 ? `${Math.trunc(count)}x ${name}` : name);
    }
  };

  visit(value);
  return { items: items.slice(0, MAX_ITEMS_PER_TRADE), unresolved };
}

interface ParsedRow {
  event: TradeEvent | null;
  preview: LedgerImportRowPreview;
  unresolved: boolean;
}

function summarize(event: TradeEvent): string {
  const names = event.items.map((item) => item.displayName).join(", ");
  const partner = event.partner ? ` with ${event.partner}` : "";
  return `${event.type} ${event.platChange}p${names ? ` - ${names}` : ""}${partner}`;
}

function parseRow(record: SourceRecord, fields: FieldMap, occurrence: number): ParsedRow {
  const canonical = canonicalizeRecord(record, occurrence);
  const sourceRecordId = sha1(canonical);
  const rawDate = readField(record, fields.date);
  const date = parseGdprDate(rawDate);
  if (!date) {
    return {
      event: null,
      unresolved: false,
      preview: {
        kind: "rejected",
        date: toText(rawDate).slice(0, 40),
        summary: toText(record[Object.keys(record)[0] ?? ""]).slice(0, 80),
        reason: "no readable date",
      },
    };
  }

  const day = date.slice(0, 10);
  const platRaw = parseNumber(readField(record, fields.platinum));
  if (fields.platinum !== undefined && platRaw == null && toText(record[fields.platinum]) !== "") {
    return {
      event: null,
      unresolved: false,
      preview: { kind: "rejected", date: day, summary: "", reason: "platinum is not a number" },
    };
  }

  const declaredType = normalizeTradeType(readField(record, fields.type));
  // Signed platinum is the only other direction signal an export may carry.
  const inferredType: TradeType =
    declaredType ??
    (platRaw == null || platRaw === 0 ? "trade" : platRaw > 0 ? "sale" : "purchase");
  const platChange = platRaw == null ? 0 : Math.min(Math.abs(Math.round(platRaw)), 10_000_000);

  const givenDirection = inferredType === "purchase" ? "received" : "given";
  const collected: TradeItem[] = [];
  let unresolvedCount = 0;
  const addFrom = (value: unknown, direction: TradeItem["direction"]): void => {
    const extracted = extractItems(value, direction);
    collected.push(...extracted.items);
    unresolvedCount += extracted.unresolved;
  };
  if (fields.itemsGiven !== undefined) addFrom(record[fields.itemsGiven], "given");
  if (fields.itemsReceived !== undefined) addFrom(record[fields.itemsReceived], "received");
  if (fields.items !== undefined) addFrom(record[fields.items], givenDirection);

  const items = collected.slice(0, MAX_ITEMS_PER_TRADE);
  if (items.length === 0 && platChange === 0) {
    return {
      event: null,
      unresolved: false,
      preview: { kind: "rejected", date: day, summary: "", reason: "no items and no platinum" },
    };
  }

  const partnerRaw = stripPlatformGlyphs(toText(readField(record, fields.partner)));
  const partner = partnerRaw && partnerRaw.length <= 120 ? partnerRaw : "";
  const credits = parseNumber(readField(record, fields.credits));
  const tax = parseNumber(readField(record, fields.tax));

  const event: TradeEvent = {
    id: `gdpr-${sourceRecordId}`,
    date,
    type: inferredType,
    platChange,
    items,
    ...(partner ? { partner } : {}),
    schemaVersion: TRADE_EVENT_SCHEMA_VERSION,
    source: "gdpr",
    sourceRecordId,
    ...(credits != null && Number.isFinite(credits) ? { credits: Math.round(credits) } : {}),
    ...(tax != null && Number.isFinite(tax) ? { tradeTax: Math.round(Math.abs(tax)) } : {}),
  };

  return {
    event,
    unresolved: unresolvedCount > 0,
    preview: {
      kind: unresolvedCount > 0 ? "unresolved" : "parsed",
      date: day,
      summary: summarize(event),
      ...(unresolvedCount > 0
        ? { reason: `${unresolvedCount} item name(s) not in the catalog` }
        : {}),
    },
  };
}

/** Case- and glyph-insensitive text, so a console partner or a re-cased item
 *  name still joins against the row the live tracker wrote. */
function normalizeLoose(value: unknown): string {
  return stripPlatformGlyphs(toText(value)).toLowerCase().replace(/\s+/g, " ").trim();
}

/** Item multiset of one trade. Live and imported rows describe direction from
 *  opposite ends of the deal, so only name and count belong in the key. */
function itemSetKey(items: readonly TradeItem[]): string {
  return items
    .map((item) => `${normalizeLoose(item.displayName)}:${item.count}`)
    .sort()
    .join("|");
}

function liveMatchKey(event: TradeEvent): string {
  return `${event.type}|${Math.round(event.platChange)}|${itemSetKey(event.items ?? [])}`;
}

/** An export covering an already-tracked period ships the same trade twice, and
 *  its rows carry no id the tracker ever saw. One day of slack absorbs a
 *  date-only export row against the live row's exact timestamp. */
const LIVE_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

interface LiveCandidate {
  at: number;
  partner: string;
  used: boolean;
}

function indexLiveEvents(existing: readonly TradeEvent[]): Map<string, LiveCandidate[]> {
  const index = new Map<string, LiveCandidate[]>();
  for (const event of existing) {
    if ((event.source ?? "live") !== "live") continue;
    const at = Date.parse(event.date);
    if (!Number.isFinite(at)) continue;
    const candidate: LiveCandidate = { at, partner: normalizeLoose(event.partner), used: false };
    const key = liveMatchKey(event);
    const bucket = index.get(key);
    if (bucket) bucket.push(candidate);
    else index.set(key, [candidate]);
  }
  return index;
}

/** One live row absorbs at most one imported row, so two genuine same-day
 *  trades both survive. Partner is compared when both sides carry one; a GDPR
 *  export may not name the counterparty at all. */
function takeLiveMatch(index: Map<string, LiveCandidate[]>, event: TradeEvent): boolean {
  const bucket = index.get(liveMatchKey(event));
  if (!bucket) return false;
  const at = Date.parse(event.date);
  if (!Number.isFinite(at)) return false;
  const partner = normalizeLoose(event.partner);
  const hit = bucket.find(
    (candidate) =>
      !candidate.used &&
      Math.abs(candidate.at - at) <= LIVE_MATCH_WINDOW_MS &&
      (!partner || !candidate.partner || partner === candidate.partner),
  );
  if (!hit) return false;
  hit.used = true;
  return true;
}

interface GdprParseResult {
  events: TradeEvent[];
  rows: LedgerImportRowPreview[];
  counts: { parsed: number; duplicates: number; unresolved: number; rejected: number };
}

/** Parse export text into ledger rows, marking rows already in the ledger. */
export function parseGdprTradeExport(
  text: string,
  fileName: string,
  existing: readonly TradeEvent[],
): GdprParseResult {
  let records: SourceRecord[];
  const looksJson = /\.json$/i.test(fileName) || /^\s*[[{]/.test(text);
  if (looksJson) {
    try {
      records = parseJsonRecords(text);
    } catch {
      records = parseCsvRecords(text);
    }
  } else {
    records = parseCsvRecords(text);
  }

  const counts = { parsed: 0, duplicates: 0, unresolved: 0, rejected: 0 };
  const events: TradeEvent[] = [];
  const rows: LedgerImportRowPreview[] = [];
  if (records.length === 0) return { events, rows, counts };

  const keys = new Set<string>();
  for (const record of records.slice(0, 200)) {
    for (const key of Object.keys(record)) keys.add(key);
  }
  const fields = mapFields([...keys]);

  const knownSourceRecordIds = new Set<string>();
  for (const event of existing) {
    if (event.sourceRecordId) knownSourceRecordIds.add(event.sourceRecordId);
  }
  const liveIndex = indexLiveEvents(existing);

  const occurrences = new Map<string, number>();
  const seenInBatch = new Set<string>();
  for (const record of records) {
    const base = canonicalizeRecord(record, 0);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);

    const parsed = parseRow(record, fields, occurrence);
    if (!parsed.event) {
      counts.rejected++;
      rows.push(parsed.preview);
      continue;
    }
    const recordId = parsed.event.sourceRecordId ?? "";
    if (
      knownSourceRecordIds.has(recordId) ||
      seenInBatch.has(recordId) ||
      takeLiveMatch(liveIndex, parsed.event)
    ) {
      counts.duplicates++;
      rows.push({ kind: "duplicate", date: parsed.preview.date, summary: parsed.preview.summary });
      continue;
    }
    seenInBatch.add(recordId);
    events.push(parsed.event);
    if (parsed.unresolved) counts.unresolved++;
    else counts.parsed++;
    rows.push(parsed.preview);
  }

  return { events, rows, counts };
}

/** Problems first: the sample is capped, and a rejected row is what needs eyes. */
function previewSample(rows: LedgerImportRowPreview[]): LedgerImportRowPreview[] {
  const order: LedgerImportRowPreview["kind"][] = ["rejected", "unresolved", "parsed", "duplicate"];
  const sample: LedgerImportRowPreview[] = [];
  for (const kind of order) {
    for (const row of rows) {
      if (row.kind !== kind) continue;
      sample.push(row);
      if (sample.length >= MAX_PREVIEW_ROWS) return sample;
    }
  }
  return sample;
}

function stageBatch(batch: StagedBatch): void {
  if (_staged.size >= MAX_STAGED_BATCHES) {
    const oldest = [..._staged.values()].sort((a, b) => a.stagedAt - b.stagedAt)[0];
    if (oldest) _staged.delete(oldest.batchId);
  }
  _staged.set(batch.batchId, batch);
}

/** Read and stage a file; the returned batchId is what apply consumes. */
export function previewGdprImportFile(
  filePath: string,
  existing: readonly TradeEvent[],
): LedgerImportPreview | { error: LedgerErrorCode } {
  let text: string;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_STATS_IMPORT_FILE_BYTES) return { error: "fileTooLarge" };
    text = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    log.warn("[Ledger] GDPR import read failed:", normalizeErrorMessage(err));
    return { error: "importReadFailed" };
  }

  const fileName = path.basename(filePath);
  const result = parseGdprTradeExport(text, fileName, existing);
  if (result.rows.length === 0) return { error: "noRows" };

  const batchId = randomUUID();
  stageBatch({ batchId, events: result.events, stagedAt: Date.now() });
  return {
    batchId,
    fileName,
    counts: result.counts,
    rows: previewSample(result.rows),
  };
}

/** Consume a staged batch; a batchId can only be applied once. */
export function takeStagedImport(batchId: string): TradeEvent[] | null {
  const batch = _staged.get(batchId);
  if (!batch) return null;
  _staged.delete(batchId);
  return batch.events.map((event) => ({ ...event, importBatchId: batchId }));
}

export function __resetGdprImportForTest(): void {
  _staged = new Map();
}
