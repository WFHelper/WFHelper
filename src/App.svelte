<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { Component } from "svelte";

  import Titlebar from "./components/Titlebar.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import ErrorBoundary from "./components/ErrorBoundary.svelte";
  import ToastHost from "./components/ToastHost.svelte";
  import TourOverlay from "./components/TourOverlay.svelte";

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
  import BulkSellModal from "./components/workbench/BulkSellModal.svelte";

  import { currentView, SETUP_COMPLETED_KEY, statusText } from "./stores/app.js";
  import { parsedItems } from "./stores/data.js";
  import { tourActive } from "./stores/tour.js";
  import { autoFocusSearch } from "./stores/preferences.js";
  import { activeItem, activeComponent, activeRelic } from "./stores/modals.js";
  import { bulkSellOpen } from "./stores/inventorySelection.js";
  import { setInventoryStatus } from "./lib/actions.js";
  import { initStartup } from "./lib/startupLoader.js";
  import { initRendererEvents } from "./lib/rendererEvents.js";
  import { invoke } from "./lib/ipc.js";
  import { tr } from "./lib/i18n.js";
  import type { ViewName } from "./types/views.js";
  import {
    isLazyView,
    LAZY_VIEW_LOADERS,
    VIEW_LABEL_KEYS,
    type LazyViewName,
  } from "./lib/viewRegistry.js";

  type LazyViewComponent = Component<Record<string, never>>;

  const loadedLazyViews: Partial<Record<LazyViewName, LazyViewComponent>> = {};

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

    const disposeEvents = initRendererEvents();

    const startup = initStartup();

    // Match the exact-"1" check used in stores/app.ts so any future
    // non-"1" leftover value is treated consistently.
    if (localStorage.getItem(SETUP_COMPLETED_KEY) !== "1") {
      currentView.set("setup");
    } else {
      void reopenSetupWhenInventoryIsUnavailable();
    }

    window.addEventListener("keydown", onKeyDown);

    return () => {
      startup.dispose();
      disposeEvents();
      unsubscribeViewChange();
      window.removeEventListener("keydown", onKeyDown);
    };
  });

  function handleViewChange(view: ViewName): void {
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
    void autoFocusViewSearch();
  }

  async function loadLazyView(view: LazyViewName): Promise<void> {
    const requestToken = ++lazyRequestToken;
    lazyViewError = "";
    lazyViewLoading = true;

    try {
      let component = loadedLazyViews[view];
      if (!component) {
        component = (await LAZY_VIEW_LOADERS[view]()).default;
        loadedLazyViews[view] = component;
      }

      if (requestToken !== lazyRequestToken || $currentView !== view) {
        return;
      }

      lazyViewComponent = component;
      lazyViewLoading = false;
      void autoFocusViewSearch();
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
      statusText.set({ key: "app.inventorySetupRequired" });
    } catch {
      // Keep the persisted view if startup status checks are unavailable.
    }
  }

  function findSearchTarget(): HTMLInputElement | null {
    // With a modal open, only its own search may take focus.
    const scope = document.querySelector('[role="dialog"]') ?? document;
    return (
      [...scope.querySelectorAll<HTMLInputElement>("[data-search-focus]")].find(
        (el) => el.offsetParent !== null && !el.disabled,
      ) ?? null
    );
  }

  async function autoFocusViewSearch(): Promise<void> {
    // The tour's root is not a [role="dialog"] the scoping below catches, so
    // focusing would steal focus from every step.
    if (!$autoFocusSearch || $tourActive) return;
    await tick();
    const target = findSearchTarget();
    if (!target || target === document.activeElement) return;
    target.focus();
    target.select();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      const target = findSearchTarget();
      if (target) {
        e.preventDefault();
        target.focus();
        target.select();
      }
      return;
    }
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
              <p>{$tr("app.loadingView", { view: $tr(VIEW_LABEL_KEYS[activeLazyView]) })}</p>
            </div>
          </section>
        {:else if lazyViewError}
          <section class="view active">
            <div class="empty-state gap-3">
              <p>{$tr("app.failedLoadView", { view: $tr(VIEW_LABEL_KEYS[activeLazyView]) })}</p>
              <p class="text-sm text-text-muted">{lazyViewError}</p>
              <button
                class="cursor-pointer rounded border border-border bg-bg-soft px-3 py-1 text-sm text-text-secondary transition-[border-color,color] duration-150 hover:border-border-strong hover:text-text-primary"
                on:click={retryLazyViewLoad}>{$tr("common.retry")}</button
              >
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
  {#if $bulkSellOpen}
    <BulkSellModal onClose={() => bulkSellOpen.set(false)} />
  {/if}
</ErrorBoundary>

{#if $tourActive}
  <TourOverlay />
{/if}
<ToastHost />
