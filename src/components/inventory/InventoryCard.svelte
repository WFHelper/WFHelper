<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from "svelte";

  import ItemImage from "../ItemImage.svelte";
  import type { InventoryViewItem } from "../../lib/inventoryMarket.js";
  import sharedNumeric from "../../../config/shared/numeric.cjs";

  const { isRankedGroup } = sharedNumeric as {
    isRankedGroup: (group: string | null | undefined) => boolean;
  };

  export let item: InventoryViewItem;
  export let showDebug = false;
  export let showDucats = true;

  const dispatch = createEventDispatcher<{ select: InventoryViewItem; visible: InventoryViewItem }>();
  let cardEl: HTMLDivElement | null = null;
  let visibilityObserver: IntersectionObserver | null = null;
  let visibilityReported = false;

  $: mastered = item.rank >= item.maxRank && item.maxRank > 1;
  $: canShowRank = item.maxRank > 1 && isRankedGroup(item.inventoryGroup);
  $: rankFillPct =
    canShowRank && item.maxRank > 0
      ? Math.max(0, Math.min(100, (item.rank / item.maxRank) * 100))
      : 0;

  $: platinumLabel = item.platinum != null ? `~${item.platinum}p` : "-p";
  $: ducatLabel = item.ducats != null ? `${item.ducats}d` : "-d";
  $: ratioLabel = item.ducatonator != null ? `${item.ducatonator} d/p` : "- d/p";
  $: showRankOrderSummary =
    isRankedGroup(item.inventoryGroup) && item.maxRank > 1;
  $: rankCapLabel = Number.isFinite(item.maxRank) ? Math.max(0, Math.floor(item.maxRank)) : 0;

  $: wtsRank0Label = item.wtsR0 != null ? `${item.wtsR0}p` : "-";
  $: wtbRank0Label = item.wtbR0 != null ? `${item.wtbR0}p` : "-";
  $: wtsRankMaxLabel = item.wtsRmax != null ? `${item.wtsRmax}p` : "-";
  $: wtbRankMaxLabel = item.wtbRmax != null ? `${item.wtbRmax}p` : "-";

  function selectCard(): void {
    dispatch("select", item);
  }

  onMount(() => {
    if (typeof IntersectionObserver !== "function") return;
    if (!cardEl) return;

    visibilityObserver = new IntersectionObserver(
      (entries) => {
        if (visibilityReported) return;
        const entry = entries[0];
        if (!entry?.isIntersecting) return;

        visibilityReported = true;
        dispatch("visible", item);
        visibilityObserver?.disconnect();
        visibilityObserver = null;
      },
      {
        root: null,
        rootMargin: "160px 0px 240px 0px",
        threshold: 0.01,
      },
    );

    visibilityObserver.observe(cardEl);
  });

  onDestroy(() => {
    if (visibilityObserver) {
      visibilityObserver.disconnect();
      visibilityObserver = null;
    }
  });
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="item-card" class:mastered class:prime={item.isPrime} on:click={selectCard} bind:this={cardEl}>
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
      <span
        class="inventory-value-pill inventory-value-pill-plat"
        class:inventory-value-pill-missing={item.platinum == null}
      >{platinumLabel}</span>
      {#if showDucats}
        <span class="inventory-value-pill" class:inventory-value-pill-missing={item.ducats == null}
          >{ducatLabel}</span
        >
        <span
          class="inventory-value-pill"
          class:inventory-value-pill-missing={item.ducatonator == null}
        >{ratioLabel}</span>
      {/if}
    </div>

    {#if showRankOrderSummary}
      <div class="inventory-rank-order-grid">
        <span class="inventory-rank-order-box">
          <span class="inventory-rank-order-label">WTS R{rankCapLabel}</span>
          <strong>{wtsRankMaxLabel}</strong>
        </span>
        <span class="inventory-rank-order-box">
          <span class="inventory-rank-order-label">WTB R{rankCapLabel}</span>
          <strong>{wtbRankMaxLabel}</strong>
        </span>
        <span class="inventory-rank-order-box">
          <span class="inventory-rank-order-label">WTS R0</span>
          <strong>{wtsRank0Label}</strong>
        </span>
        <span class="inventory-rank-order-box">
          <span class="inventory-rank-order-label">WTB R0</span>
          <strong>{wtbRank0Label}</strong>
        </span>
      </div>
    {/if}

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
