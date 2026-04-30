<script lang="ts">
  import { PLATINUM_ICON_URL } from "../../lib/assetUrls.js";
  import MarketOrderSummary from "./MarketOrderSummary.svelte";
  import MarketRowBase from "./MarketRowBase.svelte";
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
  $: orderKindClass =
    order.orderType === "buy" ? "bg-sky-500/20 text-sky-300" : "bg-amber-500/20 text-amber-300";
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
  $: rankBadges = order.modRank != null ? [`R${order.modRank}`] : [];

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
  <MarketRowBase
    compact
    title={order.itemName}
    thumb={order.itemThumb}
    badgeLabel={orderKind}
    badgeClass={orderKindClass}
    {rankBadges}
    onOpen={() => onOpen(order)}
  >
    <svelte:fragment slot="headerStart">
      <input
        type="checkbox"
        class="h-3.5 w-3.5 shrink-0 accent-accent"
        checked={selected}
        title="Select for bulk action"
        on:click|stopPropagation
        on:change={handleCheckbox}
      />
    </svelte:fragment>
    <svelte:fragment slot="titleMeta">
      <span class="ml-1.5 text-[0.68rem] font-semibold text-text-muted">Owned {ownedCount}</span>
    </svelte:fragment>
    <svelte:fragment slot="headerEnd">
      <span
        class="shrink-0 text-[0.68rem] font-semibold {order.visible ? 'text-success' : 'text-warning'}"
        title={order.visible ? "Visible on WFM" : "Hidden on WFM"}
      >
        {liveLabel}
      </span>
    </svelte:fragment>
    <svelte:fragment slot="compactBody">
      <div class="flex min-w-0 flex-1 flex-col gap-1.5">
        <span class="flex items-baseline gap-1 font-display leading-none" title="Listed quantity">
          <span class="text-[0.68rem] uppercase tracking-[0.04em] text-text-muted">Qty</span>
          <span class="text-lg font-bold leading-none text-text-primary">{order.quantity}</span>
        </span>
        <MarketOrderSummary {isRankedListing} {summaryRank} {wtsLabel} {wtbLabel} {medianLabel} />
      </div>
    </svelte:fragment>
    <svelte:fragment slot="compactActions">
      <div class="flex shrink-0 items-center gap-2">
        <span class="flex items-center gap-1 font-display text-lg font-bold leading-none text-accent" title="Platinum">
          <img src={PLATINUM_ICON_URL} alt="" width="16" height="16" class="shrink-0" />
          {order.platinum}
        </span>
        <button class="btn-sm btn-secondary h-8" title="Edit" on:click={stopAndEdit}>Edit</button>
        <button class="btn-sm btn-danger h-8 w-8 px-0 text-base font-black" title="Delete" aria-label="Delete" on:click={stopAndDelete}>X</button>
      </div>
    </svelte:fragment>
  </MarketRowBase>
{:else}
  <MarketRowBase
    title={order.itemName}
    thumb={order.itemThumb}
    {rankBadges}
    fullClass="grid grid-cols-[auto_minmax(0,1fr)_auto] items-stretch gap-2 px-2.5 py-2.5"
    fullMainClass="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] gap-x-2 gap-y-1"
    fullContentClass="contents"
    fullImageClass="row-span-2 h-11 w-11 rounded-[var(--radius-md)] object-contain"
    onOpen={() => onOpen(order)}
  >
    <svelte:fragment slot="fullStart">
      <input
        type="checkbox"
        class="mt-1 h-[15px] w-[15px] shrink-0 accent-accent"
        checked={selected}
        title="Select for bulk action"
        on:click|stopPropagation
        on:change={handleCheckbox}
      />
    </svelte:fragment>
    <svelte:fragment slot="titleMeta">
      <span class="ml-2 text-[0.7rem] font-semibold text-text-muted">Owned {ownedCount}</span>
    </svelte:fragment>
    <svelte:fragment slot="fullBody">
      <MarketOrderSummary {isRankedListing} {summaryRank} {wtsLabel} {wtbLabel} {medianLabel} />
    </svelte:fragment>
    <svelte:fragment slot="fullActions">
      <div class="flex shrink-0 items-center gap-2">
        <span class="order-qty" title="Listed quantity">Qty {order.quantity}</span>
        <span class="order-vis" class:orderVisible={order.visible} class:orderHidden={!order.visible}>
          {order.visible ? "Visible" : "Hidden"}
        </span>
        <span class="flex min-w-[3.9rem] items-center justify-end gap-1 font-display text-[1.12rem] font-bold text-accent">
          <img src={PLATINUM_ICON_URL} alt="" width="14" height="14" class="shrink-0" />
          {order.platinum}
        </span>
        <button class="btn-sm btn-secondary h-8" on:click={stopAndEdit}>Edit</button>
        <button class="btn-sm btn-danger h-8 w-8 px-0 text-base font-black" title="Delete" aria-label="Delete" on:click={stopAndDelete}>X</button>
      </div>
    </svelte:fragment>
  </MarketRowBase>
{/if}

<style>
  .orderVisible {
    border-color: rgba(74, 222, 128, 0.35);
    background: rgba(74, 222, 128, 0.13);
    color: var(--success);
  }
  .orderHidden {
    border-color: rgba(251, 191, 36, 0.35);
    background: rgba(251, 191, 36, 0.13);
    color: var(--warning);
  }
</style>
