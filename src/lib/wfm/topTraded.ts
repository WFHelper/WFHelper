import { fetchBackendRaw, isBackendLiteConfigured } from "./backendLite.js";
import { log } from "../log.js";
import { readStorage, writeStorage } from "../persistence.js";
import { toFiniteNumber } from "../../../config/shared/numeric.js";
import {
  TOP_TRADED_MAX_ITEMS,
  topTradedName,
  topTradedThumb,
  type TopTradedDoc,
  type TopTradedItem,
} from "../../../config/shared/topTraded.js";
import { sanitizeWfmSlug } from "../../../config/shared/wfm.js";

const STORAGE_KEY = "wf_top_traded_v1";
const FETCH_TIMEOUT_MS = 8000;
// The worker rebuilds the doc at most hourly, so a copy younger than that is served
// without a request; anything older revalidates and falls back to what is stored.
const REVALIDATE_AFTER_MS = 60 * 60 * 1000;
const STORAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface StoredCopy {
  savedAt: number;
  etag: string | null;
  doc: TopTradedDoc;
}

let _memoryDoc: TopTradedDoc | null = null;
let _inFlight: Promise<TopTradedDoc | null> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function positiveInt(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed == null || parsed <= 0) return null;
  return Math.round(parsed);
}

/** Strict boundary parse: the worker response and the stored copy are both untrusted. */
export function parseTopTradedDoc(value: unknown): TopTradedDoc | null {
  if (!isRecord(value)) return null;
  const generatedAt = positiveInt(value.generatedAt);
  const windowDays = positiveInt(value.windowDays);
  if (generatedAt == null || windowDays == null || windowDays > 365) return null;
  if (!Array.isArray(value.items) || value.items.length > TOP_TRADED_MAX_ITEMS) return null;

  const items: TopTradedItem[] = [];
  const known = new Set<string>();
  for (const row of value.items) {
    if (!isRecord(row)) continue;
    const slug = sanitizeWfmSlug(row.slug);
    if (!slug || known.has(slug)) continue;
    const volume = positiveInt(row.volume);
    const median = positiveInt(row.median);
    if (volume == null || median == null) continue;
    known.add(slug);
    items.push({
      slug,
      name: topTradedName(row.name),
      volume,
      median,
      value: positiveInt(row.value) ?? volume * median,
      ...topTradedThumb(row.thumb),
    });
  }
  if (items.length === 0) return null;

  const rawByValue = Array.isArray(value.byValue) ? value.byValue : [];
  const byValue: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawByValue.slice(0, TOP_TRADED_MAX_ITEMS)) {
    if (typeof entry !== "string" || !known.has(entry) || seen.has(entry)) continue;
    seen.add(entry);
    byValue.push(entry);
  }

  return { generatedAt, windowDays, items, byValue };
}

function readStored(): StoredCopy | null {
  const raw = readStorage(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const savedAt = positiveInt(parsed.savedAt);
    if (savedAt == null || Date.now() - savedAt > STORAGE_MAX_AGE_MS) return null;
    const doc = parseTopTradedDoc(parsed.doc);
    if (!doc) return null;
    return { savedAt, etag: typeof parsed.etag === "string" ? parsed.etag : null, doc };
  } catch {
    return null;
  }
}

function writeStored(copy: StoredCopy): void {
  writeStorage(STORAGE_KEY, JSON.stringify(copy));
}

async function requestTopTraded(cached: StoredCopy | null): Promise<TopTradedDoc | null> {
  const headers: Record<string, string> = {};
  if (cached?.etag) headers["If-None-Match"] = cached.etag;

  const response = await fetchBackendRaw("/v1/top-traded", {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers,
  });
  if (!response) return cached?.doc ?? null;

  if (response.status === 304) {
    if (!cached) return null;
    writeStored({ ...cached, savedAt: Date.now() });
    return cached.doc;
  }

  const doc = parseTopTradedDoc(await response.json());
  if (!doc) return cached?.doc ?? null;

  writeStored({ savedAt: Date.now(), etag: response.headers.get("etag"), doc });
  return doc;
}

/**
 * Published warframe.market volume ranking, or null when the backend has not built
 * one yet. Resolved once per session; the stored copy answers a failed request.
 */
export async function loadTopTraded(): Promise<TopTradedDoc | null> {
  if (_memoryDoc) return _memoryDoc;
  if (_inFlight) return _inFlight;
  if (!isBackendLiteConfigured()) return null;

  _inFlight = (async () => {
    const cached = readStored();
    if (cached && Date.now() - cached.savedAt < REVALIDATE_AFTER_MS) return cached.doc;
    try {
      return await requestTopTraded(cached);
    } catch (e) {
      log.warn("[TopTraded] load failed:", e);
      return cached?.doc ?? null;
    }
  })()
    .then((doc) => {
      _memoryDoc = doc;
      return doc;
    })
    .finally(() => {
      _inFlight = null;
    });

  return _inFlight;
}

export function resetTopTradedCacheForTest(): void {
  _memoryDoc = null;
  _inFlight = null;
}
