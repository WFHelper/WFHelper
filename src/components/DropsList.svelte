<script lang="ts">
  import type { DropInfo } from "../types/inventory.js";

  export let drops: DropInfo[];
  export let title: string = "Acquisition";
  export let initialLimit: number = 5;

  let showAll = false;

  // Reset expansion whenever the underlying drops array changes.
  $: if (drops) showAll = false;
</script>

{#if (drops || []).length > 0}
  <div class="detail-section">
    <h3>{title}</h3>
    <div class="detail-acquisition">
      {#each (showAll ? drops : drops.slice(0, initialLimit)) as d}
        <div class="drop-entry">
          <span class="drop-location">{d.location}</span>
          {#if d.chance}<span class="drop-chance">{(d.chance * 100).toFixed(1)}%</span>{/if}
          {#if d.rarity}<span class="drop-rarity">({d.rarity})</span>{/if}
        </div>
      {/each}
      {#if !showAll && drops.length > initialLimit}
        <button class="drop-view-all" on:click={() => showAll = true}>View all {drops.length} sources</button>
      {:else if showAll && drops.length > initialLimit}
        <button class="drop-view-all" on:click={() => showAll = false}>Show fewer</button>
      {/if}
    </div>
  </div>
{/if}
