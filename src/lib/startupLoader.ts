import { ipc } from "./ipc.js";
import { itemDb, wfmItems } from "../stores/data.js";
import { relicDb } from "../stores/relics.js";
import { debugMode } from "../stores/app.js";
import { applyUpdateState } from "../stores/updates.js";
import { configureRelicRuntimeCacheFingerprint, warmupPrimeRewardPriceCache } from "./relic.js";
import { importCache, exportCache } from "./wfm/priceCache.js";
import type { CachedPriceEntry } from "./wfm/priceCache.js";
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

  startupPriceCacheReady.set(false);

  void (async () => {
    try {
      await ipc.setDebugMode(get(debugMode));
    } catch {
      // not critical
    }

    // Restore persisted price cache before any price fetches happen
    try {
      const diskCache = await ipc.loadPriceCache();
      if (diskCache) {
        const count = importCache(diskCache as Record<string, CachedPriceEntry>);
        log.info(`[Startup] Restored ${count} prices from disk cache`);
      }
    } catch (e) {
      log.warn("[Startup] loadPriceCache failed:", e);
    } finally {
      startupPriceCacheReady.set(true);
    }

    try {
      const db = await ipc.getItemDatabase();
      itemDb.set(db || {});
    } catch (e) {
      log.error("[Startup] getItemDatabase failed:", e);
    }

    try {
      const items = await ipc.getWfmItems();
      wfmItems.set(items || {});
    } catch (e) {
      log.error("[Startup] getWfmItems failed:", e);
    }

    try {
      const state = await ipc.getAppUpdateState();
      applyUpdateState(state, false);
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
    const data = exportCache();
    if (Object.keys(data).length === 0) return;
    await ipc.savePriceCache(data as Record<string, unknown>);
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
