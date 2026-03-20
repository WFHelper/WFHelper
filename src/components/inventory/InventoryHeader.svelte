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

<div class="inv-header-wrap">
  <h2 class="inv-title">Inventory ({totalCount})</h2>
  <div class="inv-tab-row">
    <div class="inv-tab-bar">
      {#each filters as filterOption}
        <button
          class="inv-tab-item"
          class:active={activeFilter === filterOption.key}
          on:click={() => selectFilter(filterOption.key)}
        >{filterOption.label}</button>
      {/each}
    </div>
    <div class="inv-right-controls">
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

<style>
  .inv-header-wrap {
    margin-bottom: 1rem;
  }

  .inv-title {
    margin: 0 0 0.5rem;
    font-family: var(--font-display);
    font-size: var(--font-heading-size, 1.875rem);
    font-weight: 600;
    letter-spacing: 0.03em;
    color: var(--text-primary);
  }

  .inv-tab-row {
    display: flex;
    align-items: flex-end;
    border-bottom: 1px solid rgba(255, 255, 255, 0.09);
  }

  .inv-tab-bar {
    display: flex;
  }

  .inv-tab-item {
    display: flex;
    align-items: center;
    padding: 0.45rem 0.95rem;
    border: none;
    border-bottom: 3px solid transparent;
    background: none;
    font-family: var(--font-display);
    font-size: 1rem;
    color: #8a8c95;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
    white-space: nowrap;
    margin-bottom: -1px;
  }

  .inv-tab-item:hover {
    color: #b0b2ba;
  }

  .inv-tab-item.active {
    color: #ffffff;
    border-bottom-color: #ffffff;
  }

  .inv-right-controls {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-bottom: 0.45rem;
    flex-shrink: 0;
    flex-wrap: nowrap;
  }
</style>
