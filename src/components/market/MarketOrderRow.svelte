<script lang="ts">
  import { PLATINUM_ICON_URL } from "../../lib/assetUrls.js";
  import { isRankedGroup } from "../../../config/shared/numeric.js";
  import type { InventoryViewItem } from "../../lib/inventoryMarket.js";
  import type { WfmOrder } from "../../types/market.js";

  export let order: WfmOrder;
  export let item: (InventoryViewItem & { sourceOrderId?: string }) | null = null;
  export let compact = false;
  export let selected = false;
  export let onSelectChange: (orderId: string, checked: boolean) => void;
  export let onOpen: (order: WfmOrder) => void;
  export let onEdit: (order: WfmOrder) => void;
  export let onDelete: (orderId: string) => void;

  $: orderKind = order.orderType === "buy" ? "WTB" : "WTS";
  $: liveLabel = order.visible ? "live" : "hidden";
  $: ownedCount = item?.amount ?? 0;
  $: isRankedListing = item ? isRankedGroup(item.inventoryGroup) && item.maxRank > 0 : order.modRank != null;
  $: rankCap = item?.maxRank && item.maxRank > 0 ? Math.floor(item.maxRank) : 0;
  $: listedRank = order.modRank != null ? Math.max(0, Math.floor(order.modRank)) : null;
  $: summaryRank =
    isRankedListing && listedRank != null
      ? listedRank === rankCap
        ? rankCap
        : 0
      : null;
  $: summaryWts =
    summaryRank === rankCap && summaryRank !== 0
      ? item?.wtsRmax ?? null
      : summaryRank === 0
        ? item?.wtsR0 ?? null
        : null;
  $: summaryWtb =
    summaryRank === rankCap && summaryRank !== 0
      ? item?.wtbRmax ?? null
      : summaryRank === 0
        ? item?.wtbR0 ?? null
        : null;
  $: medianLabel = item?.platinum != null ? `~${item.platinum}p` : "-";
  $: wtsLabel = summaryWts != null ? `${summaryWts}p` : "-";
  $: wtbLabel = summaryWtb != null ? `${summaryWtb}p` : "-";

  function handleCheckbox(event: Event): void {
    onSelectChange(order.id, (event.currentTarget as HTMLInputElement).checked);
  }

  function stopAndEdit(event: MouseEvent): void {
    event.stopPropagation();
    onEdit(order);
  }

  function stopAndDelete(event: MouseEvent): void {
    event.stopPropagation();
    onDelete(order.id);
  }
</script>

{#if compact}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="order-row flex flex-col overflow-hidden p-0 text-left" on:click={() => onOpen(order)}>
    <div class="flex items-center gap-2 border-b border-border bg-bg-raised px-2.5 py-1.5">
      <input
        type="checkbox"
        class="h-3.5 w-3.5 shrink-0 accent-accent"
        checked={selected}
        title="Select for bulk action"
        on:click|stopPropagation
        on:change={handleCheckbox}
      />
      <span class="shrink-0 rounded px-1.5 py-0.5 text-[0.62rem] font-bold tracking-wide {order.orderType === 'buy' ? 'bg-sky-500/20 text-sky-300' : 'bg-amber-500/20 text-amber-300'}">
        {orderKind}
      </span>
      <span class="min-w-0 flex-1 truncate font-display text-[0.88rem] font-bold text-text-primary" title={order.itemName}>
        {order.itemName}
        <span class="ml-1.5 text-[0.68rem] font-semibold text-text-muted">Owned {ownedCount}</span>
      </span>
      {#if order.modRank != null}
        <span class="shrink-0 rounded-sm bg-[rgba(212,168,67,0.2)] px-1 py-0.5 text-[0.62rem] font-bold text-accent">R{order.modRank}</span>
      {/if}
      <span
        class="shrink-0 text-[0.68rem] font-semibold {order.visible ? 'text-success' : 'text-warning'}"
        title={order.visible ? "Visible on WFM" : "Hidden on WFM"}
      >
        {liveLabel}
      </span>
    </div>

    <div class="flex items-center gap-2.5 px-2.5 py-2.5">
      {#if order.itemThumb}
        <img src={order.itemThumb} alt={order.itemName} class="h-11 w-11 shrink-0 rounded-[var(--radius-md)] bg-black/30 object-contain" loading="lazy" />
      {:else}
        <div class="h-11 w-11 shrink-0 rounded-[var(--radius-md)] bg-white/5"></div>
      {/if}
      <div class="grid flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5">
        <span class="flex items-baseline gap-1 font-display" title="Listed quantity">
          <span class="text-[0.68rem] uppercase tracking-[0.04em] text-text-muted">Qty</span>
          <span class="text-lg font-bold leading-none text-text-primary">{order.quantity}</span>
        </span>
        <span class="flex items-center justify-center gap-1 font-display" title="Platinum">
          <img src={PLATINUM_ICON_URL} alt="" width="16" height="16" class="shrink-0" />
          <span class="text-lg font-bold leading-none text-accent">{order.platinum}</span>
        </span>
        <div class="col-span-full grid grid-cols-2 gap-1">
          {#if isRankedListing && summaryRank != null}
            <span class="market-summary-chip"><small>WTS R{summaryRank}</small><strong>{wtsLabel}</strong></span>
            <span class="market-summary-chip"><small>WTB R{summaryRank}</small><strong>{wtbLabel}</strong></span>
          {:else}
            <span class="market-summary-chip col-span-full"><small>Median</small><strong>{medianLabel}</strong></span>
          {/if}
        </div>
      </div>
      <div class="flex shrink-0 gap-1">
        <button class="btn-sm btn-secondary h-8" title="Edit" on:click={stopAndEdit}>Edit</button>
        <button class="btn-sm btn-danger h-8 w-8 px-0 text-base font-black" title="Delete" aria-label="Delete" on:click={stopAndDelete}>X</button>
      </div>
    </div>
  </div>
{:else}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="order-row grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-stretch gap-2 px-2.5 py-2.5 text-left" on:click={() => onOpen(order)}>
    <input
      type="checkbox"
      class="mt-1 h-[15px] w-[15px] shrink-0 accent-accent"
      checked={selected}
      title="Select for bulk action"
      on:click|stopPropagation
      on:change={handleCheckbox}
    />
    <div class="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] gap-x-2 gap-y-1">
      {#if order.itemThumb}
        <img src={order.itemThumb} alt={order.itemName} class="row-span-2 h-11 w-11 rounded-[var(--radius-md)] object-contain" loading="lazy" />
      {:else}
        <div class="row-span-2 h-11 w-11 rounded-[var(--radius-md)] bg-white/5"></div>
      {/if}
      <div class="min-w-0">
        <span class="order-item-name">
          {order.itemName}
          {#if order.modRank != null}
            <span class="ml-1 rounded-sm bg-[rgba(212,168,67,0.2)] px-1 py-0.5 text-[0.62rem] font-bold text-accent">R{order.modRank}</span>
          {/if}
        </span>
        <span class="ml-2 text-[0.7rem] font-semibold text-text-muted">Owned {ownedCount}</span>
      </div>
      <div class="flex flex-wrap gap-1">
        {#if isRankedListing && summaryRank != null}
          <span class="market-summary-chip"><small>WTS R{summaryRank}</small><strong>{wtsLabel}</strong></span>
          <span class="market-summary-chip"><small>WTB R{summaryRank}</small><strong>{wtbLabel}</strong></span>
        {:else}
          <span class="market-summary-chip"><small>Median</small><strong>{medianLabel}</strong></span>
        {/if}
      </div>
    </div>
    <div class="flex min-w-[6.5rem] shrink-0 items-center justify-center gap-1 font-display text-[1.12rem] font-bold text-accent">
      <img src={PLATINUM_ICON_URL} alt="" width="14" height="14" class="shrink-0" />
      {order.platinum}
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <span class="order-qty" title="Listed quantity">Qty {order.quantity}</span>
      <span class="order-vis {order.visible ? 'border-[rgba(74,222,128,0.35)] bg-[rgba(74,222,128,0.13)] text-success' : 'border-[rgba(251,191,36,0.35)] bg-[rgba(251,191,36,0.13)] text-warning'}">
        {order.visible ? "Visible" : "Hidden"}
      </span>
    </div>
    <div class="flex shrink-0 gap-1">
      <button class="btn-sm btn-secondary h-8" on:click={stopAndEdit}>Edit</button>
      <button class="btn-sm btn-danger h-8 w-8 px-0 text-base font-black" title="Delete" aria-label="Delete" on:click={stopAndDelete}>X</button>
    </div>
  </div>
{/if}

<style>
  .market-summary-chip {
    display: inline-grid;
    min-width: 4.7rem;
    gap: 0.05rem;
    border: 1px solid color-mix(in oklab, var(--accent) 38%, transparent);
    border-radius: var(--radius-md);
    background: color-mix(in oklab, var(--accent) 12%, var(--bg-raised));
    padding: 0.18rem 0.38rem;
  }
  .market-summary-chip small {
    color: color-mix(in oklab, var(--accent-bright) 76%, white);
    font-family: var(--font-display);
    font-size: 0.56rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    line-height: 1;
    text-transform: uppercase;
  }
  .market-summary-chip strong {
    color: var(--accent-bright);
    font-family: var(--font-display);
    font-size: 0.76rem;
    line-height: 1.05;
  }
</style>
