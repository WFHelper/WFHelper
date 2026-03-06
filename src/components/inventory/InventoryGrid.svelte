<script lang="ts">
  import { createEventDispatcher } from "svelte";

  import InventoryCard from "./InventoryCard.svelte";
  import type { InventoryViewItem } from "../../lib/inventoryMarket.js";

  export let items: InventoryViewItem[] = [];
  export let showDebug = false;
  export let showDucats = true;

  const dispatch = createEventDispatcher<{ select: InventoryViewItem }>();

  function handleSelect(event: CustomEvent<InventoryViewItem>): void {
    dispatch("select", event.detail);
  }
</script>

<div class="item-grid">
  {#if items.length === 0}
    <div class="empty-state col-span-full">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <p>No items found</p>
    </div>
  {:else}
    {#each items as item}
      <InventoryCard {item} {showDebug} {showDucats} on:select={handleSelect} />
    {/each}
  {/if}
</div>
