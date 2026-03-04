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

<div class="view-header">
  <h2>Inventory ({totalCount})</h2>
  <div class="view-controls inventory-controls">
    <div class="filter-tabs">
      {#each filters as filterOption}
        <button
          class="filter-tab"
          class:active={activeFilter === filterOption.key}
          on:click={() => selectFilter(filterOption.key)}
        >{filterOption.label}</button>
      {/each}
    </div>

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
