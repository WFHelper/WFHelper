import { importCache } from "./priceCache.js";
import type { CachedPriceEntry } from "./priceCache.js";
import { importOrderSummaryCache } from "./orderSummaryCache.js";
import type { CachedOrderSummaryEntry } from "./orderSummaryCache.js";
import { importMetaFromSnapshot } from "./wfmItemMeta.js";
import type { WfmItemMeta } from "./wfmItemMeta.js";
import { fetchBackendRaw, isBackendLiteConfigured } from "./backendLite.js";
import { schedulePriceCacheRevision } from "../../stores/pricing.js";
import { log } from "../log.js";
import { ipc } from "../ipc.js";

const SNAPSHOT_FRESH_MS = 2 * 60 * 60 * 1000; // 2 hours
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_FETCH_TIMEOUT_MS = 20_000;

// In-memory ETag for the snapshot. Persisted across re-fetches within the same
// session. On startup the disk cache path skips the network entirely if fresh,
// so the ETag is only relevant for mid-session re-fetches (not yet implemented)
// but wiring it now keeps the door open at zero extra cost.
let _cachedEtag: string | null = null;

interface SnapshotBlob {
  version: number;
  generatedAt: number;
  prices: Record<string, CachedPriceEntry>;
  meta: Record<string, WfmItemMeta>;
  orderSummaries: Record<string, CachedOrderSummaryEntry>;
}

function isValidSnapshot(d: unknown): d is SnapshotBlob {
  return (
    typeof d === "object" &&
    d !== null &&
    (d as SnapshotBlob).version === SNAPSHOT_VERSION &&
    typeof (d as SnapshotBlob).generatedAt === "number" &&
    typeof (d as SnapshotBlob).prices === "object" &&
    (d as SnapshotBlob).prices !== null &&
    typeof (d as SnapshotBlob).meta === "object" &&
    (d as SnapshotBlob).meta !== null &&
    typeof (d as SnapshotBlob).orderSummaries === "object" &&
    (d as SnapshotBlob).orderSummaries !== null
  );
}

/**
 * Called once during app startup. Loads the bulk snapshot from disk (if < 2 h
 * old) or fetches it from the backend. Imports into all three in-memory caches
 * (prices, meta, order summaries). Never throws — falls back gracefully.
 */
export async function tryLoadSnapshot(): Promise<void> {
  if (!isBackendLiteConfigured()) return;

  try {
    let snapshot: SnapshotBlob | null = null;

    // 1. Try disk cache first
    try {
      const disk = await ipc.loadSnapshotCache();
      if (disk && isValidSnapshot(disk)) {
        if (Date.now() - disk.generatedAt < SNAPSHOT_FRESH_MS) {
          snapshot = disk;
          log.info("[Snapshot] Using fresh disk cache");
        }
      }
    } catch {
      // disk load failure is non-fatal — proceed to fetch
    }

    // 2. Fetch from backend if disk miss or stale
    if (!snapshot) {
      const fetchHeaders: Record<string, string> = {};
      if (_cachedEtag) fetchHeaders["If-None-Match"] = _cachedEtag;

      const response = await fetchBackendRaw("/v1/snapshot", {
        timeoutMs: SNAPSHOT_FETCH_TIMEOUT_MS,
        headers: fetchHeaders,
      });
      if (!response) {
        log.warn("[Snapshot] Fetch failed — skipping snapshot");
        return;
      }

      // 304 Not Modified: snapshot hasn't changed since the last fetch this session.
      if (response.status === 304) {
        log.info("[Snapshot] 304 Not Modified — snapshot unchanged, skipping re-import");
        return;
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        log.warn("[Snapshot] Failed to parse response JSON — skipping");
        return;
      }

      if (!isValidSnapshot(parsed)) {
        log.warn("[Snapshot] Invalid snapshot shape — skipping");
        return;
      }

      snapshot = parsed;

      // Store ETag for future conditional requests.
      const etag = response.headers.get("etag");
      if (etag) _cachedEtag = etag;

      // Persist to disk for next startup
      try {
        await ipc.saveSnapshotCache(snapshot as unknown as Record<string, unknown>);
      } catch {
        // non-fatal
      }
    }

    // 3. Import into all three in-memory caches
    const pCount = importCache(snapshot.prices);
    const mCount = importMetaFromSnapshot(snapshot.meta);
    const oCount = importOrderSummaryCache(snapshot.orderSummaries);
    const ageMins = Math.round((Date.now() - snapshot.generatedAt) / 60_000);

    log.info(
      `[Snapshot] Imported — prices: ${pCount}, meta: ${mCount}, ` +
        `orderSummaries: ${oCount} (age: ${ageMins} min)`,
    );

    // Signal reactive subscribers (e.g. RelicsView) that the price cache has
    // been bulk-updated so they re-evaluate cached lookups.
    if (pCount > 0 || oCount > 0) {
      schedulePriceCacheRevision();
    }
  } catch (err) {
    log.warn(
      "[Snapshot] Load failed — continuing without snapshot",
      err instanceof Error ? err : undefined,
    );
  }
}
