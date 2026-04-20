<script lang="ts">
  import { createEventDispatcher } from "svelte";

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
</script>

<div class="mb-4">
  <h2 class="m-0 mb-2 font-display text-[var(--font-heading-size,1.875rem)] font-semibold tracking-[0.03em] text-text-primary">Inventory ({totalCount})</h2>
  <div class="flex items-end border-b border-[rgba(255,255,255,0.09)]">
    <div class="flex">
      {#each filters as filterOption}
        <button
          class="inv-tab-item flex items-center py-[0.45rem] px-[0.95rem] border-none border-b-[3px] border-b-transparent bg-transparent font-display text-base text-[#8a8c95] cursor-pointer transition-[color,border-color] duration-150 whitespace-nowrap -mb-px hover:text-[#b0b2ba] data-[active]:text-white data-[active]:border-b-white"
          data-active={activeFilter === filterOption.key || undefined}
          on:click={() => selectFilter(filterOption.key)}
        >{filterOption.label}</button>
      {/each}
    </div>
    <div class="ml-auto flex items-center gap-2 pb-[0.45rem] shrink-0 flex-nowrap">
      <SharedFilterBar
        scope="inventory"
        singleLine={true}
        showBasic={true}
        showAdvanced={false}
        basicVariant="quick"
      />
      <button
        class="filter-tab inventory-filter-toggle"
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

