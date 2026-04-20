<script lang="ts">
  import { inventoryData, itemDb } from "../stores/data.js";
  import { parseFoundry } from "../lib/inventory.js";
  import { formatTimeRemaining } from "../lib/format.js";
  import ItemImage from "../components/ItemImage.svelte";

  $: foundry = ($inventoryData && Object.keys($itemDb).length > 0)
    ? parseFoundry($inventoryData, $itemDb)
    : { building: [], recipes: [] };
</script>

<section class="view active">
  <div class="view-header">
    <h2>Foundry</h2>
  </div>

  <div id="foundry-active">
    <h3 class="mt-1 mb-2 font-display text-base font-semibold tracking-wide text-text-primary">Currently Building</h3>
    <div class="grid gap-2 mb-4">
      {#if foundry.building.length === 0}
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <p>Nothing currently building</p>
        </div>
      {:else}
        {#each foundry.building as item}
          {@const isReady = item.endDate && item.endDate <= new Date()}
          <div class="flex items-center justify-between px-2.5 py-2">
            <div class="flex min-w-0 items-center gap-2.5">
              <div class="h-[var(--foundry-image-wrap)] w-[var(--foundry-image-wrap)] shrink-0">
                <ItemImage src={item.imageUrl} alt={item.name} cls="max-w-[var(--foundry-image-max)] max-h-[var(--foundry-image-max)] object-contain" />
              </div>
              <span class="foundry-item-name">{item.name}</span>
            </div>
            <span class="font-display text-xs font-bold tracking-wide text-text-muted" class:text-success={isReady}>
              {#if isReady}READY{:else}{item.endDate ? formatTimeRemaining(item.endDate) : 'Unknown'}{/if}
            </span>
          </div>
        {/each}
      {/if}
    </div>
  </div>

  <div id="foundry-recipes">
    <h3 class="mt-1 mb-2 font-display text-base font-semibold tracking-wide text-text-primary">Available Blueprints</h3>
    <div class="grid gap-2 mb-4">
      {#if foundry.recipes.length === 0}
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
          </svg>
          <p>No blueprints</p>
        </div>
      {:else}
        {#each [...foundry.recipes].sort((a, b) => b.count - a.count).slice(0, 100) as item}
          <div class="flex items-center justify-between px-2.5 py-2">
            <div class="flex min-w-0 items-center gap-2.5">
              <div class="h-[var(--foundry-image-wrap)] w-[var(--foundry-image-wrap)] shrink-0">
                <ItemImage src={item.imageUrl} alt={item.name} cls="max-w-[var(--foundry-image-max)] max-h-[var(--foundry-image-max)] object-contain" />
              </div>
              <span class="foundry-item-name">{item.name}</span>
            </div>
            <span class="count-badge">{item.count}</span>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</section>
