<script lang="ts">
  import { openOnWfm } from "../lib/priceLoader.js";

  export let text: string;
  export let slug: string | null;
  export let title: string = "Warframe.market";
</script>

<div class="detail-section detail-market-section">
  <h3>{title}</h3>
  <div class="detail-market-body">
    {text || "..."}
    {#if slug}
      <br />
      <button
        class="mt-1.5 rounded-md border border-accent-dim bg-accent-glow px-2 py-1 font-display text-xs font-semibold text-accent"
        on:click={() => openOnWfm(slug)}>Open on warframe.market</button
      >
    {/if}
  </div>
</div>
