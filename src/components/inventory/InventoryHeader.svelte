<script lang="ts">
  import { createEventDispatcher } from "svelte";

  import HeaderTabs from "../HeaderTabs.svelte";
  import SharedFilterBar from "../SharedFilterBar.svelte";
  import type { InventoryFilterTab } from "../../lib/inventoryMarket.js";

  export let totalCount = 0;
  export let filters: Array<{ key: InventoryFilterTab; label: string }> = [];
  export let activeFilter: InventoryFilterTab = "all_parts";
  export let showFilterPanel = false;

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

  function handleTabSelect(value: string): void {
    selectFilter(value as InventoryFilterTab);
  }
</script>

<div class="mb-4">
  <h2 class="m-0 mb-2 font-display text-4xl leading-none font-semibold tracking-[0.03em] text-text-primary">Inventory ({totalCount})</h2>
  <div class="flex items-end border-b border-white/10">
    <HeaderTabs options={filters} activeKey={activeFilter} onSelect={handleTabSelect} />
    <div class="ml-auto flex items-center gap-2 pb-2 shrink-0 flex-nowrap">
      <SharedFilterBar
        scope="inventory"
        singleLine={true}
        showBasic={true}
        showAdvanced={false}
        basicVariant="quick"
      />
      <button
        class="filter-tab inline-flex min-h-8 items-center gap-1.5 pt-0 pb-0 [&_svg]:h-3.5 [&_svg]:w-3.5"
        class:active={showFilterPanel}
        on:click={toggleFilters}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 5h18" />
          <path d="M6 12h12" />
          <path d="M10 19h4" />
        </svg>
        Filters
      </button>
    </div>
  </div>
</div>

