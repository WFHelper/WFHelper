import { invoke } from "./ipc.js";
import { itemDb, wfmItems } from "../stores/data.js";
import { relicDb } from "../stores/relics.js";
import { applyUpdateState } from "../stores/updates.js";
import { configureRelicRuntimeCacheFingerprint, warmupPrimeRewardPriceCache } from "./relic.js";
import { exportRankedHotset, importRankedHotset } from "./wfm/rankedHotset.js";
import { tryLoadSnapshot } from "./wfm/snapshotLoader.js";
import { log } from "./log.js";
import { get } from "svelte/store";
import { writable } from "svelte/store";

const STARTUP_RELIC_WARMUP_DELAY_MS = 2500;
const PRICE_CACHE_FLUSH_INTERVAL_MS = 30_000;

/** Becomes true after startup attempts to restore the persisted price cache. */
export const startupPriceCacheReady = writable(false);

interface StartupHandle {
  /** Call to cancel the startup warmup timer and price-cache flush interval. */
  dispose: () => void;
}

/**
 * Performs the initial data loading sequence on app startup:
 * 1. Fetches the item database and WFM items
 * 2. Fetches current update state
 * 3. Schedules a relic price warmup after a short delay
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
      const stageStart = Date.now();
      const rankedHotset = await invoke("loadRankedHotset");
      if (rankedHotset) {
        const count = importRankedHotset(rankedHotset as Record<string, unknown>);
        log.info(`[Startup] Restored ${count} ranked hotset entries from disk cache`);
      }
      profileStage("ranked-hotset:load", stageStart);
    } catch (e) {
      log.warn("[Startup] loadRankedHotset failed:", e);
    }

    // Bulk snapshot — populates all three caches in one network request (best-effort)
    try {
      const stageStart = Date.now();
      await tryLoadSnapshot();
      log.info(`[StartupProfile] snapshot:load: ${Date.now() - stageStart}ms`);
    } catch {
      // tryLoadSnapshot never throws, this is just a safety net
    } finally {
      startupPriceCacheReady.set(true);
    }

    try {
      const stageStart = Date.now();
      const db = await invoke("getItemDatabase");
      itemDb.set(db || {});
      profileStage("item-db:load", stageStart);
    } catch (e) {
      log.error("[Startup] getItemDatabase failed:", e);
    }

    try {
      const stageStart = Date.now();
      const items = await invoke("getWfmItems");
      wfmItems.set(items || {});
      profileStage("wfm-items:load", stageStart);
    } catch (e) {
      log.error("[Startup] getWfmItems failed:", e);
    }

    try {
      const stageStart = Date.now();
      const state = await invoke("getAppUpdateState");
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
    const hotsetData = exportRankedHotset();
    if (Array.isArray(hotsetData.entries) && hotsetData.entries.length > 0) {
      await invoke("saveRankedHotset", hotsetData as unknown as Record<string, unknown>);
    }
  } catch {
    // best-effort, don't log every periodic failure
  }
}

async function startPrimePriceWarmup(): Promise<void> {
  try {
    let db = get(relicDb);
    if (!db) {
      db = await invoke("getRelicDatabase");
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
