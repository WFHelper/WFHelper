<script lang="ts">
  import { createEventDispatcher } from "svelte";

  import ItemImage from "../ItemImage.svelte";
  import type { InventoryViewItem } from "../../lib/inventoryMarket.js";

  export let item: InventoryViewItem;
  export let showDebug = false;

  const dispatch = createEventDispatcher<{ select: InventoryViewItem }>();

  $: mastered = item.rank >= item.maxRank && item.maxRank > 1;
  $: canShowRank = item.maxRank > 1 && (item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes");
  $: rankFillPct =
    canShowRank && item.maxRank > 0
      ? Math.max(0, Math.min(100, (item.rank / item.maxRank) * 100))
      : 0;

  function selectCard(): void {
    dispatch("select", item);
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="item-card" class:mastered class:prime={item.isPrime} on:click={selectCard}>
  <div class="item-img-wrap">
    <ItemImage src={item.displayImageUrl} alt={item.name} />
    {#if item.isPrime}<span class="prime-badge">PRIME</span>{/if}
    {#if item.vaulted}<span class="vault-badge">V</span>{/if}
    <span class="inventory-count-badge">x{item.amount}</span>
  </div>
  <div class="item-body">
    <span class="item-name">{item.name}</span>
    <span class="item-type">
      {item.categoryLabel}
      {#if item.inventoryGroup === "full_sets"}
        {` · Complete ${typeof item.completeSets === "number" ? item.completeSets : 0}`}
      {/if}
    </span>

    <div class="inventory-value-row">
      {#if item.platinum != null}
        <span class="inventory-value-pill inventory-value-pill-plat">~{item.platinum}p</span>
      {/if}
      {#if item.ducats != null}
        <span class="inventory-value-pill">{item.ducats}d</span>
      {/if}
      {#if item.ducatonator != null}
        <span class="inventory-value-pill">{item.ducatonator} d/p</span>
      {/if}
    </div>

    {#if canShowRank}
      <div class="item-rank-bar">
        <svg class="rank-bar-svg" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
          <rect
            class="rank-fill-svg"
            class:max={mastered}
            class:partial={!mastered}
            x="0"
            y="0"
            width={rankFillPct}
            height="4"
            rx="2"
            ry="2"
          ></rect>
        </svg>
      </div>
      <span class="item-rank-text">{item.rank}/{item.maxRank}</span>
    {/if}

    {#if item.equippedSummary}
      <span class="inventory-equipped-note">{item.equippedSummary}</span>
    {/if}

    {#if showDebug}
      <span class="debug-reason">{item.debugLabel}</span>
    {/if}
  </div>
</div>
