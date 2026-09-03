<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { Component } from "svelte";

  import Titlebar from "./components/Titlebar.svelte";
  import CustomCssHost from "./components/CustomCssHost.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import ErrorBoundary from "./components/ErrorBoundary.svelte";
  import ToastHost from "./components/ToastHost.svelte";
  import TourOverlay from "./components/TourOverlay.svelte";
  import ThemeInspector from "./components/ThemeInspector.svelte";
  import PopoutSectionHost from "./components/PopoutSectionHost.svelte";

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
  import EnemyDetailModal from "./modals/EnemyDetailModal.svelte";
  import OrderModal from "./modals/OrderModal.svelte";
  import BulkSellModal from "./components/workbench/BulkSellModal.svelte";

  import { currentView, SETUP_COMPLETED_KEY, statusText } from "./stores/app.js";
  import { parsedItems } from "./stores/data.js";
  import {
    isPopoutWindow,
    popoutPinnedAtOpen,
    popoutSectionId,
    popoutView,
  } from "./stores/popout.js";
  import { restoreWorkspaceOnLaunch } from "./stores/workspaces.js";
  import { tourActive } from "./stores/tour.js";
  import { autoFocusSearch } from "./stores/preferences.js";
  import { activeItem, activeComponent, activeRelic } from "./stores/modals.js";
  import { bulkSellOpen } from "./stores/inventorySelection.js";
  import { setInventoryStatus } from "./lib/actions.js";
  import { themeSettings } from "./stores/theme.js";
  import { viewAccentVars } from "./lib/theme/derive.js";
  import { effectiveViewAccent, viewOverrideStyle } from "./lib/theme/viewOverrides.js";
  import { initStartup } from "./lib/startupLoader.js";
  import { initRendererEvents } from "./lib/rendererEvents.js";
  import { invoke } from "./lib/ipc.js";
  import { log } from "./lib/log.js";
  import { tr } from "./lib/i18n.js";
  import type { PopoutView } from "../config/shared/popoutTypes.js";
  import type { ViewName } from "./types/views.js";
  import {
    isLazyView,
    LAZY_VIEW_LOADERS,
    VIEW_LABEL_KEYS,
    type LazyViewName,
  } from "./lib/viewRegistry.js";

  type LazyViewComponent = Component<Record<string, never>>;

  const POPOUT_ROUTES: Record<PopoutView, LazyViewName> = { world: "world", arbitrations: "arbi" };
  const popoutRoute: LazyViewName | null = popoutView ? POPOUT_ROUTES[popoutView] : null;

  let popoutPinned = popoutPinnedAtOpen;

  const loadedLazyViews: Partial<Record<LazyViewName, LazyViewComponent>> = {};

  let lazyViewComponent: LazyViewComponent | null = null;
  let lazyViewLoading = false;
  let lazyViewError = "";
  let activeLazyView: LazyViewName | null = null;
  let lastRequestedLazyView: LazyViewName | null = null;
  let lazyRequestToken = 0;

  $: setInventoryStatus($parsedItems.length);

  // Per-view overrides ride inline style attributes, not a generated <style> block:
  // the window CSP allows style-src-attr 'unsafe-inline' but not inline stylesheets.
  $: viewScopeStyle = viewOverrideStyle($themeSettings, $currentView);
  $: shellAccentStyle = viewAccentVars(effectiveViewAccent($themeSettings, $currentView));

  onMount(() => {
    const unsubscribeViewChange = currentView.subscribe((view) => {
      handleViewChange(view);
    });

    const disposeEvents = initRendererEvents();

    // Only the main window owns the shared disk caches; a popout flushing its
    // own smaller export would shrink them.
    const startup = initStartup({ ownsSharedCaches: !isPopoutWindow });

    if (popoutRoute) {
      // Reuses the normal lazy-view loader; the shell below renders its result.
      currentView.set(popoutRoute);
    } else if (popoutSectionId) {
      // PopoutSectionHost mounts the owning view itself, so the router stays out.
    } else if (localStorage.getItem(SETUP_COMPLETED_KEY) !== "1") {
      // Match the exact-"1" check used in stores/app.ts so any future
      // non-"1" leftover value is treated consistently.
      currentView.set("setup");
    } else {
      void reopenSetupWhenInventoryIsUnavailable();
      void restoreWorkspaceOnLaunch();
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

  async function togglePopoutPin(): Promise<void> {
    const next = !popoutPinned;
    try {
      const result = await invoke("popoutSetPinned", next);
      if (result?.ok) popoutPinned = next;
    } catch (err) {
      log.warn("[Popout] setPinned failed:", err);
    }
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

<!-- Electron mirrors the page title into the frame, so each popout is nameable. -->
<svelte:head>
  {#if popoutRoute}
    <title>{$tr(VIEW_LABEL_KEYS[popoutRoute])}</title>
  {/if}
</svelte:head>

{#if isPopoutWindow}
  <ErrorBoundary>
    {#if popoutSectionId}
      <PopoutSectionHost sectionId={popoutSectionId} />
    {:else if popoutRoute}
      <div class="flex h-screen">
        <main id="content" data-view={popoutRoute} style={viewScopeStyle}>
          {#if lazyViewComponent}
            <svelte:component this={lazyViewComponent} />
          {:else}
            <section class="view active">
              <div class="empty-state gap-3">
                <p>
                  {lazyViewError
                    ? $tr("app.failedLoadView", { view: $tr(VIEW_LABEL_KEYS[popoutRoute]) })
                    : $tr("app.loadingView", { view: $tr(VIEW_LABEL_KEYS[popoutRoute]) })}
                </p>
                {#if lazyViewError}
                  <p class="text-sm text-text-muted">{lazyViewError}</p>
                {/if}
              </div>
            </section>
          {/if}
        </main>
      </div>
    {/if}

    <button
      type="button"
      data-popout-pin
      aria-pressed={popoutPinned}
      aria-label={$tr(popoutPinned ? "common.unpinOnTop" : "common.pinOnTop")}
      title={$tr(popoutPinned ? "common.unpinOnTop" : "common.pinOnTop")}
      class="fixed right-3 top-2 z-[1300] flex cursor-pointer items-center justify-center rounded border p-1.5 transition-[border-color,color,background-color] duration-150 {popoutPinned
        ? 'border-accent/60 bg-accent/15 text-accent'
        : 'border-border bg-bg-raised/90 text-text-secondary hover:border-border-strong hover:text-text-primary'}"
      on:click={togglePopoutPin}
    >
      <svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M6 1.5h4l-.6 3.3 2.1 2.1v1.2H4.5V6.9l2.1-2.1z" />
        <path d="M8 8.1V14" />
      </svg>
    </button>
  </ErrorBoundary>
{:else}
  <ErrorBoundary>
    <CustomCssHost />
    <Titlebar />

    <div id="app" style={shellAccentStyle}>
      {#if $currentView !== "setup"}
        <Sidebar />
      {/if}

      <main
        id="content"
        data-view={$currentView}
        style={viewScopeStyle}
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
    <EnemyDetailModal />
    <OrderModal />
    {#if $bulkSellOpen}
      <BulkSellModal onClose={() => bulkSellOpen.set(false)} />
    {/if}
  </ErrorBoundary>

  {#if $tourActive}
    <TourOverlay />
  {/if}

  <!-- Main window only: the inspector claims Ctrl+Shift+click app-wide, and a
       pop-out has no Settings toggle to turn it back off. -->
  <ThemeInspector />
{/if}

<ToastHost />
