import { fetchBackendRaw, isBackendLiteConfigured } from "../wfm/backendLite.js";
import { log } from "../log.js";
import { readStorage, writeStorage } from "../persistence.js";
import { toFiniteNumber } from "../../../config/shared/numeric.js";

const STORAGE_KEY = "wf_adversary_vendors_v1";
const FETCH_TIMEOUT_MS = 8000;
// The worker rebuilds at most hourly, so a copy younger than that is served without
// a request; anything older revalidates and falls back to what is stored.
const REVALIDATE_AFTER_MS = 60 * 60 * 1000;
const STORAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 20;
const MAX_NAME_LENGTH = 60;
const MAX_BONUS = 100;
/** Bonus tiers read the way the wiki colours them. */
const MID_BONUS = 30;
const HIGH_BONUS = 40;

// Adversary valence bonuses only ever carry one of these; anything else means the
// wiki table changed shape and the row is dropped rather than rendered.
const ELEMENTS = [
  "Impact",
  "Puncture",
  "Slash",
  "Heat",
  "Cold",
  "Electricity",
  "Toxin",
  "Blast",
  "Corrosive",
  "Gas",
  "Magnetic",
  "Radiation",
  "Viral",
];

export interface AdversaryVendorItem {
  name: string;
  element: string;
  bonus: number;
}

interface VendorBatch {
  batch: "A" | "B";
  items: AdversaryVendorItem[];
}

export interface AdversaryVendorsDoc {
  generatedAt: number;
  coda: VendorBatch;
  /** The batch Eleanor rotates to next; used when our clock disagrees with the edge. */
  codaNext?: VendorBatch;
  tenet: AdversaryVendorItem[];
}

interface StoredCopy {
  savedAt: number;
  etag: string | null;
  doc: AdversaryVendorsDoc;
}

let _memoryDoc: AdversaryVendorsDoc | null = null;
let _inFlight: Promise<AdversaryVendorsDoc | null> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalElement(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const needle = value.trim().toLowerCase();
  return ELEMENTS.find((element) => element.toLowerCase() === needle) ?? null;
}

function parseItems(value: unknown): AdversaryVendorItem[] {
  if (!Array.isArray(value)) return [];
  const items: AdversaryVendorItem[] = [];
  for (const row of value.slice(0, MAX_ITEMS)) {
    if (!isRecord(row)) continue;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const element = canonicalElement(row.element);
    const bonus = toFiniteNumber(row.bonus);
    if (!name || name.length > MAX_NAME_LENGTH || !element) continue;
    if (bonus == null || bonus < 0 || bonus > MAX_BONUS) continue;
    items.push({ name, element, bonus: Math.round(bonus * 10) / 10 });
  }
  return items;
}

function parseBatch(value: unknown): VendorBatch | null {
  if (!isRecord(value)) return null;
  const batch = value.batch === "A" || value.batch === "B" ? value.batch : null;
  if (!batch) return null;
  const items = parseItems(value.items);
  return items.length > 0 ? { batch, items } : null;
}

/** Strict boundary parse: the worker response and the stored copy are both untrusted. */
export function parseAdversaryVendorsDoc(value: unknown): AdversaryVendorsDoc | null {
  if (!isRecord(value)) return null;
  const generatedAt = toFiniteNumber(value.generatedAt);
  if (generatedAt == null || generatedAt <= 0) return null;

  const coda = parseBatch(value.coda);
  // The worker wraps the rows in { items }; the stored copy keeps the parsed array.
  const tenet = parseItems(isRecord(value.tenet) ? value.tenet.items : value.tenet);
  if (!coda && tenet.length === 0) return null;

  const codaNext = parseBatch(value.codaNext);
  return {
    generatedAt: Math.floor(generatedAt),
    coda: coda ?? { batch: "A", items: [] },
    ...(codaNext ? { codaNext } : {}),
    tenet,
  };
}

/**
 * Eleanor's batch is computed locally, so a doc served from a stale edge cache can
 * name the other one; the batch that matches wins and a mismatch shows no bonuses.
 */
export function codaItemsForBatch(
  doc: AdversaryVendorsDoc | null,
  batch: "A" | "B",
): AdversaryVendorItem[] {
  if (!doc) return [];
  if (doc.coda.batch === batch) return doc.coda.items;
  return doc.codaNext?.batch === batch ? doc.codaNext.items : [];
}

/** Weapon names are matched case-insensitively; the wiki and the app spell their own. */
export function vendorBonusLookup(items: AdversaryVendorItem[]): Map<string, AdversaryVendorItem> {
  return new Map(items.map((item) => [item.name.toLowerCase(), item]));
}

export function bonusTier(bonus: number): "low" | "mid" | "high" {
  if (bonus >= HIGH_BONUS) return "high";
  return bonus >= MID_BONUS ? "mid" : "low";
}

function readStored(): StoredCopy | null {
  const raw = readStorage(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const savedAt = toFiniteNumber(parsed.savedAt);
    if (savedAt == null || savedAt <= 0 || Date.now() - savedAt > STORAGE_MAX_AGE_MS) return null;
    const doc = parseAdversaryVendorsDoc(parsed.doc);
    if (!doc) return null;
    return { savedAt, etag: typeof parsed.etag === "string" ? parsed.etag : null, doc };
  } catch {
    return null;
  }
}

function writeStored(copy: StoredCopy): void {
  writeStorage(STORAGE_KEY, JSON.stringify(copy));
}

async function requestVendors(cached: StoredCopy | null): Promise<AdversaryVendorsDoc | null> {
  const headers: Record<string, string> = {};
  if (cached?.etag) headers["If-None-Match"] = cached.etag;

  const response = await fetchBackendRaw("/v1/adversary-vendors", {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers,
  });
  if (!response) return cached?.doc ?? null;

  if (response.status === 304) {
    if (!cached) return null;
    writeStored({ ...cached, savedAt: Date.now() });
    return cached.doc;
  }

  const doc = parseAdversaryVendorsDoc(await response.json());
  if (!doc) return cached?.doc ?? null;

  writeStored({ savedAt: Date.now(), etag: response.headers.get("etag"), doc });
  return doc;
}

/**
 * Wiki-sourced elements and bonus percentages, or null when the backend has none.
 * Resolved once per session; the stored copy answers a failed request.
 */
export async function loadAdversaryVendors(): Promise<AdversaryVendorsDoc | null> {
  if (_memoryDoc) return _memoryDoc;
  if (_inFlight) return _inFlight;
  if (!isBackendLiteConfigured()) return null;

  _inFlight = (async () => {
    const cached = readStored();
    if (cached && Date.now() - cached.savedAt < REVALIDATE_AFTER_MS) return cached.doc;
    try {
      return await requestVendors(cached);
    } catch (e) {
      log.warn("[AdversaryVendors] load failed:", e);
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

export function resetAdversaryVendorsCacheForTest(): void {
  _memoryDoc = null;
  _inFlight = null;
}
