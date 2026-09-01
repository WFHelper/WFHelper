import { invoke } from "./ipc.js";
import { onInventoryLoaded } from "./actions.js";
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
const WFM_ITEMS_RETRY_BASE_MS = 30_000;
const WFM_ITEMS_RETRY_MAX_MS = 300_000;

/** Becomes true after startup attempts to restore the persisted price cache. */
export const startupPriceCacheReady = writable(false);

interface StartupHandle {
  /** Call to cancel the startup warmup timer and price-cache flush interval. */
  dispose: () => void;
}

interface StartupOptions {
  /** False in a pop-out window: its smaller hotset must not overwrite the main window's. */
  ownsSharedCaches?: boolean;
}

/** Startup load: item DB + WFM items, update state, delayed relic price warmup. */
export function initStartup(options: StartupOptions = {}): StartupHandle {
  const ownsSharedCaches = options.ownsSharedCaches !== false;
  let disposed = false;
  let warmupTimer: ReturnType<typeof setTimeout> | null = null;
  let flushInterval: ReturnType<typeof setInterval> | null = null;
  let wfmItemsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  const startupStartedAt = Date.now();

  const profileStage = (label: string, startedAt: number): void => {
    log.info(`[StartupProfile] ${label}: ${Date.now() - startedAt}ms`);
  };

  startupPriceCacheReady.set(false);

  // The steps below are independent, so they run concurrently: a slow (or
  // missing) snapshot network fetch must not hold the local IPC loads hostage;
  // worst-case startup is max(network, local), not their sum.
  void (async () => {
    // Hotset and snapshot both write the shared price caches, so only these
    // two stay ordered relative to each other.
    const priceCacheTask = (async () => {
      try {
        const stageStart = Date.now();
        const rankedHotset = await invoke("loadRankedHotset");
        if (disposed) return;
        if (rankedHotset) {
          const count = importRankedHotset(rankedHotset);
          log.info(`[Startup] Restored ${count} ranked hotset entries from disk cache`);
        }
        profileStage("ranked-hotset:load", stageStart);
      } catch (e) {
        log.warn("[Startup] loadRankedHotset failed:", e);
      }

      // Bulk snapshot: populates all three caches in one network request (best-effort)
      try {
        const stageStart = Date.now();
        await tryLoadSnapshot();
        if (disposed) return;
        log.info(`[StartupProfile] snapshot:load: ${Date.now() - stageStart}ms`);
      } catch {
        // tryLoadSnapshot never throws, this is just a safety net
      } finally {
        if (!disposed) startupPriceCacheReady.set(true);
      }
    })();

    const itemDbTask = (async () => {
      try {
        const stageStart = Date.now();
        const db = await invoke("getItemDatabase");
        if (disposed) return;
        itemDb.set(db || {});
        profileStage("item-db:load", stageStart);
      } catch (e) {
        log.error("[Startup] getItemDatabase failed:", e);
      }
    })();

    // Main pushes inventory once, on the window's first load. A reload past that
    // point kept the stores empty until the helper next rewrote the file, so pull
    // it here too; onInventoryLoaded is idempotent and a push may still beat us.
    const inventoryTask = (async () => {
      try {
        const stageStart = Date.now();
        const inventory = await invoke("getInventory");
        if (disposed) return;
        if (inventory && !(inventory as { error?: unknown }).error) {
          await onInventoryLoaded(inventory as Parameters<typeof onInventoryLoaded>[0]);
        }
        profileStage("inventory:load", stageStart);
      } catch (e) {
        log.error("[Startup] getInventory failed:", e);
      }
    })();

    // A WFM outage at startup must not brick the market for the session:
    // keep re-asking the main process until the catalog comes back non-empty.
    const loadWfmItems = async (): Promise<boolean> => {
      const items = await invoke("getWfmItems");
      if (disposed) return true;
      wfmItems.set(items || {});
      return Object.keys(items || {}).length > 0;
    };

    const scheduleWfmItemsRetry = (delayMs: number): void => {
      if (disposed) return;
      wfmItemsRetryTimer = setTimeout(() => {
        void (async () => {
          let ok = false;
          try {
            ok = await loadWfmItems();
          } catch (e) {
            log.warn("[Startup] getWfmItems retry failed:", e);
          }
          if (disposed) return;
          if (ok) {
            log.info("[Startup] WFM item catalog recovered on retry");
          } else {
            scheduleWfmItemsRetry(Math.min(delayMs * 2, WFM_ITEMS_RETRY_MAX_MS));
          }
        })();
      }, delayMs);
    };

    const wfmItemsTask = (async () => {
      try {
        const stageStart = Date.now();
        const ok = await loadWfmItems();
        if (disposed) return;
        profileStage("wfm-items:load", stageStart);
        if (!ok) scheduleWfmItemsRetry(WFM_ITEMS_RETRY_BASE_MS);
      } catch (e) {
        log.error("[Startup] getWfmItems failed:", e);
        scheduleWfmItemsRetry(WFM_ITEMS_RETRY_BASE_MS);
      }
    })();

    const updateStateTask = (async () => {
      try {
        const stageStart = Date.now();
        const state = await invoke("getAppUpdateState");
        if (disposed) return;
        applyUpdateState(state, false);
        profileStage("app-update-state:load", stageStart);
      } catch {
        // optional feature, non-blocking
      }
    })();

    await Promise.allSettled([
      priceCacheTask,
      itemDbTask,
      inventoryTask,
      wfmItemsTask,
      updateStateTask,
    ]);
    if (disposed) return;
    warmupTimer = setTimeout(() => {
      if (disposed) return;
      void startPrimePriceWarmup();
    }, STARTUP_RELIC_WARMUP_DELAY_MS);

    if (ownsSharedCaches) {
      flushInterval = setInterval(() => {
        void flushPriceCacheToDisk();
      }, PRICE_CACHE_FLUSH_INTERVAL_MS);
    }

    profileStage("total-renderer-startup-sequence", startupStartedAt);
  })();

  const handleBeforeUnload = (): void => {
    void flushPriceCacheToDisk();
  };

  if (ownsSharedCaches && typeof window !== "undefined") {
    window.addEventListener("beforeunload", handleBeforeUnload);
  }

  return {
    dispose() {
      disposed = true;
      if (warmupTimer) {
        clearTimeout(warmupTimer);
        warmupTimer = null;
      }
      if (flushInterval) {
        clearInterval(flushInterval);
        flushInterval = null;
      }
      if (wfmItemsRetryTimer) {
        clearTimeout(wfmItemsRetryTimer);
        wfmItemsRetryTimer = null;
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("beforeunload", handleBeforeUnload);
      }
      if (ownsSharedCaches) void flushPriceCacheToDisk();
    },
  };
}

async function flushPriceCacheToDisk(): Promise<void> {
  try {
    const hotsetData = exportRankedHotset();
    if (Array.isArray(hotsetData.entries) && hotsetData.entries.length > 0) {
      await invoke("saveRankedHotset", hotsetData);
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
