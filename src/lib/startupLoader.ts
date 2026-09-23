import { invoke } from "./ipc.js";
import { onInventoryLoaded } from "./actions.js";
import { selectionOwnership, selectionTransitions } from "./inventory/selectionAlerts.js";
import { itemDb, parsedItems, wfmItems } from "../stores/data.js";
import { recordSelectionCompleteness, savedSelections } from "../stores/inventorySelection.js";
import { relicDb } from "../stores/relics.js";
import { applyUpdateState } from "../stores/updates.js";
import { ensureOverlaySettingsLoaded } from "../stores/overlaySettings.js";
import { watchBaroWishlistArrivals } from "../stores/baro.js";
import { configureRelicRuntimeCacheFingerprint, warmupPrimeRewardPriceCache } from "./relic.js";
import { exportRankedHotset, importRankedHotset } from "./wfm/rankedHotset.js";
import { refreshWfmPresence } from "./wfm/presence.js";
import { tryLoadSnapshot } from "./wfm/snapshotLoader.js";
import { marketSession } from "../stores/market.js";
import { log } from "./log.js";
// Tells main the game language on import, ahead of the item-DB pull below, so that
// pull already carries localized names.
import "./gameLanguage.js";
import { derived, get } from "svelte/store";
import { writable } from "svelte/store";

const STARTUP_RELIC_WARMUP_DELAY_MS = 2500;
const PRICE_CACHE_FLUSH_INTERVAL_MS = 30_000;
const WFM_ITEMS_RETRY_BASE_MS = 30_000;
const WFM_ITEMS_RETRY_MAX_MS = 300_000;

/** Becomes true after startup attempts to restore the persisted price cache. */
export const startupPriceCacheReady = writable(false);

let itemDbPull: Promise<void> | null = null;
let lastSavedHotset: string | null = null;

function pullItemDatabase(): Promise<void> {
  const pull = invoke("getItemDatabase").then((db) => {
    itemDb.set(db || {});
  });
  itemDbPull = pull;
  const settle = (): void => {
    if (itemDbPull === pull) itemDbPull = null;
  };
  pull.then(settle, settle);
  return pull;
}

/** For item-db-updated. Main answers in order, so an update that arrives while a
    pull is in flight was sent before that reply, which already carries it. */
export async function refreshItemDatabase(): Promise<void> {
  const inFlight = itemDbPull;
  if (inFlight) {
    try {
      await inFlight;
      return;
    } catch {
      // Its own caller reports the failure; this update still needs a pull.
    }
  }
  await pullItemDatabase();
}

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

  // Pop-outs run their own startup; the tag keeps them apart from the main window.
  const profileTag = ownsSharedCaches ? "StartupProfile" : "StartupProfile:popout";
  const profileStage = (label: string, startedAt: number): void => {
    log.timing(`[${profileTag}] ${label}: ${Date.now() - startedAt}ms`);
  };

  startupPriceCacheReady.set(false);

  // Before any view mounts: a lazily mounted view reads these stores on its
  // first paint and would otherwise show defaults for the user's saved settings.
  void ensureOverlaySettingsLoaded();

  // These steps are independent and run concurrently: a slow snapshot fetch must
  // not hold up local IPC loads; worst case is max(network, local), not their sum.
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
        profileStage("snapshot:load", stageStart);
      } catch {
        // tryLoadSnapshot never throws, this is just a safety net
      } finally {
        if (!disposed) startupPriceCacheReady.set(true);
      }
    })();

    const itemDbTask = (async () => {
      try {
        const stageStart = Date.now();
        await pullItemDatabase();
        if (disposed) return;
        profileStage("item-db:load", stageStart);
      } catch (e) {
        log.error("[Startup] getItemDatabase failed:", e);
      }
    })();

    // Main pushes inventory once, on first load. A reload after that leaves stores
    // empty until the next file write, so pull it here too; onInventoryLoaded is idempotent.
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

    // The titlebar status pill is visible on every tab, so the session and the
    // presence it reads cannot wait for the Market tab to be opened.
    const wfmSessionTask = (async () => {
      try {
        const stageStart = Date.now();
        const session = await invoke("wfmGetSession");
        if (disposed) return;
        marketSession.set(session);
        profileStage("wfm-session:load", stageStart);
        if (!session.loggedIn) return;
        await refreshWfmPresence();
      } catch (e) {
        log.warn("[Startup] wfmGetSession failed:", e);
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
      wfmSessionTask,
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

  // Pop-outs share the same saved selections, so only the owning window may
  // watch them; two subscribers would fire the notification twice.
  const stopSelectionAlerts = ownsSharedCaches ? watchSelectionAlerts() : null;
  const stopBaroAlerts = ownsSharedCaches ? watchBaroWishlistArrivals() : null;

  return {
    dispose() {
      disposed = true;
      stopSelectionAlerts?.();
      stopBaroAlerts?.();
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

/** Watches saved bulk sell selections for the moment every key becomes owned.
 *  Lives here, not in a view, since views mount lazily and completion can happen anytime. */
function watchSelectionAlerts(): () => void {
  let evaluating = false;
  // Completeness is recorded only once the notification landed, so a rejected
  // IPC re-arms the alert; this keeps the retry from notifying twice.
  const notifying = new Set<string>();
  const inputs = derived([parsedItems, savedSelections], ([items, selections]) => ({
    items,
    selections,
  }));
  return inputs.subscribe(({ items, selections }) => {
    // Recording re-enters this subscriber; without the guard a second pending
    // transition would notify twice before its own record landed.
    if (evaluating || items.length === 0) return;
    evaluating = true;
    try {
      const fired = selectionTransitions(selections, items).filter(
        (selection) => !notifying.has(selection.name),
      );
      for (const selection of fired) notifying.add(selection.name);
      for (const selection of selections) {
        if (selection.alertWhenComplete !== true || notifying.has(selection.name)) continue;
        recordSelectionCompleteness(selection.name, selectionOwnership(selection, items).complete);
      }
      for (const selection of fired) {
        const owned = selectionOwnership(selection, items).owned;
        void invoke("notifySelectionComplete", { name: selection.name, owned })
          .then(() => {
            // The set can break while the notify is in flight; recording it complete
            // then would disarm an alert that must fire again (empty list = reload, not loss).
            const current = get(parsedItems);
            recordSelectionCompleteness(
              selection.name,
              current.length === 0 || selectionOwnership(selection, current).complete,
            );
          })
          .catch((e) => {
            log.warn("[Startup] selection complete notification failed:", e);
          })
          .finally(() => {
            notifying.delete(selection.name);
          });
      }
    } finally {
      evaluating = false;
    }
  });
}

async function flushPriceCacheToDisk(): Promise<void> {
  try {
    const hotsetData = exportRankedHotset();
    if (!Array.isArray(hotsetData.entries) || hotsetData.entries.length === 0) return;
    // Each save is a synchronous fsync + rename in main, every 30s while idle.
    const serialized = JSON.stringify(hotsetData);
    if (serialized === lastSavedHotset) return;
    const result = await invoke("saveRankedHotset", hotsetData);
    if (result?.ok) lastSavedHotset = serialized;
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
