<script lang="ts">
  import { onMount } from "svelte";
  import type { Component } from "svelte";

  import Titlebar from "./components/Titlebar.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import ErrorBoundary from "./components/ErrorBoundary.svelte";
  import ToastHost from "./components/ToastHost.svelte";

  import { normalizeErrorMessage } from "../config/shared/errors.js";

  import SetupView from "./views/SetupView.svelte";
  import InventoryView from "./views/InventoryView.svelte";
  import FoundryView from "./views/FoundryView.svelte";
  import MasteryView from "./views/MasteryView.svelte";
  import StatsView from "./views/StatsView.svelte";
  import SettingsView from "./views/SettingsView.svelte";
  import RivensView from "./views/RivensView.svelte";

  import ItemDetailModal from "./modals/ItemDetailModal.svelte";
  import ComponentDetailModal from "./modals/ComponentDetailModal.svelte";
  import RelicDetailModal from "./modals/RelicDetailModal.svelte";
  import OrderModal from "./modals/OrderModal.svelte";

  import { currentView, statusText } from "./stores/app.js";
  import { parsedItems } from "./stores/data.js";
  import { activeItem, activeComponent, activeRelic } from "./stores/modals.js";
  import { applyUpdateState } from "./stores/updates.js";
  import { addToast } from "./stores/toasts.js";
  import { onInventoryLoaded, setInventoryStatus } from "./lib/actions.js";
  import { initStartup } from "./lib/startupLoader.js";
  import { invoke, on } from "./lib/ipc.js";
  import { tr } from "./lib/i18n.js";
  import type { MessageKey } from "./lib/i18n.js";

  type ViewName =
    | "setup"
    | "inventory"
    | "foundry"
    | "mastery"
    | "stats"
    | "world"
    | "market"
    | "relics"
    | "wiki"
    | "rivens"
    | "settings";

  type LazyViewName = Extract<ViewName, "world" | "market" | "relics" | "wiki">;
  type LazyViewComponent = Component<Record<string, never>>;
  type LazyViewModule = { default: LazyViewComponent };

  interface LazyViewEntry {
    loader: () => Promise<LazyViewModule>;
    component: LazyViewComponent | null;
  }

  const lazyViews = new Map<LazyViewName, LazyViewEntry>([
    ["world", { loader: () => import("./views/WorldView.svelte"), component: null }],
    ["market", { loader: () => import("./views/MarketView.svelte"), component: null }],
    ["relics", { loader: () => import("./views/RelicsView.svelte"), component: null }],
    ["wiki", { loader: () => import("./views/WikiView.svelte"), component: null }],
  ]);

  let lazyViewComponent: LazyViewComponent | null = null;
  let lazyViewLoading = false;
  let lazyViewError = "";
  let activeLazyView: LazyViewName | null = null;
  let lastRequestedLazyView: LazyViewName | null = null;
  let lazyRequestToken = 0;

  $: setInventoryStatus($parsedItems.length);

  onMount(() => {
    const unsubscribeViewChange = currentView.subscribe((view) => {
      handleViewChange(view);
    });

    const unsubscribeInventoryUpdated = on("inventory-updated", async (data) => {
      if (data && !(data as { error?: unknown }).error) {
        await onInventoryLoaded(data);
        // Auto-navigate to inventory only on initial load from setup.
        if ($currentView === "setup") {
          currentView.set("inventory");
        }
        statusText.set(`Live update - ${$parsedItems.length} items loaded`);
      }
    });

    const unsubscribeUpdateStatus = on("app-update-status", (state) => {
      applyUpdateState(state, true);
    });

    const unsubscribeWfmNotification = on("wfm:notification", (notification) => {
      addToast({
        level: "info",
        title: `WFM DM from ${notification.from}`,
        message: notification.content,
        durationMs: 8000,
      });
    });

    const startup = initStartup();

    // Match the exact-"1" check used in stores/app.ts:10 so any future
    // non-"1" leftover value is treated consistently.
    if (localStorage.getItem("setup-completed") !== "1") {
      currentView.set("setup");
    } else {
      void reopenSetupWhenInventoryIsUnavailable();
    }

    window.addEventListener("keydown", onKeyDown);

    return () => {
      startup.dispose();
      unsubscribeViewChange();
      unsubscribeInventoryUpdated();
      unsubscribeUpdateStatus();
      unsubscribeWfmNotification();

      window.removeEventListener("keydown", onKeyDown);
    };
  });

  function isLazyView(view: string): view is LazyViewName {
    return view === "world" || view === "market" || view === "relics" || view === "wiki";
  }

  function lazyViewLabelKey(view: LazyViewName): MessageKey {
    if (view === "world") return "view.world";
    if (view === "market") return "view.market";
    if (view === "wiki") return "view.wiki";
    return "view.relics";
  }

  function handleViewChange(view: string): void {
    if (isLazyView(view)) {
      activeLazyView = view;
      if (lastRequestedLazyView === view) return;

      lastRequestedLazyView = view;
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
      const entry = lazyViews.get(view);
      if (!entry) throw new Error(`Unknown lazy view: ${view}`);
      let component = entry.component;
      if (!component) {
        const loaded = await entry.loader();
        component = loaded.default;
        entry.component = component;
      }

      if (requestToken !== lazyRequestToken || $currentView !== view) {
        return;
      }

      lazyViewComponent = component;
      lazyViewLoading = false;
    } catch (err) {
      if (requestToken !== lazyRequestToken || $currentView !== view) {
        return;
      }

      lazyViewComponent = null;
      lazyViewLoading = false;
      lazyViewError = normalizeErrorMessage(err);
    }
  }

  function retryLazyViewLoad(): void {
    if (!activeLazyView) return;
    void loadLazyView(activeLazyView);
  }

  async function reopenSetupWhenInventoryIsUnavailable(): Promise<void> {
    try {
      const [inventoryStatus, helperStatus] = await Promise.all([
        invoke("getInventoryStatus"),
        invoke("getHelperStatus"),
      ]);
      if (inventoryStatus?.found || helperStatus?.inventoryLastModified) return;

      currentView.set("setup");
      statusText.set("Inventory setup required");
    } catch {
      // Keep the persisted view if startup status checks are unavailable.
    }
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
    {#if $currentView !== "setup"}
      <Sidebar />
    {/if}

    <main
      id="content"
      class:stats-active={$currentView === "stats"}
      class:setup-active={$currentView === "setup"}
    >
      {#if $currentView === "setup"}
        <SetupView />
      {:else if $currentView === "inventory"}
        <InventoryView />
      {:else if $currentView === "foundry"}
        <FoundryView />
      {:else if $currentView === "mastery"}
        <MasteryView />
      {:else if $currentView === "stats"}
        <StatsView />
      {:else if $currentView === "rivens"}
        <RivensView />
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
              <p class="text-sm text-text-muted">{lazyViewError}</p>
              <button class="cursor-pointer rounded border border-border bg-bg-soft px-3 py-1 text-sm text-text-secondary transition-[border-color,color] duration-150 hover:border-border-strong hover:text-text-primary" on:click={retryLazyViewLoad}>{$tr("common.retry")}</button>
            </div>
          </section>
        {:else if lazyViewComponent}
          <svelte:component this={lazyViewComponent} />
        {/if}
      {/if}
    </main>
  </div>

  {#if $currentView !== "setup"}
    <StatusBar />
  {/if}

  <ItemDetailModal />
  <ComponentDetailModal />
  <RelicDetailModal />
  <OrderModal />
</ErrorBoundary>

<ToastHost />


