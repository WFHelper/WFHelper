<script lang="ts">
  import { onMount } from "svelte";

  import Titlebar from "./components/Titlebar.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import ErrorBoundary from "./components/ErrorBoundary.svelte";
  import ToastHost from "./components/ToastHost.svelte";

  import WelcomeView from "./views/WelcomeView.svelte";
  import InventoryView from "./views/InventoryView.svelte";
  import FoundryView from "./views/FoundryView.svelte";
  import ResourcesView from "./views/ResourcesView.svelte";
  import MasteryView from "./views/MasteryView.svelte";
  import WorldView from "./views/WorldView.svelte";
  import MarketView from "./views/MarketView.svelte";
  import RelicsView from "./views/RelicsView.svelte";
  import SettingsView from "./views/SettingsView.svelte";

  import ItemDetailModal from "./modals/ItemDetailModal.svelte";
  import ComponentDetailModal from "./modals/ComponentDetailModal.svelte";
  import RelicDetailModal from "./modals/RelicDetailModal.svelte";
  import OrderModal from "./modals/OrderModal.svelte";

  import { currentView, statusText, debugMode } from "./stores/app.js";
  import { itemDb, wfmItems, parsedItems } from "./stores/data.js";
  import { activeItem, activeComponent, activeRelic } from "./stores/modals.js";
  import { relicDb } from "./stores/relics.js";
  import { appUpdateState } from "./stores/updates.js";
  import { addToast } from "./stores/toasts.js";
  import { onInventoryLoaded, setInventoryStatus } from "./lib/actions.js";
  import { flushCache } from "./lib/priceCache.js";
  import {
    configureRelicRuntimeCacheFingerprint,
    flushRelicRuntimeCache,
    warmupPrimeRewardPriceCache,
  } from "./lib/relic.js";
  import { ipc } from "./lib/ipc.js";

  const STARTUP_RELIC_WARMUP_DELAY_MS = 2500;

  $: setInventoryStatus($parsedItems.length);

  onMount(() => {
    let startupWarmupTimer: ReturnType<typeof setTimeout> | null = null;
    let lastNotifiedUpdateStatus = "";

    void (async () => {
      try {
        await ipc.setDebugMode($debugMode);
      } catch {
        // not critical
      }

      try {
        const db = await ipc.getItemDatabase();
        itemDb.set(db || {});
      } catch (e) {
        console.error("[App] getItemDatabase failed:", e);
      }

      try {
        const items = await ipc.getWfmItems();
        wfmItems.set(items || {});
      } catch (e) {
        console.error("[App] getWfmItems failed:", e);
      }

      try {
        const state = await ipc.getAppUpdateState();
        applyUpdateState(state, false);
      } catch {
        // optional feature, non-blocking
      }

      startupWarmupTimer = setTimeout(() => {
        void startPrimePriceWarmup();
      }, STARTUP_RELIC_WARMUP_DELAY_MS);

      ipc.onInventoryUpdated(async (data) => {
        if (data && !(data as { error?: unknown }).error) {
          await onInventoryLoaded(data);
          statusText.set(`Live update - ${$parsedItems.length} items loaded`);
        }
      });

      ipc.onAppUpdateStatus((state) => {
        applyUpdateState(state, true);
      });

      function applyUpdateState(
        state: Awaited<ReturnType<typeof ipc.getAppUpdateState>>,
        showToast: boolean,
      ): void {
        appUpdateState.set(state);
        if (!showToast || state.status === lastNotifiedUpdateStatus) return;
        lastNotifiedUpdateStatus = state.status;

        if (state.status === "available") {
          addToast({
            level: "info",
            title: "Update Available",
            message: state.message || "A new update is available and downloading in the background.",
          });
          return;
        }

        if (state.status === "downloaded") {
          addToast({
            level: "success",
            title: "Update Ready",
            message: state.message || "Update downloaded. Use 'Install update' in the status bar.",
            sticky: true,
          });
          return;
        }

        if (state.status === "error") {
          addToast({
            level: "error",
            title: "Updater Error",
            message: state.message || "Automatic update check failed.",
          });
        }
      }
    })();

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      if (startupWarmupTimer) {
        clearTimeout(startupWarmupTimer);
      }
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("keydown", onKeyDown);
      flushCache();
      flushRelicRuntimeCache();
    };
  });

  $: ipc.setDebugMode($debugMode);

  async function startPrimePriceWarmup(): Promise<void> {
    try {
      let db = $relicDb;
      if (!db) {
        db = await ipc.getRelicDatabase();
        relicDb.set(db);
      }
      if (db) {
        configureRelicRuntimeCacheFingerprint(db);
        await warmupPrimeRewardPriceCache(db);
      }
    } catch (e) {
      console.warn("[App] prime price warmup failed:", e);
    }
  }

  function onBeforeUnload(): void {
    flushCache();
    flushRelicRuntimeCache();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    if ($activeItem) {
      activeItem.set(null);
      return;
    }
    if ($activeComponent) {
      activeComponent.set(null);
      return;
    }
    if ($activeRelic) {
      activeRelic.set(null);
    }
  }
</script>

<ErrorBoundary>
  <Titlebar />

  <div id="app">
    <Sidebar />

    <main id="content">
      {#if $currentView === "welcome"}
        <WelcomeView />
      {:else if $currentView === "inventory"}
        <InventoryView />
      {:else if $currentView === "foundry"}
        <FoundryView />
      {:else if $currentView === "resources"}
        <ResourcesView />
      {:else if $currentView === "mastery"}
        <MasteryView />
      {:else if $currentView === "world"}
        <WorldView />
      {:else if $currentView === "market"}
        <MarketView />
      {:else if $currentView === "relics"}
        <RelicsView />
      {:else if $currentView === "settings"}
        <SettingsView />
      {/if}
    </main>
  </div>

  <StatusBar />

  <ItemDetailModal />
  <ComponentDetailModal />
  <RelicDetailModal />
  <OrderModal />
</ErrorBoundary>

<ToastHost />
