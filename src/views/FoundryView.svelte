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
    <h3 class="section-label">Currently Building</h3>
    <div class="foundry-list">
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
          <div class="foundry-item">
            <div class="foundry-item-left">
              <div class="foundry-img-wrap">
                <ItemImage src={item.imageUrl} alt={item.name} cls="foundry-img" />
              </div>
              <span class="foundry-item-name">{item.name}</span>
            </div>
            <span class="foundry-timer" class:ready={isReady}>
              {#if isReady}READY{:else}{item.endDate ? formatTimeRemaining(item.endDate) : 'Unknown'}{/if}
            </span>
          </div>
        {/each}
      {/if}
    </div>
  </div>

  <div id="foundry-recipes">
    <h3 class="section-label">Available Blueprints</h3>
    <div class="foundry-list">
      {#if foundry.recipes.length === 0}
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
          </svg>
          <p>No blueprints</p>
        </div>
      {:else}
        {#each [...foundry.recipes].sort((a, b) => b.count - a.count).slice(0, 100) as item}
          <div class="foundry-item">
            <div class="foundry-item-left">
              <div class="foundry-img-wrap">
                <ItemImage src={item.imageUrl} alt={item.name} cls="foundry-img" />
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
