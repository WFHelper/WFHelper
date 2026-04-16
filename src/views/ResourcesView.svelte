<script lang="ts">
  import { formatNumber } from "../lib/format.js";
  import ItemImage from "../components/ItemImage.svelte";
  import type { Resource } from "../types/inventory.js";

  export let resources: Resource[] = [];
</script>

<div class="resources-sub-panel">
  <div class="resource-grid">
    {#if resources.length === 0}
      <div class="empty-state col-span-full">
        <p>No resources found</p>
      </div>
    {:else}
      {#each resources as r}
        <div class="resource-card">
          <div class="resource-img-wrap">
            <ItemImage src={r.imageUrl} alt={r.name} cls="resource-img" />
          </div>
          <div class="resource-info">
            <span class="resource-name">{r.name}</span>
            <span class="resource-count">{formatNumber(r.count)}</span>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>
