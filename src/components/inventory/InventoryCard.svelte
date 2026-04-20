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
<div class="item-card {mastered ? 'border-[rgba(74,222,128,0.25)]' : ''} {item.isPrime ? 'border-[rgba(212,168,67,0.28)]' : ''}" on:click={selectCard} bind:this={cardEl}>
  <div class="item-img-wrap">
    <ItemImage src={item.displayImageUrl} alt={item.name} />
    {#if item.isPrime}<span class="prime-badge">PRIME</span>{/if}
    {#if item.vaulted}<span class="vault-badge">V</span>{/if}
    <span class="absolute right-[0.4rem] bottom-[0.35rem] rounded-full py-[0.1rem] px-[0.4rem] border border-[rgba(74,222,128,0.4)] bg-[rgba(6,97,58,0.72)] text-[#a9ffcb] font-display text-[0.67rem] font-bold tracking-[0.03em]">x{item.amount}</span>
  </div>
  <div class="item-body">
    <span class="item-name">{item.name}</span>
    <span class="item-type">
      {item.categoryLabel}
      {#if item.inventoryGroup === "full_sets"}
        {` · Complete ${typeof item.completeSets === "number" ? item.completeSets : 0}`}
      {/if}
    </span>

    <div class="flex flex-wrap gap-1 min-h-[1.45rem] mt-[0.2rem]">
      <span
        class="inline-flex items-center rounded-full font-display font-bold tracking-[0.02em] {item.platinum == null ? 'border border-[rgba(148,163,184,0.26)] bg-[rgba(31,41,55,0.58)] text-[#94a3b8] text-[0.69rem] py-[0.08rem] px-[0.42rem]' : 'border border-[rgba(240,201,92,0.5)] bg-[rgba(212,168,67,0.2)] text-accent-bright text-[0.85rem] py-[0.1rem] px-2'}"
      >{platinumLabel}</span>
      {#if showDucats}
        <span class="inline-flex items-center rounded-full font-display font-bold tracking-[0.02em] text-[0.69rem] py-[0.08rem] px-[0.42rem] {item.ducats == null ? 'border border-[rgba(148,163,184,0.26)] bg-[rgba(31,41,55,0.58)] text-[#94a3b8]' : 'border border-[rgba(212,168,67,0.28)] bg-[rgba(212,168,67,0.1)] text-accent'}"
          >{ducatLabel}</span
        >
        <span
          class="inline-flex items-center rounded-full font-display font-bold tracking-[0.02em] text-[0.69rem] py-[0.08rem] px-[0.42rem] {item.ducatonator == null ? 'border border-[rgba(148,163,184,0.26)] bg-[rgba(31,41,55,0.58)] text-[#94a3b8]' : 'border border-[rgba(212,168,67,0.28)] bg-[rgba(212,168,67,0.1)] text-accent'}"
        >{ratioLabel}</span>
      {/if}
    </div>

    {#if showRankOrderSummary}
      <div class="grid grid-cols-2 gap-[0.24rem]">
        <span class="inventory-rank-order-box grid gap-[0.08rem] min-h-[2.05rem] content-center border border-[rgba(240,201,92,0.48)] bg-[rgba(212,168,67,0.2)] rounded-[0.42rem] py-[0.22rem] px-[0.34rem]">
          <span class="inventory-rank-order-label text-[0.57rem] uppercase tracking-[0.04em] font-display">WTS R{rankCapLabel}</span>
          <strong>{wtsRankMaxLabel}</strong>
        </span>
        <span class="inventory-rank-order-box grid gap-[0.08rem] min-h-[2.05rem] content-center border border-[rgba(240,201,92,0.48)] bg-[rgba(212,168,67,0.2)] rounded-[0.42rem] py-[0.22rem] px-[0.34rem]">
          <span class="inventory-rank-order-label text-[0.57rem] uppercase tracking-[0.04em] font-display">WTB R{rankCapLabel}</span>
          <strong>{wtbRankMaxLabel}</strong>
        </span>
        <span class="inventory-rank-order-box grid gap-[0.08rem] min-h-[2.05rem] content-center border border-[rgba(240,201,92,0.48)] bg-[rgba(212,168,67,0.2)] rounded-[0.42rem] py-[0.22rem] px-[0.34rem]">
          <span class="inventory-rank-order-label text-[0.57rem] uppercase tracking-[0.04em] font-display">WTS R0</span>
          <strong>{wtsRank0Label}</strong>
        </span>
        <span class="inventory-rank-order-box grid gap-[0.08rem] min-h-[2.05rem] content-center border border-[rgba(240,201,92,0.48)] bg-[rgba(212,168,67,0.2)] rounded-[0.42rem] py-[0.22rem] px-[0.34rem]">
          <span class="inventory-rank-order-label text-[0.57rem] uppercase tracking-[0.04em] font-display">WTB R0</span>
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
      <span class="text-[0.74rem] text-success whitespace-nowrap overflow-hidden text-ellipsis">{item.equippedSummary}</span>
    {/if}

    {#if showDebug}
      <span class="debug-reason">{item.debugLabel}</span>
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
