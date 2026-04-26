<script lang="ts">
  import { PLATINUM_ICON_URL } from "../../lib/assetUrls.js";
  import type { WfmOrder } from "../../types/market.js";

  export let order: WfmOrder;
  export let compact = false;
  export let selected = false;
  export let onSelectChange: (orderId: string, checked: boolean) => void;
  export let onEdit: (order: WfmOrder) => void;
  export let onDelete: (orderId: string) => void;

  $: orderKind = order.orderType === "buy" ? "WTB" : "WTS";
  $: liveLabel = order.visible ? "live" : "hidden";

  function handleCheckbox(event: Event): void {
    onSelectChange(order.id, (event.currentTarget as HTMLInputElement).checked);
  }
</script>

{#if compact}
  <div class="order-row flex flex-col overflow-hidden p-0">
    <div class="flex items-center gap-2 border-b border-border bg-bg-raised px-2.5 py-1.5">
      <input
        type="checkbox"
        class="h-3.5 w-3.5 shrink-0 accent-accent"
        checked={selected}
        title="Select for bulk action"
        on:change={handleCheckbox}
      />
      <span class="shrink-0 rounded px-1.5 py-0.5 text-[0.62rem] font-bold tracking-wide {order.orderType === 'buy' ? 'bg-sky-500/20 text-sky-300' : 'bg-amber-500/20 text-amber-300'}">
        {orderKind}
      </span>
      <span class="min-w-0 flex-1 truncate font-display text-[0.88rem] font-bold text-text-primary" title={order.itemName}>
        {order.itemName}
      </span>
      {#if order.modRank != null}
        <span class="shrink-0 rounded-sm bg-[rgba(212,168,67,0.2)] px-1 py-0.5 text-[0.62rem] font-bold text-accent">R{order.modRank}</span>
      {/if}
      <span
        class="shrink-0 text-[0.68rem] font-semibold {order.visible ? 'text-success' : 'text-warning'}"
        title={order.visible ? "Visible on WFM" : "Hidden on WFM"}
      >
        {order.visible ? "●" : "○"} {liveLabel}
      </span>
    </div>

    <div class="flex items-center gap-2.5 px-2.5 py-2">
      {#if order.itemThumb}
        <img src={order.itemThumb} alt={order.itemName} class="h-11 w-11 shrink-0 rounded-[var(--radius-md)] bg-black/30 object-contain" loading="lazy" />
      {:else}
        <div class="h-11 w-11 shrink-0 rounded-[var(--radius-md)] bg-white/5"></div>
      {/if}
      <div class="flex flex-1 items-center gap-4">
        <span class="flex items-baseline gap-1 font-display" title="Quantity">
          <span class="text-[0.75rem] text-text-muted">x</span>
          <span class="text-lg font-bold leading-none text-text-primary">{order.quantity}</span>
        </span>
        <span class="flex items-center gap-1 font-display" title="Platinum">
          <img src={PLATINUM_ICON_URL} alt="" width="16" height="16" class="shrink-0" />
          <span class="text-lg font-bold leading-none text-accent">{order.platinum}</span>
        </span>
      </div>
      <div class="flex shrink-0 gap-1">
        <button class="btn-sm btn-secondary" title="Edit" on:click={() => onEdit(order)}>Edit</button>
        <button class="btn-sm btn-danger" title="Delete" on:click={() => onDelete(order.id)}>&times;</button>
      </div>
    </div>
  </div>
{:else}
  <div class="order-row flex items-center gap-2 px-2.5 py-2">
    <input
      type="checkbox"
      class="h-[15px] w-[15px] shrink-0 accent-accent"
      checked={selected}
      title="Select for bulk action"
      on:change={handleCheckbox}
    />
    <div class="flex min-w-0 flex-1 items-center gap-2">
      {#if order.itemThumb}
        <img src={order.itemThumb} alt={order.itemName} class="h-9 w-9 rounded-[var(--radius-md)] object-contain" loading="lazy" />
      {:else}
        <div class="h-9 w-9 rounded-[var(--radius-md)] bg-white/5"></div>
      {/if}
      <span class="order-item-name">
        {order.itemName}
        {#if order.modRank != null}
          <span class="ml-1 rounded-sm bg-[rgba(212,168,67,0.2)] px-1 py-0.5 text-[0.62rem] font-bold text-accent">R{order.modRank}</span>
        {/if}
      </span>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <span class="inline-flex items-center gap-1 font-display text-[0.9rem] font-bold text-accent">
        <img src={PLATINUM_ICON_URL} alt="" width="14" height="14" class="shrink-0" />
        {order.platinum}
      </span>
      <span class="order-qty">x{order.quantity}</span>
      <span class="order-vis {order.visible ? 'border-[rgba(74,222,128,0.35)] bg-[rgba(74,222,128,0.13)] text-success' : 'border-[rgba(251,191,36,0.35)] bg-[rgba(251,191,36,0.13)] text-warning'}">
        {order.visible ? "Visible" : "Hidden"}
      </span>
    </div>
    <div class="flex shrink-0 gap-1">
      <button class="btn-sm btn-secondary" on:click={() => onEdit(order)}>Edit</button>
      <button class="btn-sm btn-danger" on:click={() => onDelete(order.id)}>&times;</button>
    </div>
  </div>
{/if}
