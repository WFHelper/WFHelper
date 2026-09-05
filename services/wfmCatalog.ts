import { withScope } from "./logger";
import * as wfmClient from "./wfmClient";
import { unwrapWfmResponse, WfmApiError } from "./wfmTypes";
import { BACKEND_URL } from "../config/shared/backendConfig";
import { normalizeErrorMessage } from "../config/shared/errors";
import { withAbortTimeout } from "../config/shared/fetchWithTimeout";
import { formatWfmAssetUrl, titleFromSlug } from "../config/shared/wfm";

const log = withScope("wfmCatalog");

/** Lazily cache the WFM v2 item catalog for main-process lookups. */

const ITEMS_PATH = "/items";
const LOAD_FAILURE_COOLDOWN_MS = 15_000;
const BACKEND_CATALOG_TIMEOUT_MS = 10_000;
const NAME_SET_SUFFIX = " set";
const SLUG_SET_SUFFIX_RE = /_set$/;
const NAME_PAREN_SUFFIX_RE = /^(.+?)\s*\([^()]*\)\s*$/;
const SEARCH_MIN_QUERY_LENGTH = 2;
const SEARCH_SCAN_MULTIPLIER = 2;

interface CatalogItem {
  id: string | null;
  url_name: string;
  item_name: string;
  thumb: string | null;
  icon: string | null;
  maxRank: number | null;
  gameRef: string | null;
}

let _items: CatalogItem[] = [];
let _byId = new Map<string, CatalogItem>();
let _bySlug = new Map<string, CatalogItem>();
let _byNameLc = new Map<string, CatalogItem>();
let _byGameRefLc = new Map<string, CatalogItem>();
let _loaded = false;
let _loading: Promise<void> | null = null;
let _lastFailureAt = 0;

function _normalise(raw: unknown): CatalogItem {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deeply nested untyped WFM API response
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const slug: string = source.slug || source.url_name || source._slug || "";
  const name: string =
    source?.i18n?.en?.name ||
    source?.i18n?.en?.itemName ||
    source?.i18n?.en?.item_name ||
    source?.item_name ||
    source?.itemName ||
    source?.name ||
    titleFromSlug(slug);
  const thumb: string | null = source?.i18n?.en?.thumb || source.thumb || null;
  const icon: string | null = source?.i18n?.en?.icon || source.icon || null;
  const rawMaxRank = Number(source.maxRank ?? source.max_rank ?? null);
  const maxRank = Number.isFinite(rawMaxRank) && rawMaxRank > 0 ? Math.floor(rawMaxRank) : null;
  const gameRef: string | null =
    typeof source.gameRef === "string" && source.gameRef.trim().length > 0
      ? source.gameRef
      : typeof source.game_ref === "string" && source.game_ref.trim().length > 0
        ? source.game_ref
        : null;
  return {
    id: source.id || null,
    url_name: slug,
    item_name: name,
    thumb: formatWfmAssetUrl(thumb),
    icon: formatWfmAssetUrl(icon),
    maxRank,
    gameRef,
  };
}

function backendCatalogUrl(): string {
  const base = (process.env.VITE_WFM_BACKEND_URL || BACKEND_URL || "").trim().replace(/\/+$/, "");
  return base ? `${base}/v1/wfm-items` : "";
}

// Worker pass-through cache: cheap, Cloudflare-fronted, and immune to the WFM
// slowness that otherwise leaves a session with an empty catalog.
async function _fetchBackendCatalog(): Promise<unknown[]> {
  const url = backendCatalogUrl();
  if (!url) return [];
  // The deadline covers the body read as well as the headers.
  return withAbortTimeout(BACKEND_CATALOG_TIMEOUT_MS, async (signal) => {
    const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { ok?: boolean; items?: unknown[] };
    return json?.ok && Array.isArray(json.items) ? json.items : [];
  });
}

async function _load(): Promise<void> {
  if (_loaded) return;
  if (_loading) return _loading;
  if (Date.now() - _lastFailureAt < LOAD_FAILURE_COOLDOWN_MS) {
    throw new Error("WFM catalog fetch failed recently, retry pending");
  }

  _loading = (async () => {
    try {
      log.info("[WFMCatalog] Fetching item catalog (v2)...");

      let rawItems: unknown[] = [];
      let source = "backend";
      try {
        rawItems = await _fetchBackendCatalog();
      } catch (e) {
        log.warn("[WFMCatalog] backend catalog fetch failed:", normalizeErrorMessage(e));
      }

      if (!rawItems.length) {
        source = "wfm";
        try {
          // Route through wfmClient so the load spends the same global request
          // budget as every other WFM call; the scheduler replays transport and
          // HTTP failures (4 sends per request at worst) and background priority
          // keeps this sweep behind anything a user is waiting on.
          let data: unknown = null;
          // A 200 whose body does not unwrap is no failure to the scheduler, so
          // one more send covers that case here.
          for (let attempt = 1; attempt <= 2 && data == null; attempt++) {
            const json = await wfmClient.requestV2("GET", ITEMS_PATH, { priority: "background" });
            data = unwrapWfmResponse(json);
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deeply nested untyped WFM catalog
          const d = (data ?? {}) as Record<string, any>;
          if (Array.isArray(d.items)) {
            rawItems = d.items;
          } else if (d.items && typeof d.items === "object") {
            rawItems = Object.entries(d.items as Record<string, unknown>).map(([k, v]) =>
              v && typeof v === "object" ? { _slug: k, ...(v as object) } : { _slug: k },
            );
          } else if (Array.isArray(data)) {
            rawItems = data;
          }
        } catch (e) {
          log.warn(`[WFMCatalog] fetch ${ITEMS_PATH} failed:`, normalizeErrorMessage(e));
        }
      }

      // An empty catalog must not latch: leave _loaded false so the next
      // demand (renderer retry, search, order form) triggers a fresh fetch.
      if (!rawItems.length) {
        _lastFailureAt = Date.now();
        throw new Error("WFM catalog fetch returned no items");
      }
      _lastFailureAt = 0;

      _items = rawItems.map(_normalise);

      _byId.clear();
      _bySlug.clear();
      _byNameLc.clear();
      _byGameRefLc.clear();

      for (const item of _items) {
        if (item.id) _byId.set(item.id, item);
        if (item.url_name) _bySlug.set(item.url_name, item);
        const nameLc = (item.item_name || "").toLowerCase();
        if (nameLc) _byNameLc.set(nameLc, item);
        const gameRefLc = (item.gameRef || "").toLowerCase();
        if (gameRefLc) _byGameRefLc.set(gameRefLc, item);

        const slugName = item.url_name
          .replace(SLUG_SET_SUFFIX_RE, "")
          .replace(/_/g, " ")
          .replace(/\b[a-z]/g, (c: string) => c.toUpperCase());
        const slugNameLc = slugName.toLowerCase();
        if (slugNameLc && !_byNameLc.has(slugNameLc)) {
          _byNameLc.set(slugNameLc, item);
        }

        // A few listings append "(Key)" or "(Veiled)" while the game says the bare
        // name. Real names are set above, so an alias never displaces one.
        const parenBaseLc = (NAME_PAREN_SUFFIX_RE.exec(nameLc)?.[1] ?? "").trim();
        if (parenBaseLc && !_byNameLc.has(parenBaseLc)) {
          _byNameLc.set(parenBaseLc, item);
        }
      }

      _loaded = true;
      log.info(`[WFMCatalog] Loaded ${_items.length} items (${source}).`);
    } finally {
      _loading = null;
    }
  })();

  return _loading;
}

export async function searchItems(query: string, limit: number = 20): Promise<CatalogItem[]> {
  await _load();
  if (!query || query.length < SEARCH_MIN_QUERY_LENGTH) return [];

  const q = query.toLowerCase().trim();

  const startsWith: CatalogItem[] = [];
  const contains: CatalogItem[] = [];

  for (const item of _items) {
    const name = (item.item_name || "").toLowerCase();
    if (name.startsWith(q)) {
      startsWith.push(item);
    } else if (name.includes(q)) {
      contains.push(item);
    }
    if (startsWith.length + contains.length >= limit * SEARCH_SCAN_MULTIPLIER) break;
  }

  return [...startsWith, ...contains].slice(0, limit);
}

export function isLoaded(): boolean {
  return _loaded;
}

export async function ensureLoaded(): Promise<number> {
  await _load();
  return _items.length;
}

export function lookupByName(itemName: string): CatalogItem | null {
  if (!itemName) return null;
  const key = String(itemName).toLowerCase();
  let item = _byNameLc.get(key);
  if (item) return item;

  item = _byNameLc.get(`${key}${NAME_SET_SUFFIX}`);
  if (item) return item;

  if (key.endsWith(NAME_SET_SUFFIX)) {
    return _byNameLc.get(key.slice(0, -NAME_SET_SUFFIX.length)) || null;
  }

  return null;
}

export function getRendererLookup(): Record<string, Record<string, unknown>> {
  const lookup: Record<string, Record<string, unknown>> = {};
  for (const [name, item] of _byNameLc.entries()) {
    lookup[name] = {
      url_name: item.url_name,
      item_name: item.item_name,
      thumb: item.thumb,
      icon: item.icon,
      maxRank: item.maxRank,
      gameRef: item.gameRef,
    };
  }
  for (const [gameRefLc, item] of _byGameRefLc.entries()) {
    if (lookup[gameRefLc]) continue;
    lookup[gameRefLc] = {
      url_name: item.url_name,
      item_name: item.item_name,
      thumb: item.thumb,
      icon: item.icon,
      maxRank: item.maxRank,
      gameRef: item.gameRef,
    };
  }
  return lookup;
}

interface SetPart {
  slug: string;
  quantityInSet: number;
}

type SetLookup =
  | { kind: "set"; setSlug: string; parts: SetPart[] }
  | { kind: "not-set" }
  | { kind: "unavailable" };

const NOT_SET: SetLookup = { kind: "not-set" };
const UNAVAILABLE: SetLookup = { kind: "unavailable" };
const _setLookupCache = new Map<string, SetLookup>();
const _setLookupInFlight = new Map<string, Promise<SetLookup>>();

async function loadSetMembership(itemSlug: string): Promise<SetLookup> {
  let items: unknown[];
  try {
    const json = await wfmClient.requestV2("GET", `/item/${encodeURIComponent(itemSlug)}/set`);
    const data = unwrapWfmResponse(json) as { items?: unknown[] } | null;
    if (!Array.isArray(data?.items)) return UNAVAILABLE;
    items = data.items;
  } catch (e) {
    if (e instanceof WfmApiError && e.status === 404) {
      _setLookupCache.set(itemSlug, NOT_SET);
      return NOT_SET;
    }
    log.warn(`[WFMCatalog] set lookup ${itemSlug} failed:`, normalizeErrorMessage(e));
    return UNAVAILABLE;
  }

  const roots: string[] = [];
  const parts: SetPart[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") return UNAVAILABLE;
    const item = raw as Record<string, unknown>;
    if (typeof item.slug !== "string" || !item.slug) return UNAVAILABLE;
    if (item.setRoot === true) {
      roots.push(item.slug);
      continue;
    }
    const quantityInSet = item.quantityInSet;
    if (
      typeof quantityInSet !== "number" ||
      !Number.isInteger(quantityInSet) ||
      quantityInSet < 1
    ) {
      return UNAVAILABLE;
    }
    parts.push({ slug: item.slug, quantityInSet });
  }

  if (roots.length !== 1 || parts.length < 2) return UNAVAILABLE;
  const setSlug = roots[0];
  if (itemSlug !== setSlug && !parts.some((part) => part.slug === itemSlug)) return UNAVAILABLE;

  const result: SetLookup = { kind: "set", setSlug, parts };
  _setLookupCache.set(setSlug, result);
  for (const part of parts) _setLookupCache.set(part.slug, result);
  return result;
}

/** Resolves a traded item to its complete set without guessing on API failures. */
export function resolveSetMembership(itemSlug: string): Promise<SetLookup> {
  if (!itemSlug) return Promise.resolve(UNAVAILABLE);
  const cached = _setLookupCache.get(itemSlug);
  if (cached) return Promise.resolve(cached);

  const active = _setLookupInFlight.get(itemSlug);
  if (active) return active;

  const lookup = loadSetMembership(itemSlug).finally(() => {
    if (_setLookupInFlight.get(itemSlug) === lookup) _setLookupInFlight.delete(itemSlug);
  });
  _setLookupInFlight.set(itemSlug, lookup);
  return lookup;
}

export async function lookupById(id: string): Promise<CatalogItem | null> {
  await _load();
  return _byId.get(id) || null;
}

export async function lookupBySlug(slug: string): Promise<CatalogItem | null> {
  await _load();
  return _bySlug.get(slug) || null;
}
