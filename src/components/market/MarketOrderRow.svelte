<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    bestOrderPrice,
    normalizePerTrade,
    WFM_MOD_VARIANTS,
  } from "../../../config/shared/wfmOrders.js";
  import { fetchItemOrderBookBySlug } from "../../lib/wfm/orderBook.js";
  import { PLATINUM_ICON_URL } from "../../lib/assetUrls.js";
  import MarketOrderSummary from "./MarketOrderSummary.svelte";
  import MarketRowBase from "./MarketRowBase.svelte";
  import OrderStepper from "./OrderStepper.svelte";
  import { isRankedGroup } from "../../../config/shared/numeric.js";
  import { tr } from "../../lib/i18n.js";
  import type { InventoryViewItem } from "../../lib/inventoryMarket.js";
  import { listingWarning, type ListingInventoryMatch } from "../../lib/marketListing.js";
  import type { OrderModalHint, WfmOrder } from "../../types/market.js";

  export let order: WfmOrder;
  export let item: (InventoryViewItem & { sourceOrderId?: string }) | null = null;
  export let compact = false;
  export let selected = false;
  export let onSelectChange: (orderId: string, checked: boolean) => void;
  export let onOpen: (order: WfmOrder) => void;
  export let onEdit: (order: WfmOrder, hint: OrderModalHint) => void;
  export let onDelete: (orderId: string) => void;
  export let onCloseOne: (order: WfmOrder) => void;
  /** A warframe.market write to this order is in flight; its other writes stay disabled. */
  export let busy = false;
  export let onInlineSave: (
    order: WfmOrder,
    updates: { platinum: number; quantity: number },
  ) => Promise<boolean>;
  export let inventoryMatch: ListingInventoryMatch | null = null;

  let draftPlatinum = 0;
  let draftQuantity = 0;
  let syncedPlatinum: number | undefined;
  let syncedQuantity: number | undefined;
  let variantPrices: { wts: number | null; wtb: number | null } | null = null;
  let variantRequest = 0;

  $: modVariant = WFM_MOD_VARIANTS.some((variant) => variant === order.subtype);
  $: void loadVariantPrices(order.itemUrlName, order.modRank, modVariant ? order.subtype : null);

  async function loadVariantPrices(
    slug: string | null,
    rank: number | null,
    subtype: string | null | undefined,
  ): Promise<void> {
    const token = ++variantRequest;
    variantPrices = null;
    if (!slug || !subtype) return;
    try {
      const result = await fetchItemOrderBookBySlug(slug, {
        rank,
        subtype,
        priority: "background",
      });
      if (token !== variantRequest || result.status !== "ok") return;
      variantPrices = {
        wts: bestOrderPrice(result.data.sell, "sell", true),
        wtb: bestOrderPrice(result.data.buy, "buy", true),
      };
    } catch {
      // Unavailable variant prices stay blank instead of falling back to regular.
    }
  }

  onDestroy(() => {
    variantRequest += 1;
  });

  $: syncDrafts(order.platinum, order.quantity);
  $: dirty = draftPlatinum !== order.platinum || draftQuantity !== order.quantity;

  function syncDrafts(platinum: number, quantity: number): void {
    if (platinum !== syncedPlatinum) {
      syncedPlatinum = platinum;
      draftPlatinum = platinum;
    }
    if (quantity !== syncedQuantity) {
      syncedQuantity = quantity;
      draftQuantity = quantity;
    }
  }

  // A close patches order.quantity, which resets the quantity draft above, so Apply
  // never sends the stock from before the close.
  function applyInline(): void {
    if (!dirty || busy) return;
    void onInlineSave(order, { platinum: draftPlatinum, quantity: draftQuantity });
  }

  function stopAndApply(event: MouseEvent): void {
    event.stopPropagation();
    applyInline();
  }

  $: orderKind = order.orderType === "buy" ? "WTB" : "WTS";
  $: orderKindClass =
    order.orderType === "buy" ? "bg-info-bg text-info" : "bg-warning-bg text-warning";
  $: liveLabel = order.visible ? $tr("market.liveLower") : $tr("market.hiddenLower");
  $: closeOneLabel =
    order.orderType === "buy" ? $tr("market.orderBought") : $tr("market.orderSold");
  $: tradeSize = normalizePerTrade(order.perTrade);
  // Sold acts on the saved listing, so an unapplied edit would close the old stock.
  $: closeOneTitle = dirty
    ? $tr("market.orderSoldApplyFirst")
    : tradeSize > 1
      ? $tr(
          order.orderType === "buy" ? "market.orderBoughtTradeTitle" : "market.orderSoldTradeTitle",
          { count: tradeSize },
        )
      : $tr(order.orderType === "buy" ? "market.orderBoughtTitle" : "market.orderSoldTitle");
  $: ownedCount = item?.amount ?? 0;
  $: warning = listingWarning(inventoryMatch, order.modRank, $tr);
  $: isRankedListing = item
    ? isRankedGroup(item.inventoryGroup) && item.maxRank > 0
    : order.modRank != null;
  $: rankCap = item?.maxRank && item.maxRank > 0 ? Math.floor(item.maxRank) : 0;
  $: listedRank = order.modRank != null ? Math.max(0, Math.floor(order.modRank)) : null;
  $: summaryRank = modVariant
    ? listedRank
    : isRankedListing && listedRank != null
      ? listedRank === rankCap
        ? rankCap
        : 0
      : null;
  $: summaryWts =
    summaryRank === rankCap && summaryRank !== 0
      ? (item?.wtsRmax ?? null)
      : summaryRank === 0
        ? (item?.wtsR0 ?? null)
        : null;
  $: summaryWtb =
    summaryRank === rankCap && summaryRank !== 0
      ? (item?.wtbRmax ?? null)
      : summaryRank === 0
        ? (item?.wtbR0 ?? null)
        : null;
  $: medianLabel = !modVariant && item?.platinum != null ? `~${item.platinum}p` : "-";
  $: wts = modVariant ? variantPrices?.wts : summaryWts;
  $: wtb = modVariant ? variantPrices?.wtb : summaryWtb;
  $: wtsLabel = wts != null ? `${wts}p` : "-";
  $: wtbLabel = wtb != null ? `${wtb}p` : "-";

  function handleCheckbox(event: Event): void {
    onSelectChange(order.id, (event.currentTarget as HTMLInputElement).checked);
  }

  function stopAndEdit(event: MouseEvent): void {
    event.stopPropagation();
    onEdit(order, { wts: wtsLabel, wtb: wtbLabel, median: medianLabel });
  }

  function stopAndDelete(event: MouseEvent): void {
    event.stopPropagation();
    onDelete(order.id);
  }

  function stopAndCloseOne(event: MouseEvent): void {
    event.stopPropagation();
    onCloseOne(order);
  }
</script>

{#snippet subtypeChip()}
  {#if order.subtype}
    <span
      class="shrink-0 rounded-sm bg-accent/20 px-1 py-0.5 text-xs font-bold text-accent"
      data-order-subtype-chip
    >
      {order.subtype === "regular"
        ? $tr("orderModal.regular")
        : order.subtype.charAt(0).toUpperCase() + order.subtype.slice(1)}
    </span>
  {/if}
{/snippet}

{#if compact}
  <MarketRowBase
    compact
    title={order.itemName}
    thumb={order.itemThumb}
    badgeLabel={orderKind}
    badgeClass={orderKindClass}
    onOpen={() => onOpen(order)}
  >
    <svelte:fragment slot="headerStart">
      <input
        type="checkbox"
        checked={selected}
        title={$tr("market.selectForBulk")}
        on:click|stopPropagation
        on:change={handleCheckbox}
      />
    </svelte:fragment>
    <svelte:fragment slot="titleMeta">
      <span class="ml-1.5 text-xs font-semibold text-text-muted"
        >{$tr("market.ownedCount", { count: ownedCount })}</span
      >
    </svelte:fragment>
    <svelte:fragment slot="headerEnd">
      {@render subtypeChip()}
      {#if order.modRank != null}
        <span class="shrink-0 rounded-sm bg-accent/20 px-1 py-0.5 text-xs font-bold text-accent">
          R{order.modRank}
        </span>
      {/if}
      <span
        class="shrink-0 text-xs font-semibold {order.visible ? 'text-success' : 'text-warning'}"
        title={order.visible ? $tr("market.visibleOnWfm") : $tr("market.hiddenOnWfm")}
      >
        {liveLabel}
      </span>
    </svelte:fragment>
    <svelte:fragment slot="compactBody">
      <div class="flex min-w-0 flex-1 flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-2">
          <span class="flex items-center gap-0.5" title={$tr("common.listedQuantity")}>
            <span class="text-xs font-semibold uppercase tracking-[0.04em] text-text-muted"
              >{$tr("market.qtyAbbrev")}</span
            >
            <OrderStepper
              value={draftQuantity}
              min={1}
              max={999}
              label={$tr("market.quantity")}
              onChange={(next) => (draftQuantity = next)}
            />
          </span>
          <span
            class="flex items-center gap-0.5"
            title={$tr("common.pricePlatinum")}
            data-order-price-stepper
          >
            <img src={PLATINUM_ICON_URL} alt="" width="14" height="14" class="shrink-0" />
            <OrderStepper
              value={draftPlatinum}
              min={1}
              max={99999}
              label={$tr("market.price")}
              accent
              onChange={(next) => (draftPlatinum = next)}
            />
          </span>
        </div>
        <MarketOrderSummary
          {modVariant}
          {isRankedListing}
          {summaryRank}
          {wtsLabel}
          {wtbLabel}
          {medianLabel}
        />
        {#if warning}
          <span class="listing-warning self-start" data-order-warning title={warning.title}
            >{warning.label}</span
          >
        {/if}
      </div>
    </svelte:fragment>
    <svelte:fragment slot="compactActions">
      <div class="flex shrink-0 items-center gap-1.5" data-order-actions>
        {#if dirty}
          <button
            class="btn-success btn-sm h-7 w-7 px-0 text-sm font-black"
            title={$tr("market.applyNewPriceQty")}
            aria-label={$tr("market.applyChanges")}
            disabled={busy}
            on:click={stopAndApply}>&check;</button
          >
        {/if}
        <button
          class="btn-sm btn-secondary h-7 px-2 text-xs"
          title={closeOneTitle}
          data-order-close-one={order.id}
          disabled={busy || dirty || order.quantity < tradeSize}
          on:click={stopAndCloseOne}>{closeOneLabel}</button
        >
        <button
          class="btn-sm btn-secondary h-7 px-2 text-xs"
          title={$tr("market.edit")}
          data-order-edit={order.id}
          disabled={busy}
          on:click={stopAndEdit}>{$tr("market.edit")}</button
        >
        <button
          class="btn-sm btn-danger h-7 w-7 px-0 text-sm font-black"
          title={$tr("common.delete")}
          aria-label={$tr("common.delete")}
          disabled={busy}
          on:click={stopAndDelete}>X</button
        >
      </div>
    </svelte:fragment>
  </MarketRowBase>
{:else}
  <MarketRowBase
    title={order.itemName}
    thumb={order.itemThumb}
    fullClass="grid grid-cols-[auto_minmax(0,1fr)_auto] items-stretch gap-2 px-2.5 py-2.5"
    fullMainClass="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] gap-x-2 gap-y-1"
    fullContentClass="contents"
    fullImageClass="row-span-2 h-11 w-11 rounded-[var(--radius-md)] object-contain"
    onOpen={() => onOpen(order)}
  >
    <svelte:fragment slot="fullStart">
      <input
        type="checkbox"
        class="mt-1"
        checked={selected}
        title={$tr("market.selectForBulk")}
        on:click|stopPropagation
        on:change={handleCheckbox}
      />
    </svelte:fragment>
    <svelte:fragment slot="titleMeta">
      <span class="ml-2 text-xs font-semibold text-text-muted"
        >{$tr("market.ownedCount", { count: ownedCount })}</span
      >
    </svelte:fragment>
    <svelte:fragment slot="fullBody">
      <div class="flex min-w-0 flex-col gap-1">
        <MarketOrderSummary
          {modVariant}
          {isRankedListing}
          {summaryRank}
          {wtsLabel}
          {wtbLabel}
          {medianLabel}
        />
        {#if warning}
          <span class="listing-warning self-start" data-order-warning title={warning.title}
            >{warning.label}</span
          >
        {/if}
      </div>
    </svelte:fragment>
    <svelte:fragment slot="fullActions">
      <div class="flex shrink-0 items-center gap-2">
        {@render subtypeChip()}
        {#if order.modRank != null}
          <span class="shrink-0 rounded-sm bg-accent/20 px-1 py-0.5 text-xs font-bold text-accent">
            R{order.modRank}
          </span>
        {/if}
        {#if order.visible}
          <span class="order-vis border-success/35 bg-success/15 text-success"
            >{$tr("market.visible")}</span
          >
        {:else}
          <span class="order-vis border-warning/35 bg-warning/15 text-warning"
            >{$tr("common.hidden")}</span
          >
        {/if}
        <span class="flex items-center gap-0.5" title={$tr("common.listedQuantity")}>
          <span class="text-xs font-semibold uppercase tracking-[0.04em] text-text-muted"
            >{$tr("market.qtyAbbrev")}</span
          >
          <OrderStepper
            value={draftQuantity}
            min={1}
            max={999}
            label={$tr("market.quantity")}
            onChange={(next) => (draftQuantity = next)}
          />
        </span>
        <span class="flex items-center gap-0.5" title={$tr("common.pricePlatinum")}>
          <img src={PLATINUM_ICON_URL} alt="" width="14" height="14" class="shrink-0" />
          <OrderStepper
            value={draftPlatinum}
            min={1}
            max={99999}
            label={$tr("market.price")}
            accent
            onChange={(next) => (draftPlatinum = next)}
          />
        </span>
        {#if dirty}
          <button
            class="btn-success btn-sm h-7 w-7 px-0 text-sm font-black"
            title={$tr("market.applyNewPriceQty")}
            aria-label={$tr("market.applyChanges")}
            disabled={busy}
            on:click={stopAndApply}>&check;</button
          >
        {/if}
        <button
          class="btn-sm btn-secondary h-7 px-2 text-xs"
          title={closeOneTitle}
          data-order-close-one={order.id}
          disabled={busy || dirty || order.quantity < tradeSize}
          on:click={stopAndCloseOne}>{closeOneLabel}</button
        >
        <button
          class="btn-sm btn-secondary h-7 px-2 text-xs"
          data-order-edit={order.id}
          disabled={busy}
          on:click={stopAndEdit}>{$tr("market.edit")}</button
        >
        <button
          class="btn-sm btn-danger h-7 w-7 px-0 text-sm font-black"
          title={$tr("common.delete")}
          aria-label={$tr("common.delete")}
          disabled={busy}
          on:click={stopAndDelete}>X</button
        >
      </div>
    </svelte:fragment>
  </MarketRowBase>
{/if}
