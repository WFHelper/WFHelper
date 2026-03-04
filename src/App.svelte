<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { ComponentType } from "svelte";

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
  import { flushCache } from "./lib/wfm/priceCache.js";
  import {
    configureRelicRuntimeCacheFingerprint,
    flushRelicRuntimeCache,
    warmupPrimeRewardPriceCache,
  } from "./lib/relic.js";
  import {
    beginHeavyViewOpen,
    completeHeavyViewOpen,
    markStartupInteractive,
    type HeavyViewName,
  } from "./lib/perf.js";
  import { ipc } from "./lib/ipc.js";
  import { tr } from "./lib/i18n.js";
  import type { MessageKey } from "./lib/i18n.js";

  const STARTUP_RELIC_WARMUP_DELAY_MS = 2500;

  type ViewName =
    | "welcome"
    | "inventory"
    | "foundry"
    | "resources"
    | "mastery"
    | "world"
    | "market"
    | "relics"
    | "settings";

  type LazyViewName = Extract<ViewName, HeavyViewName>;
  type LazyViewModule = { default: ComponentType };

  const lazyViewLoaders: Record<LazyViewName, () => Promise<LazyViewModule>> = {
    world: () => import("./views/WorldView.svelte"),
    market: () => import("./views/MarketView.svelte"),
    relics: () => import("./views/RelicsView.svelte"),
  };

  const lazyViewCache: Partial<Record<LazyViewName, ComponentType>> = {};

  let lazyViewComponent: ComponentType | null = null;
  let lazyViewLoading = false;
  let lazyViewError = "";
  let activeLazyView: LazyViewName | null = null;
  let lastRequestedLazyView: LazyViewName | null = null;
  let lazyRequestToken = 0;

  $: setInventoryStatus($parsedItems.length);

  onMount(() => {
    let startupWarmupTimer: ReturnType<typeof setTimeout> | null = null;
    let startupInteractiveFrameA: number | null = null;
    let startupInteractiveFrameB: number | null = null;
    let lastNotifiedUpdateStatus = "";

    startupInteractiveFrameA = requestAnimationFrame(() => {
      startupInteractiveFrameB = requestAnimationFrame(() => {
        markStartupInteractive();
      });
    });

    const unsubscribeViewChange = currentView.subscribe((view) => {
      handleViewChange(view);
    });

    const unsubscribeInventoryUpdated = ipc.onInventoryUpdated(async (data) => {
      if (data && !(data as { error?: unknown }).error) {
        await onInventoryLoaded(data);
        statusText.set(`Live update - ${$parsedItems.length} items loaded`);
      }
    });

    const unsubscribeUpdateStatus = ipc.onAppUpdateStatus((state) => {
      applyUpdateState(state, true);
    });

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
    })();

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

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      if (startupWarmupTimer) {
        clearTimeout(startupWarmupTimer);
      }
      if (startupInteractiveFrameA != null) {
        cancelAnimationFrame(startupInteractiveFrameA);
      }
      if (startupInteractiveFrameB != null) {
        cancelAnimationFrame(startupInteractiveFrameB);
      }

      unsubscribeViewChange();
      unsubscribeInventoryUpdated();
      unsubscribeUpdateStatus();

      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("keydown", onKeyDown);
      flushCache();
      flushRelicRuntimeCache();
    };
  });

  $: ipc.setDebugMode($debugMode);

  function isLazyView(view: string): view is LazyViewName {
    return view === "world" || view === "market" || view === "relics";
  }

  function lazyViewLabelKey(view: LazyViewName): MessageKey {
    if (view === "world") return "view.world";
    if (view === "market") return "view.market";
    return "view.relics";
  }

  function handleViewChange(view: string): void {
    if (isLazyView(view)) {
      activeLazyView = view;
      if (lastRequestedLazyView === view) return;

      lastRequestedLazyView = view;
      beginHeavyViewOpen(view);
      void loadLazyView(view);
      return;
    }

    activeLazyView = null;
    lastRequestedLazyView = null;
    lazyViewComponent = null;
    lazyViewLoading = false;
    lazyViewError = "";
  }

  async function loadLazyView(view: LazyViewName): Promise<void> {
    const requestToken = ++lazyRequestToken;
    lazyViewError = "";
    lazyViewLoading = true;

    try {
      let component = lazyViewCache[view];
      if (!component) {
        const loaded = await lazyViewLoaders[view]();
        component = loaded.default;
        lazyViewCache[view] = component;
      }

      if (requestToken !== lazyRequestToken || $currentView !== view) {
        return;
      }

      lazyViewComponent = component;
      lazyViewLoading = false;
      await tick();
      completeHeavyViewOpen(view);
    } catch (err) {
      if (requestToken !== lazyRequestToken || $currentView !== view) {
        return;
      }

      lazyViewComponent = null;
      lazyViewLoading = false;
      lazyViewError = err instanceof Error ? err.message : String(err);
      completeHeavyViewOpen(view);
    }
  }

  function retryLazyViewLoad(): void {
    if (!activeLazyView) return;
    beginHeavyViewOpen(activeLazyView);
    void loadLazyView(activeLazyView);
  }

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
      {:else if $currentView === "settings"}
        <SettingsView />
      {:else if activeLazyView}
        {#if lazyViewLoading || activeLazyView !== lastRequestedLazyView}
          <section class="view active">
            <div class="empty-state">
              <p>{$tr("app.loadingView", { view: $tr(lazyViewLabelKey(activeLazyView)) })}</p>
            </div>
          </section>
        {:else if lazyViewError}
          <section class="view active">
            <div class="empty-state gap-3">
              <p>{$tr("app.failedLoadView", { view: $tr(lazyViewLabelKey(activeLazyView)) })}</p>
              <p class="text-sm text-[var(--text-muted)]">{lazyViewError}</p>
              <button class="cursor-pointer rounded border border-[var(--border)] bg-[var(--bg-soft)] px-3 py-1 text-sm text-[var(--text-secondary)] transition-colors duration-150 hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]" on:click={retryLazyViewLoad}>{$tr("common.retry")}</button>
            </div>
          </section>
        {:else if lazyViewComponent}
          <svelte:component this={lazyViewComponent} />
        {/if}
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



