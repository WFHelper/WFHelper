<script lang="ts">
  import { openOnWfm } from "../lib/priceLoader.js";

  export let text: string;
  export let slug: string | null;
  export let title: string = "Warframe.market";
</script>

<div class="detail-section detail-market-section">
  <h3>{title}</h3>
  <div class="detail-market-body">
    {text || '…'}
    {#if slug}
      <br/>
      <button class="market-link-btn" on:click={() => openOnWfm(slug)}>Open on warframe.market</button>
    {/if}
  </div>
</div>
