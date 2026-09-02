<script lang="ts">
  import { onMount } from "svelte";
  import { currentView } from "../stores/app.js";
  import { invoke, send } from "../lib/ipc.js";
  import { tr } from "../lib/i18n.js";
  import { NAV_ICON_URLS } from "../lib/assetUrls.js";
  import { devMode } from "../stores/devMode.js";
  import {
    hiddenTabs,
    nudgeSidebarWidth,
    resetSidebarWidth,
    sidebarCollapsed,
    sidebarLabels,
    sidebarOrder,
    sidebarWidth,
    snapSidebarWidth,
    toggleSidebarCollapsed,
    SIDEBAR_EXPAND_MIN,
    SIDEBAR_RAIL_WIDTH,
    SIDEBAR_WIDTH_MAX,
  } from "../stores/sidebarTabs.js";
  import { resetTourAutoStart } from "../stores/tour.js";
  import type { MessageKey } from "../lib/i18n.js";
  import { VIEW_LABEL_KEYS, type SidebarViewName } from "../lib/viewRegistry.js";

  $: showDevTools = $devMode;

  interface NavItem {
    view: SidebarViewName;
    labelKey: MessageKey;
    icon: string;
  }

  $: navItems = $sidebarOrder.map(
    (view): NavItem => ({ view, labelKey: VIEW_LABEL_KEYS[view], icon: NAV_ICON_URLS[view] }),
  );

  $: visibleNavItems = navItems.filter((item) => !$hiddenTabs.has(item.view));

  // Live drag width, uncommitted: a pointer move must not hit localStorage per frame.
  let dragWidth: number | null = null;
  let resizing = false;
  let dragStartX = 0;
  let dragStartWidth = 0;

  $: effectiveWidth = dragWidth ?? $sidebarWidth;
  // Follows the live drag, not the committed width: labels would otherwise stay
  // rendered while the grip is already past the rail threshold.
  $: collapsed = dragWidth != null ? dragWidth < SIDEBAR_EXPAND_MIN : $sidebarCollapsed;

  const narrowRail = typeof window === "undefined" ? null : window.matchMedia("(max-width: 800px)");

  // Publish the width globally so the content area and any other consumer of
  // var(--sidebar-width) reflow with it. Under 800px responsive.css pins the icon
  // rail, so the inline value is dropped there rather than fighting its :root rule.
  function applyWidthVar(px: number): void {
    if (typeof document === "undefined") return;
    const root = document.documentElement.style;
    if (narrowRail?.matches) root.removeProperty("--sidebar-width");
    else root.setProperty("--sidebar-width", `${px}px`);
  }

  $: applyWidthVar(effectiveWidth);

  onMount(() => {
    const onBreakpoint = (): void => applyWidthVar(effectiveWidth);
    narrowRail?.addEventListener("change", onBreakpoint);
    return () => narrowRail?.removeEventListener("change", onBreakpoint);
  });

  function startResize(e: PointerEvent): void {
    // Only the primary button drags; a right- or middle-click would otherwise
    // capture the pointer and never see a matching pointerup.
    if (e.button !== 0) return;
    resizing = true;
    dragStartX = e.clientX;
    dragStartWidth = $sidebarWidth;
    dragWidth = dragStartWidth;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // Stops the drag from starting a text selection in the content area.
    e.preventDefault();
  }

  function onResize(e: PointerEvent): void {
    if (!resizing) return;
    dragWidth = snapSidebarWidth(dragStartWidth + (e.clientX - dragStartX));
  }

  function endResize(e: PointerEvent): void {
    if (!resizing) return;
    resizing = false;
    const grip = e.currentTarget as HTMLElement;
    if (grip.hasPointerCapture?.(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    if (dragWidth != null) sidebarWidth.set(dragWidth);
    dragWidth = null;
  }

  function onGripKey(e: KeyboardEvent): void {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowLeft") nudgeSidebarWidth(-step);
    else if (e.key === "ArrowRight") nudgeSidebarWidth(step);
    else if (e.key === "Home") sidebarWidth.set(SIDEBAR_RAIL_WIDTH);
    else if (e.key === "End") sidebarWidth.set(SIDEBAR_WIDTH_MAX);
    else if (e.key === "Enter" || e.key === " ") resetSidebarWidth();
    else return;
    e.preventDefault();
  }

  // If the active tab gets hidden, fall back to inventory so we never strand
  // the user on a view with no way back to it.
  $: if ($hiddenTabs.has($currentView)) currentView.set("inventory");

  async function loadInventoryFile(): Promise<void> {
    // seeds the helper source without claiming it - Settings owns the switch
    const result = await invoke("openInventoryFile", "helper");
    if (result) currentView.set("inventory");
  }

  function toggleOverlay(): void {
    send("toggle-overlay");
  }

  function testOverlay(): void {
    send("simulate-relic-trigger");
  }

  function testNotification(): void {
    void invoke("sendTestNotification");
  }
</script>

<nav
  id="sidebar"
  class="sidebar-shell flex min-h-0 w-[var(--sidebar-width)] shrink-0 flex-col justify-between gap-2 overflow-y-auto overflow-x-hidden border-r border-border bg-bg-base px-2.5 py-3.5"
  class:sidebar-collapsed={collapsed}
>
  <div class="flex flex-col gap-0.5">
    <button
      class="nav-btn nav-btn-collapse relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-base font-medium tracking-wide text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
      title={$sidebarCollapsed ? $tr("nav.expandSidebar") : $tr("nav.collapseSidebar")}
      aria-label={$sidebarCollapsed ? $tr("nav.expandSidebar") : $tr("nav.collapseSidebar")}
      data-sidebar-collapse
      on:click={toggleSidebarCollapsed}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-5 w-5 shrink-0 transition-transform duration-150 {$sidebarCollapsed
          ? 'rotate-180'
          : ''}"
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
      <span>{$tr("nav.collapse")}</span>
    </button>
    {#each visibleNavItems as item (item.view)}
      <button
        data-view={item.view}
        class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 px-3.5 py-2.5 font-display text-base font-medium tracking-wide transition-colors duration-150 {$currentView ===
        item.view
          ? "bg-[var(--view-accent-glow)] text-[var(--view-accent)] before:content-[''] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-1 before:rounded-r before:bg-[var(--view-accent)] max-[800px]:before:hidden"
          : 'bg-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary'}"
        aria-current={$currentView === item.view ? "page" : undefined}
        on:click={() => currentView.set(item.view)}
      >
        <img src={item.icon} alt="" class="h-6 w-6 shrink-0 object-contain brightness-[0.85]" />
        <span>{$sidebarLabels[item.view] ?? $tr(item.labelKey)}</span>
      </button>
    {/each}
  </div>

  {#if showDevTools}
    <div class="mt-2 flex flex-col gap-0.5">
      <button
        class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-base font-medium tracking-wide text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary"
        title={$tr("nav.previewSetupWizard")}
        on:click={() => {
          resetTourAutoStart();
          currentView.set("setup");
        }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="h-6 w-6 shrink-0"
        >
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M8 9h8M8 13h5M16 13h1" />
        </svg>
        <span>{$tr("nav.setup")}</span>
      </button>
      <button
        class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-base font-medium tracking-wide text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary"
        title={$tr("nav.testTitle")}
        on:click={testOverlay}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="h-6 w-6 shrink-0"
        >
          <path d="M9 3h6l1 6-3.5 2L16 21H8l3.5-10L8 9l1-6z" />
        </svg>
        <span>{$tr("nav.test")}</span>
      </button>
      <button
        class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-base font-medium tracking-wide text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
        title={$tr("nav.overlayTitle")}
        on:click={toggleOverlay}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="h-6 w-6 shrink-0"
        >
          <polygon points="12,2 22,12 12,22 2,12" />
          <line x1="12" y1="8" x2="12" y2="16" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
        <span>{$tr("nav.overlay")}</span>
      </button>
      <button
        class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-base font-medium tracking-wide text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
        title={$tr("nav.testNotificationTitle")}
        data-test-notification
        on:click={testNotification}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="h-6 w-6 shrink-0"
        >
          <path d="M18 16V11a6 6 0 10-12 0v5l-2 3h16l-2-3z" />
          <path d="M10 21h4" />
        </svg>
        <span>{$tr("nav.testNotification")}</span>
      </button>
      <button
        class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-base font-medium tracking-wide text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
        on:click={loadInventoryFile}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="h-6 w-6 shrink-0"
        >
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <span>{$tr("nav.loadJson")}</span>
      </button>
    </div>
  {/if}
</nav>

<!-- A flex sibling rather than an overlay: the nav scrolls, so an absolutely
     positioned grip inside it would scroll away from the edge. -->
<div
  data-sidebar-grip
  class="sidebar-grip"
  class:sidebar-grip-active={resizing}
  role="slider"
  aria-orientation="horizontal"
  aria-label={$tr("nav.resizeSidebar")}
  aria-valuenow={effectiveWidth}
  aria-valuemin={SIDEBAR_RAIL_WIDTH}
  aria-valuemax={SIDEBAR_WIDTH_MAX}
  title={$tr("nav.resizeSidebarHint")}
  tabindex="0"
  on:pointerdown={startResize}
  on:pointermove={onResize}
  on:pointerup={endResize}
  on:pointercancel={endResize}
  on:lostpointercapture={endResize}
  on:dblclick={resetSidebarWidth}
  on:keydown={onGripKey}
></div>

<style>
  .sidebar-grip {
    flex: 0 0 auto;
    width: 5px;
    margin-left: -1px;
    cursor: col-resize;
    background: transparent;
    transition: background-color 0.12s ease;
  }
  .sidebar-grip:hover,
  .sidebar-grip:focus-visible,
  .sidebar-grip-active {
    background: var(--accent);
    outline: none;
  }
  /* Under 800px responsive.css pins the rail, so a drag here would do nothing. */
  @media (max-width: 800px) {
    .sidebar-grip {
      display: none;
    }
  }

  .sidebar-collapsed :global(.nav-btn span) {
    display: none;
  }
  .sidebar-collapsed :global(.nav-btn) {
    justify-content: center;
    padding-left: 0.5rem;
    padding-right: 0.5rem;
    gap: 0;
  }
  @media (max-width: 800px) {
    .nav-btn :global(span) {
      display: none;
    }
    .nav-btn {
      justify-content: center;
      padding-left: 0.625rem;
      padding-right: 0.625rem;
    }
  }
</style>
