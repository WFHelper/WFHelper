<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { ComponentType } from "svelte";

  import Titlebar from "./components/Titlebar.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import ErrorBoundary from "./components/ErrorBoundary.svelte";
  import ToastHost from "./components/ToastHost.svelte";

  import { normalizeErrorMessage } from "../config/shared/errors.js";

  import WelcomeView from "./views/WelcomeView.svelte";
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
  import {
    beginHeavyViewOpen,
    completeHeavyViewOpen,
    markStartupInteractive,
    type HeavyViewName,
  } from "./lib/perf.js";
  import { invoke, on } from "./lib/ipc.js";
  import { tr } from "./lib/i18n.js";
  import type { MessageKey } from "./lib/i18n.js";

  type ViewName =
    | "setup"
    | "welcome"
    | "inventory"
    | "foundry"
    | "mastery"
    | "stats"
    | "world"
    | "market"
    | "relics"
    | "rivens"
    | "settings";

  type LazyViewName = Extract<ViewName, HeavyViewName>;
  type LazyViewModule = { default: ComponentType };

  interface LazyViewEntry {
    loader: () => Promise<LazyViewModule>;
    component: ComponentType | null;
  }

  const lazyViews = new Map<LazyViewName, LazyViewEntry>([
    ["world", { loader: () => import("./views/WorldView.svelte") as unknown as Promise<LazyViewModule>, component: null }],
    ["market", { loader: () => import("./views/MarketView.svelte") as unknown as Promise<LazyViewModule>, component: null }],
    ["relics", { loader: () => import("./views/RelicsView.svelte") as unknown as Promise<LazyViewModule>, component: null }],
  ]);

  let lazyViewComponent: ComponentType | null = null;
  let lazyViewLoading = false;
  let lazyViewError = "";
  let activeLazyView: LazyViewName | null = null;
  let lastRequestedLazyView: LazyViewName | null = null;
  let lazyRequestToken = 0;

  $: setInventoryStatus($parsedItems.length);

  onMount(() => {
    let startupInteractiveFrameA: number | null = null;
    let startupInteractiveFrameB: number | null = null;

    startupInteractiveFrameA = requestAnimationFrame(() => {
      startupInteractiveFrameB = requestAnimationFrame(() => {
        markStartupInteractive();
      });
    });

    const unsubscribeViewChange = currentView.subscribe((view) => {
      handleViewChange(view);
    });

    const unsubscribeInventoryUpdated = on("inventory-updated", async (data) => {
      if (data && !(data as { error?: unknown }).error) {
        await onInventoryLoaded(data);
        // Auto-navigate to inventory only on initial load (from welcome/setup screens)
        if ($currentView === "welcome" || $currentView === "setup") {
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

    // Show setup wizard on first launch if helper exe isn't installed.
    // Match the exact-"1" check used in stores/app.ts:10 so any future
    // non-"1" leftover value is treated consistently.
    if (localStorage.getItem("setup-completed") !== "1") {
      invoke("getHelperStatus").then((status) => {
        if (!status.exeFound && $currentView === "welcome") {
          currentView.set("setup");
        } else {
          // Helper already exists (e.g. dev env), mark setup done
          localStorage.setItem("setup-completed", "1");
        }
      }).catch(() => {});
    }

    window.addEventListener("keydown", onKeyDown);

    return () => {
      startup.dispose();
      if (startupInteractiveFrameA != null) {
        cancelAnimationFrame(startupInteractiveFrameA);
      }
      if (startupInteractiveFrameB != null) {
        cancelAnimationFrame(startupInteractiveFrameB);
      }

      unsubscribeViewChange();
      unsubscribeInventoryUpdated();
      unsubscribeUpdateStatus();
      unsubscribeWfmNotification();

      window.removeEventListener("keydown", onKeyDown);
    };
  });

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
      await tick();
      completeHeavyViewOpen(view);
    } catch (err) {
      if (requestToken !== lazyRequestToken || $currentView !== view) {
        return;
      }

      lazyViewComponent = null;
      lazyViewLoading = false;
      lazyViewError = normalizeErrorMessage(err);
      completeHeavyViewOpen(view);
    }
  }

  function retryLazyViewLoad(): void {
    if (!activeLazyView) return;
    beginHeavyViewOpen(activeLazyView);
    void loadLazyView(activeLazyView);
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

    <main id="content" class:stats-active={$currentView === "stats"}>
      {#if $currentView === "setup"}
        <SetupView />
      {:else if $currentView === "welcome"}
        <WelcomeView />
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

  <StatusBar />

  <ItemDetailModal />
  <ComponentDetailModal />
  <RelicDetailModal />
  <OrderModal />
</ErrorBoundary>

<ToastHost />




