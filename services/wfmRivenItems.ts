import { createJsonCache } from "./jsonCache";
import { withScope } from "./logger";
import * as wfmClient from "./wfmClient";

const log = withScope("wfmRivenItems");

const CACHE_FILE = "wfm-riven-items.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// v1 /riven/items answers 404 since the 2026 API cut; v2 lists the same
// weapons under `data[].slug` with names nested per language.
const RIVEN_WEAPONS_PATH = "/riven/weapons";

interface CachePayload {
  fetchedAt: number;
  /** slug -> English name. Only the keys gate anything; the names are kept so
   *  the file reads back as something a human can identify. */
  items: Record<string, string>;
}

let _memo: { fetchedAt: number; slugs: ReadonlySet<string> } | null = null;
let _inFlight: Promise<ReadonlySet<string> | null> | null = null;
let _loggedFailure = false;

// An entry-less payload is treated as no cache at all: the list is only useful
// as a closed set, and an empty one would reject every weapon.
const cache = createJsonCache<CachePayload>(CACHE_FILE, (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Partial<CachePayload>;
  if (typeof parsed.fetchedAt !== "number" || !Number.isFinite(parsed.fetchedAt)) return null;
  if (!parsed.items || typeof parsed.items !== "object" || Array.isArray(parsed.items)) return null;
  const items: Record<string, string> = {};
  for (const [slug, name] of Object.entries(parsed.items)) {
    if (slug && typeof name === "string") items[slug] = name;
  }
  return Object.keys(items).length > 0 ? { fetchedAt: parsed.fetchedAt, items } : null;
});

function logFailureOnce(message: string, err?: unknown): void {
  if (_loggedFailure) return;
  _loggedFailure = true;
  if (err === undefined) log.warn(message);
  else log.warn(message, err);
}

function englishName(entry: Record<string, unknown>): string | null {
  const i18n = entry.i18n;
  if (!i18n || typeof i18n !== "object") return null;
  const en = (i18n as Record<string, unknown>).en;
  if (!en || typeof en !== "object") return null;
  const name = (en as Record<string, unknown>).name;
  return typeof name === "string" && name ? name : null;
}

function parseItems(raw: unknown): Record<string, string> | null {
  const list = raw && typeof raw === "object" ? (raw as { data?: unknown }).data : null;
  if (!Array.isArray(list)) return null;
  const items: Record<string, string> = {};
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const slug = record.slug;
    if (typeof slug !== "string" || !slug) continue;
    items[slug] = englishName(record) ?? slug;
  }
  return Object.keys(items).length > 0 ? items : null;
}

async function refresh(): Promise<ReadonlySet<string> | null> {
  let items: Record<string, string> | null;
  try {
    items = parseItems(
      await wfmClient.requestV2("GET", RIVEN_WEAPONS_PATH, { priority: "background" }),
    );
  } catch (err) {
    logFailureOnce(`Failed to fetch ${RIVEN_WEAPONS_PATH}`, err);
    return null;
  }
  if (!items) {
    logFailureOnce(`Unusable ${RIVEN_WEAPONS_PATH} payload`);
    return null;
  }
  const fetchedAt = Date.now();
  _memo = { fetchedAt, slugs: new Set(Object.keys(items)) };
  cache.write({ fetchedAt, items });
  _loggedFailure = false;
  return _memo.slugs;
}

/** The weapons warframe.market runs a riven market for, or null when the list
 *  could not be obtained. A stale cache is never served on a failed refresh:
 *  null fails open, while an outdated set would reject a newly listed weapon. */
export async function getRivenWeaponSlugs(): Promise<ReadonlySet<string> | null> {
  const now = Date.now();
  if (_memo && now - _memo.fetchedAt < CACHE_TTL_MS) return _memo.slugs;
  if (!_memo) {
    const cached = cache.read();
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      _memo = { fetchedAt: cached.fetchedAt, slugs: new Set(Object.keys(cached.items)) };
      return _memo.slugs;
    }
  }
  if (_inFlight) return _inFlight;
  _inFlight = refresh().finally(() => {
    _inFlight = null;
  });
  return _inFlight;
}

/** null means the list is unavailable, so callers must fail open rather than
 *  read it as "not a riven weapon". */
export async function isRivenWeaponSlug(slug: string): Promise<boolean | null> {
  const slugs = await getRivenWeaponSlugs();
  return slugs ? slugs.has(slug) : null;
}

export function resetRivenItemsForTest(): void {
  _memo = null;
  _inFlight = null;
  _loggedFailure = false;
}
