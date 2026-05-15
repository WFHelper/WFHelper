<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from "svelte";

  import ItemImage from "../ItemImage.svelte";
  import MarketMetricStrip from "../MarketMetricStrip.svelte";
  import type { InventoryViewItem } from "../../lib/inventoryMarket.js";
  import { isRankedGroup } from "../../../config/shared/numeric.js";

  export let item: InventoryViewItem;
  export let showDucats = true;

  const dispatch = createEventDispatcher<{
    select: InventoryViewItem;
    visible: InventoryViewItem;
  }>();
  let cardEl: HTMLDivElement | null = null;
  let visibilityObserver: IntersectionObserver | null = null;
  let visibilityReported = false;

  $: mastered = item.rank >= item.maxRank && item.maxRank > 1;
  $: canShowRank = item.maxRank > 1 && isRankedGroup(item.inventoryGroup);
  $: rankFillPct =
    canShowRank && item.maxRank > 0
      ? Math.max(0, Math.min(100, (item.rank / item.maxRank) * 100))
      : 0;

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
<div class="item-card relative {mastered ? 'border-[rgba(74,222,128,0.25)]' : ''} {item.isPrime ? 'border-[rgba(212,168,67,0.28)]' : ''}" on:click={selectCard} bind:this={cardEl}>
  <div class="item-img-wrap">
    <ItemImage src={item.displayImageUrl} alt={item.name} />
    {#if item.vaulted}<span class="vault-badge">V</span>{/if}
    <span class="absolute right-[0.5rem] bottom-[0.34rem] font-display text-base font-bold text-success drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">x{item.amount}</span>
  </div>
  <div class="item-body">
    <span class="item-name">{item.name}</span>
    <span class="item-type">
      {item.categoryLabel}
      {#if item.inventoryGroup === "full_sets"}
        {` · Complete ${typeof item.completeSets === "number" ? item.completeSets : 0}`}
      {/if}
    </span>

    <MarketMetricStrip
      platinum={item.platinum}
      ducats={item.ducats}
      ratio={item.ducatonator}
      {showDucats}
      className="mt-[0.2rem]"
    />

    {#if showRankOrderSummary}
      <div class="grid grid-cols-2 gap-[0.24rem]">
        <span class="inventory-rank-order-box grid gap-[0.08rem] min-h-[2.05rem] content-center border border-[rgba(240,201,92,0.48)] bg-[rgba(212,168,67,0.2)] rounded-[0.42rem] py-[0.22rem] px-[0.34rem]">
          <span class="inventory-rank-order-label text-xs uppercase tracking-[0.04em] font-display">WTS R{rankCapLabel}</span>
          <strong>{wtsRankMaxLabel}</strong>
        </span>
        <span class="inventory-rank-order-box grid gap-[0.08rem] min-h-[2.05rem] content-center border border-[rgba(240,201,92,0.48)] bg-[rgba(212,168,67,0.2)] rounded-[0.42rem] py-[0.22rem] px-[0.34rem]">
          <span class="inventory-rank-order-label text-xs uppercase tracking-[0.04em] font-display">WTB R{rankCapLabel}</span>
          <strong>{wtbRankMaxLabel}</strong>
        </span>
        <span class="inventory-rank-order-box grid gap-[0.08rem] min-h-[2.05rem] content-center border border-[rgba(240,201,92,0.48)] bg-[rgba(212,168,67,0.2)] rounded-[0.42rem] py-[0.22rem] px-[0.34rem]">
          <span class="inventory-rank-order-label text-xs uppercase tracking-[0.04em] font-display">WTS R0</span>
          <strong>{wtsRank0Label}</strong>
        </span>
        <span class="inventory-rank-order-box grid gap-[0.08rem] min-h-[2.05rem] content-center border border-[rgba(240,201,92,0.48)] bg-[rgba(212,168,67,0.2)] rounded-[0.42rem] py-[0.22rem] px-[0.34rem]">
          <span class="inventory-rank-order-label text-xs uppercase tracking-[0.04em] font-display">WTB R0</span>
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
      <span class="text-xs text-success whitespace-nowrap overflow-hidden text-ellipsis">{item.equippedSummary}</span>
    {/if}
  </div>
</div>

<style>
  .inventory-rank-order-label {
    color: color-mix(in oklab, var(--accent-bright) 80%, white);
  }
  .inventory-rank-order-box :global(strong) {
    font-family: var(--font-display);
    color: var(--accent-bright);
    font-size: 0.86rem;
    line-height: 1.05;
    letter-spacing: 0.01em;
  }
</style>
