import { importCache } from "./priceCache.js";
import { WFM_PRICE_BASIS } from "../../../config/shared/wfmStats.js";
import type { CachedPriceEntry } from "./priceCache.js";
import { exceedsCachedOrderBook, importOrderSummaryCache } from "./orderSummaryCache.js";
import { parseWfmCacheKey } from "../../../config/shared/wfmCacheKeys.js";
import type { CachedOrderSummaryEntry } from "./orderSummaryCache.js";
import { importMetaFromSnapshot, importSetCatalogFromSnapshotMeta } from "./wfmItemMeta.js";
import type { WfmItemMeta } from "./wfmItemMeta.js";
import { fetchBackendRaw, isBackendLiteConfigured } from "./backendLite.js";
import { schedulePriceCacheRevision } from "../../stores/pricing.js";
import { log } from "../log.js";
import { invoke } from "../ipc.js";
import {
  WFM_SNAPSHOT_CLIENT_CACHE_VERSION,
  isValidSnapshotBlob,
} from "../../../config/shared/wfmSnapshotValidation.js";

const SNAPSHOT_FRESH_MS = 2 * 60 * 60 * 1000;
const SNAPSHOT_FETCH_TIMEOUT_MS = 20_000;

// The ETag applies only to repeated loads in one renderer session; a fresh disk
// cache skips the network entirely.
let _cachedEtag: string | null = null;

// Object type alias (not interface) so it carries an implicit index signature
// and is assignable to the Record<string, unknown> IPC payload type without a cast.
type SnapshotBlob = {
  version: number;
  generatedAt: number;
  prices: Record<string, CachedPriceEntry>;
  meta: Record<string, WfmItemMeta>;
  orderSummaries: Record<string, CachedOrderSummaryEntry>;
};

function isValidSnapshot(d: unknown): d is SnapshotBlob {
  return isValidSnapshotBlob(d);
}

// Reads the order summary cache, so the snapshot's summaries are imported first.
function withoutOrderBookOutliers(
  prices: Record<string, CachedPriceEntry>,
): Record<string, CachedPriceEntry> {
  const kept: Record<string, CachedPriceEntry> = {};
  for (const [key, entry] of Object.entries(prices)) {
    const parsed = parseWfmCacheKey(key);
    if (
      entry.status === "ok" &&
      entry.median != null &&
      parsed &&
      exceedsCachedOrderBook(parsed.slug, parsed.rank, entry.median)
    ) {
      continue;
    }
    kept[key] = entry;
  }
  return kept;
}

// Load a fresh disk snapshot or fetch one, then populate all in-memory caches.
// Failures are logged and do not reject startup.
export async function tryLoadSnapshot(): Promise<void> {
  if (!isBackendLiteConfigured()) return;

  try {
    let snapshot: SnapshotBlob | null = null;
    let staleMeta: Record<string, WfmItemMeta> | undefined;

    // disk cache first
    try {
      const disk = await invoke("loadSnapshotCache");
      if (disk && isValidSnapshot(disk)) {
        if (
          Date.now() - disk.generatedAt < SNAPSHOT_FRESH_MS &&
          Object.values(disk.prices).every((price) => price.priceBasis === WFM_PRICE_BASIS)
        ) {
          snapshot = disk;
          log.info("[Snapshot] Using fresh disk cache");
        } else {
          staleMeta = disk.meta;
        }
      }
    } catch {
      // disk load failure is non-fatal - proceed to fetch
    }

    // disk miss or stale -> fetch from backend
    if (!snapshot) {
      const fetchHeaders: Record<string, string> = {};
      if (_cachedEtag) fetchHeaders["If-None-Match"] = _cachedEtag;

      const response = await fetchBackendRaw(
        `/v1/snapshot?client=${WFM_SNAPSHOT_CLIENT_CACHE_VERSION}`,
        {
          timeoutMs: SNAPSHOT_FETCH_TIMEOUT_MS,
          headers: {
            ...fetchHeaders,
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
          },
          cache: "no-store",
        },
      );
      if (!response) {
        if (staleMeta) importSetCatalogFromSnapshotMeta(staleMeta);
        log.warn("[Snapshot] Fetch failed - skipping snapshot");
        return;
      }

      // 304 Not Modified: snapshot hasn't changed since the last fetch this session.
      if (response.status === 304) {
        log.info("[Snapshot] 304 Not Modified - snapshot unchanged, skipping re-import");
        return;
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        if (staleMeta) importSetCatalogFromSnapshotMeta(staleMeta);
        log.warn("[Snapshot] Failed to parse response JSON - skipping");
        return;
      }

      if (!isValidSnapshot(parsed)) {
        if (staleMeta) importSetCatalogFromSnapshotMeta(staleMeta);
        log.warn("[Snapshot] Invalid snapshot shape - skipping");
        return;
      }

      snapshot = parsed;

      // Store ETag for future conditional requests.
      const etag = response.headers.get("etag");
      if (etag) _cachedEtag = etag;

      // Persist to disk for next startup
      try {
        await invoke("saveSnapshotCache", snapshot);
      } catch {
        // non-fatal
      }
    }

    const oCount = importOrderSummaryCache(snapshot.orderSummaries);
    const pCount = importCache(withoutOrderBookOutliers(snapshot.prices));
    const mCount = importMetaFromSnapshot(snapshot.meta);
    let sCount = importSetCatalogFromSnapshotMeta(snapshot.meta);
    if (sCount === 0 && staleMeta) sCount = importSetCatalogFromSnapshotMeta(staleMeta);
    const ageMins = Math.round((Date.now() - snapshot.generatedAt) / 60_000);

    log.info(
      `[Snapshot] Imported - prices: ${pCount}, meta: ${mCount}, ` +
        `orderSummaries: ${oCount}, sets: ${sCount} (age: ${ageMins} min)`,
    );

    // Signal reactive subscribers (e.g. RelicsView) that the price cache has
    // been bulk-updated so they re-evaluate cached lookups.
    if (pCount > 0 || oCount > 0) {
      schedulePriceCacheRevision();
    }
  } catch (err) {
    log.warn(
      "[Snapshot] Load failed - continuing without snapshot",
      err instanceof Error ? err : undefined,
    );
  }
}
