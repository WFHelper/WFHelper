<script lang="ts">
  import { inventoryData, itemDb } from "../stores/data.js";
  import { parseResources } from "../lib/inventory.js";
  import { formatNumber } from "../lib/format.js";
  import ItemImage from "../components/ItemImage.svelte";

  let search = '';

  $: resources = ($inventoryData && Object.keys($itemDb).length > 0)
    ? parseResources($inventoryData, $itemDb)
    : [];

  $: filtered = search
    ? resources.filter(r =>
        r.name.toLowerCase().includes(search.toLowerCase()) ||
        r.internalName.toLowerCase().includes(search.toLowerCase())
      )
    : resources;
</script>

<section class="view active">
  <div class="view-header">
    <h2>Resources</h2>
    <div class="view-controls">
      <div class="search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input type="text" bind:value={search} placeholder="Search resources…" />
      </div>
    </div>
  </div>

  <div class="resource-grid">
    {#if filtered.length === 0}
      <div class="empty-state col-span-full">
        <p>No resources found</p>
      </div>
    {:else}
      {#each filtered as r}
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
</section>
