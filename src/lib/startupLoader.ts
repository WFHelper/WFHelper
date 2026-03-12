import { ipc } from "./ipc.js";
import { itemDb, wfmItems } from "../stores/data.js";
import { relicDb } from "../stores/relics.js";
import { debugMode } from "../stores/app.js";
import { applyUpdateState } from "../stores/updates.js";
import { configureRelicRuntimeCacheFingerprint, warmupPrimeRewardPriceCache } from "./relic.js";
import { importCache, exportCache } from "./wfm/priceCache.js";
import type { CachedPriceEntry } from "./wfm/priceCache.js";
import { importOrderSummaryCache, exportOrderSummaryCache } from "./wfm/orderSummaryCache.js";
import type { CachedOrderSummaryEntry } from "./wfm/orderSummaryCache.js";
import { exportRankedHotset, importRankedHotset } from "./wfm/rankedHotset.js";
import { tryLoadSnapshot } from "./wfm/snapshotLoader.js";
import { log } from "./log.js";
import { get } from "svelte/store";
import { writable } from "svelte/store";

const STARTUP_RELIC_WARMUP_DELAY_MS = 2500;
const PRICE_CACHE_FLUSH_INTERVAL_MS = 30_000;

/** Becomes true after startup attempts to restore the persisted price cache. */
export const startupPriceCacheReady = writable(false);

export interface StartupHandle {
  /** Call to cancel the startup warmup timer and price-cache flush interval. */
  dispose: () => void;
}

/**
 * Performs the initial data loading sequence on app startup:
 * 1. Sends current debug mode to the main process
 * 2. Fetches the item database and WFM items
 * 3. Fetches current update state
 * 4. Schedules a relic price warmup after a short delay
 */
export function initStartup(): StartupHandle {
  let warmupTimer: ReturnType<typeof setTimeout> | null = null;
  let flushInterval: ReturnType<typeof setInterval> | null = null;
  const startupStartedAt = Date.now();

  const profileStage = (label: string, startedAt: number): void => {
    log.info(`[StartupProfile] ${label}: ${Date.now() - startedAt}ms`);
  };

  startupPriceCacheReady.set(false);

  void (async () => {
    try {
      await ipc.setDebugMode(get(debugMode));
    } catch {
      // not critical
    }

    // Restore persisted price cache before any price fetches happen
    try {
      const stageStart = Date.now();
      const diskCache = await ipc.loadPriceCache();
      if (diskCache) {
        const count = importCache(diskCache as Record<string, CachedPriceEntry>);
        log.info(`[Startup] Restored ${count} prices from disk cache`);
      }
      profileStage("price-cache:load", stageStart);
    } catch (e) {
      log.warn("[Startup] loadPriceCache failed:", e);
    }

    // Restore persisted ranked order summary cache (WTS/WTB card data)
    try {
      const stageStart = Date.now();
      const orderDiskCache = await ipc.loadOrderCache();
      if (orderDiskCache) {
        const count = importOrderSummaryCache(
          orderDiskCache as Record<string, CachedOrderSummaryEntry>,
        );
        log.info(`[Startup] Restored ${count} order summaries from disk cache`);
      }
      profileStage("order-cache:load", stageStart);
    } catch (e) {
      log.warn("[Startup] loadOrderCache failed:", e);
    }

    try {
      const stageStart = Date.now();
      const rankedHotset = await ipc.loadRankedHotset();
      if (rankedHotset) {
        const count = importRankedHotset(rankedHotset as Record<string, unknown>);
        log.info(`[Startup] Restored ${count} ranked hotset entries from disk cache`);
      }
      profileStage("ranked-hotset:load", stageStart);
    } catch (e) {
      log.warn("[Startup] loadRankedHotset failed:", e);
    } finally {
      startupPriceCacheReady.set(true);
    }

    // Bulk snapshot — populates all three caches in one network request (best-effort)
    try {
      const stageStart = Date.now();
      await tryLoadSnapshot();
      log.info(`[StartupProfile] snapshot:load: ${Date.now() - stageStart}ms`);
    } catch {
      // tryLoadSnapshot never throws, this is just a safety net
    }

    try {
      const stageStart = Date.now();
      const db = await ipc.getItemDatabase();
      itemDb.set(db || {});
      profileStage("item-db:load", stageStart);
    } catch (e) {
      log.error("[Startup] getItemDatabase failed:", e);
    }

    try {
      const stageStart = Date.now();
      const items = await ipc.getWfmItems();
      wfmItems.set(items || {});
      profileStage("wfm-items:load", stageStart);
    } catch (e) {
      log.error("[Startup] getWfmItems failed:", e);
    }

    try {
      const stageStart = Date.now();
      const state = await ipc.getAppUpdateState();
      applyUpdateState(state, false);
      profileStage("app-update-state:load", stageStart);
    } catch {
      // optional feature, non-blocking
    }

    warmupTimer = setTimeout(() => {
      void startPrimePriceWarmup();
    }, STARTUP_RELIC_WARMUP_DELAY_MS);

    // Periodically flush the in-memory price cache to disk
    flushInterval = setInterval(() => {
      void flushPriceCacheToDisk();
    }, PRICE_CACHE_FLUSH_INTERVAL_MS);

    profileStage("total-renderer-startup-sequence", startupStartedAt);
  })();

  // Also flush on page unload (app close / refresh)
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => {
      void flushPriceCacheToDisk();
    });
  }

  return {
    dispose() {
      if (warmupTimer) {
        clearTimeout(warmupTimer);
        warmupTimer = null;
      }
      if (flushInterval) {
        clearInterval(flushInterval);
        flushInterval = null;
      }
      void flushPriceCacheToDisk();
    },
  };
}

async function flushPriceCacheToDisk(): Promise<void> {
  try {
    const priceData = exportCache();
    if (Object.keys(priceData).length > 0) {
      await ipc.savePriceCache(priceData as Record<string, unknown>);
    }

    const orderData = exportOrderSummaryCache();
    if (Object.keys(orderData).length > 0) {
      await ipc.saveOrderCache(orderData as Record<string, unknown>);
    }

    const hotsetData = exportRankedHotset();
    if (Array.isArray(hotsetData.entries) && hotsetData.entries.length > 0) {
      await ipc.saveRankedHotset(hotsetData as unknown as Record<string, unknown>);
    }
  } catch {
    // best-effort, don't log every periodic failure
  }
}

async function startPrimePriceWarmup(): Promise<void> {
  try {
    let db = get(relicDb);
    if (!db) {
      db = await ipc.getRelicDatabase();
      relicDb.set(db);
    }
    if (db) {
      configureRelicRuntimeCacheFingerprint(db);
      await warmupPrimeRewardPriceCache(db);
    }
  } catch (e) {
    log.warn("[Startup] prime price warmup failed:", e);
  }
}
