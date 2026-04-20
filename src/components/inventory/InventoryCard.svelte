<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from "svelte";

  import ItemImage from "../ItemImage.svelte";
  import type { InventoryViewItem } from "../../lib/inventoryMarket.js";
  import { isRankedGroup } from "../../../config/shared/numeric.js";

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

<style>
  .item-card.mastered {
    border-color: rgba(74, 222, 128, 0.25);
  }
  .item-card.prime {
    border-color: rgba(212, 168, 67, 0.28);
  }
  .inventory-count-badge {
    position: absolute;
    right: 0.4rem;
    bottom: 0.35rem;
    border-radius: 999px;
    padding: 0.1rem 0.4rem;
    border: 1px solid rgba(74, 222, 128, 0.4);
    background: rgba(6, 97, 58, 0.72);
    color: #a9ffcb;
    font-family: var(--font-display);
    font-size: 0.67rem;
    font-weight: 700;
    letter-spacing: 0.03em;
  }
  .inventory-value-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    min-height: 1.45rem;
    margin-top: 0.2rem;
  }
  .inventory-rank-order-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.24rem;
  }
  .inventory-rank-order-box {
    border: 1px solid rgba(240, 201, 92, 0.48);
    background: rgba(212, 168, 67, 0.2);
    border-radius: 0.42rem;
    padding: 0.22rem 0.34rem;
    display: grid;
    gap: 0.08rem;
    min-height: 2.05rem;
    align-content: center;
  }
  .inventory-rank-order-label {
    font-size: 0.57rem;
    color: color-mix(in oklab, var(--accent-bright) 80%, white);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-family: var(--font-display);
  }
  .inventory-rank-order-box :global(strong) {
    font-family: var(--font-display);
    color: var(--accent-bright);
    font-size: 0.86rem;
    line-height: 1.05;
    letter-spacing: 0.01em;
  }
  .inventory-value-pill {
    display: inline-flex;
    align-items: center;
    border: 1px solid rgba(212, 168, 67, 0.28);
    background: rgba(212, 168, 67, 0.1);
    color: var(--accent);
    border-radius: 999px;
    padding: 0.08rem 0.42rem;
    font-size: 0.69rem;
    font-family: var(--font-display);
    letter-spacing: 0.02em;
    font-weight: 700;
  }
  .inventory-value-pill-plat {
    font-size: 0.85rem;
    padding: 0.1rem 0.5rem;
    border-color: rgba(240, 201, 92, 0.5);
    background: rgba(212, 168, 67, 0.2);
    color: var(--accent-bright);
  }
  .inventory-value-pill-missing {
    border-color: rgba(148, 163, 184, 0.26);
    background: rgba(31, 41, 55, 0.58);
    color: #94a3b8;
  }
  .inventory-equipped-note {
    font-size: 0.74rem;
    color: var(--success);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
