<script lang="ts">
  import { formatNumber } from "../lib/format.js";
  import ItemImage from "../components/ItemImage.svelte";
  import type { Resource } from "../types/inventory.js";

  export let resources: Resource[] = [];
</script>

<div class="resources-sub-panel">
  <div class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
    {#if resources.length === 0}
      <div class="empty-state col-span-full">
        <p>No resources found</p>
      </div>
    {:else}
      {#each resources as r}
        <div class="flex items-center gap-2.5 px-2.5 py-2">
          <div class="h-[var(--resource-image-wrap)] w-[var(--resource-image-wrap)] shrink-0">
            <ItemImage src={r.imageUrl} alt={r.name} cls="max-w-[var(--resource-image-max)] max-h-[var(--resource-image-max)] object-contain" />
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
