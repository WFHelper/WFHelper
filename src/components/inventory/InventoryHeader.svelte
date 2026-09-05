<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";

  import HeaderTabs from "../HeaderTabs.svelte";
  import SharedFilterBar from "../SharedFilterBar.svelte";
  import { tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import type { InventoryFilterTab } from "../../lib/inventoryMarket.js";
  import type { SharedSortKey } from "../../types/filters.js";

  export let totalCount = 0;
  export let filters: Array<{ key: InventoryFilterTab; labelKey: MessageKey }> = [];
  export let activeFilter: InventoryFilterTab = "all_parts";
  export let showFilterPanel = false;
  export let sortOptions: Array<[SharedSortKey, string]> | null = null;
  export let advancedCount = 0;
  export let filtersEnabled = true;
  export let selectionMode = false;
  export let selectionEnabled = true;
  export let onToggleSelectionMode: () => void = () => {};

  const dispatch = createEventDispatcher<{
    filter: InventoryFilterTab;
    toggle: void;
  }>();

  function selectFilter(value: InventoryFilterTab): void {
    dispatch("filter", value);
  }

  function toggleFilters(): void {
    dispatch("toggle");
  }

  $: tabOptions = filters.map((entry) => ({ key: entry.key, label: $tr(entry.labelKey) }));

  function handleTabSelect(value: string): void {
    selectFilter(value as InventoryFilterTab);
  }

  let stickyEl: HTMLDivElement | null = null;

  // The order-book panel is sticky in the same scroll container and has to pin
  // below this band, which is opaque and sits above it. The band grows with the
  // tab rows, the value strip and the filter popover, so publish the measured
  // height instead of hard-coding one.
  onMount(() => {
    const root = document.documentElement;
    const publish = (): void => {
      root.style.setProperty("--inventory-sticky-height", `${stickyEl?.offsetHeight ?? 0}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    if (stickyEl) observer.observe(stickyEl);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--inventory-sticky-height");
    };
  });
</script>

<!-- Keep the sticky row outside the scrolling heading. -->
<!-- The layout-edit button rides the title row; on its own row it was one small
     button flush under the controls with a band of dead space beside it. -->
<div class="mb-2 flex flex-wrap items-end justify-between gap-3">
  <h2
    class="m-0 font-display text-4xl leading-none font-semibold tracking-[0.03em] text-text-primary"
  >
    {$tr("inventory.title", { count: totalCount })}
  </h2>
  <div class="ml-auto"><slot name="actions" /></div>
</div>
<div class="view-sticky-filters mb-4" bind:this={stickyEl}>
  <!-- The tab row will not shrink below its own labels, so the controls take the
       next row whole once they no longer fit beside it. A px breakpoint measured
       the window while the zoom factor decided what a tab costs, which on a
       rotated screen wrapped the tabs mid-row into a band of empty header. -->
  <div
    class="flex flex-wrap items-end gap-y-2 border-b border-border-subtle"
    data-tour="inventory-tabs"
  >
    <div class="max-w-full shrink-0 grow">
      <HeaderTabs options={tabOptions} activeKey={activeFilter} onSelect={handleTabSelect} />
    </div>
    <!-- max-w-full + wrap: this block once widened past what a 900px window fits,
         and an unwrappable block stretches the whole header. -->
    <div class="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2 pb-2">
      <SharedFilterBar
        scope="inventory"
        singleLine={true}
        showBasic={true}
        showAdvanced={false}
        basicVariant="quick"
        {sortOptions}
      />
      {#if selectionEnabled}
        <button
          class="filter-tab min-h-8 py-0 text-xs"
          class:active={selectionMode}
          aria-pressed={selectionMode}
          data-inventory-select-toggle
          title={$tr("inventory.selectModeHint")}
          on:click={onToggleSelectionMode}
        >
          {$tr("inventory.selectMode")}
        </button>
      {/if}
      {#if filtersEnabled}
        <button
          class="filter-tab inline-flex min-h-8 items-center gap-1.5 pt-0 pb-0 [&_svg]:h-3.5 [&_svg]:w-3.5"
          data-advanced-filters-toggle
          class:active={showFilterPanel || advancedCount > 0}
          title={advancedCount > 0
            ? advancedCount === 1
              ? $tr("inventory.advancedFilterActiveOne", { count: advancedCount })
              : $tr("inventory.advancedFilterActiveMany", { count: advancedCount })
            : $tr("inventory.advancedFilters")}
          on:click={toggleFilters}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 5h18" />
            <path d="M6 12h12" />
            <path d="M10 19h4" />
          </svg>
          {$tr("common.filters")}
          {#if advancedCount > 0}
            <span
              class="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[color:var(--accent)] px-1 text-[10px] font-bold leading-none text-bg-deep"
            >
              {advancedCount}
            </span>
          {/if}
        </button>
      {/if}
    </div>
  </div>
  <slot />
</div>
