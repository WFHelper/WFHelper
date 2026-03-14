<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { ComponentType } from "svelte";

  import Titlebar from "./components/Titlebar.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import ErrorBoundary from "./components/ErrorBoundary.svelte";
  import ToastHost from "./components/ToastHost.svelte";

  import sharedErrors from "../config/shared/errors.cjs";

  const { normalizeErrorMessage } = sharedErrors as {
    normalizeErrorMessage: (err: unknown, fallback?: string) => string;
  };

  import WelcomeView from "./views/WelcomeView.svelte";
  import SetupView from "./views/SetupView.svelte";
  import InventoryView from "./views/InventoryView.svelte";
  import FoundryView from "./views/FoundryView.svelte";
  import ResourcesView from "./views/ResourcesView.svelte";
  import MasteryView from "./views/MasteryView.svelte";
  import StatsView from "./views/StatsView.svelte";
  import SettingsView from "./views/SettingsView.svelte";

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
  import { ipc } from "./lib/ipc.js";
  import { tr } from "./lib/i18n.js";
  import type { MessageKey } from "./lib/i18n.js";

  type ViewName =
    | "setup"
    | "welcome"
    | "inventory"
    | "foundry"
    | "resources"
    | "mastery"
    | "stats"
    | "world"
    | "market"
    | "relics"
    | "settings";

  type LazyViewName = Extract<ViewName, HeavyViewName>;
  type LazyViewModule = { default: ComponentType };

  const lazyViewLoaders: Record<LazyViewName, () => Promise<LazyViewModule>> = {
    world: () => import("./views/WorldView.svelte") as unknown as Promise<LazyViewModule>,
    market: () => import("./views/MarketView.svelte") as unknown as Promise<LazyViewModule>,
    relics: () => import("./views/RelicsView.svelte") as unknown as Promise<LazyViewModule>,
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

    const unsubscribeInventoryUpdated = ipc.onInventoryUpdated(async (data) => {
      if (data && !(data as { error?: unknown }).error) {
        await onInventoryLoaded(data);
        // Auto-navigate to inventory only on initial load (from welcome/setup screens)
        if ($currentView === "welcome" || $currentView === "setup") {
          currentView.set("inventory");
        }
        statusText.set(`Live update - ${$parsedItems.length} items loaded`);
      }
    });

    const unsubscribeUpdateStatus = ipc.onAppUpdateStatus((state) => {
      applyUpdateState(state, true);
    });

    const unsubscribeWfmNotification = ipc.onWfmNotification((notification) => {
      addToast({
        level: "info",
        title: `WFM DM from ${notification.from}`,
        message: notification.content,
        durationMs: 8000,
      });
    });

    const startup = initStartup();

    // Show setup wizard on first launch if helper exe isn't installed
    if (!localStorage.getItem("setup-completed")) {
      ipc.getHelperStatus().then((status) => {
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
      {:else if $currentView === "resources"}
        <ResourcesView />
      {:else if $currentView === "mastery"}
        <MasteryView />
      {:else if $currentView === "stats"}
        <StatsView />
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



