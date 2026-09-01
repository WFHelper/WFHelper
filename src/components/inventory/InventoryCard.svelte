<script lang="ts">
  import { itemLabel } from "../../lib/itemLabel.js";
  import { createEventDispatcher, onDestroy, onMount } from "svelte";

  import ArchonShardPips from "../archon/ArchonShardPips.svelte";
  import ItemImage from "../ItemImage.svelte";
  import MarketMetricStrip from "../MarketMetricStrip.svelte";
  import { NAV_ICON_URLS } from "../../lib/assetUrls.js";
  import { archonShardsBySuit } from "../../stores/archonShards.js";
  import { tr } from "../../lib/i18n.js";
  import type { InventoryViewItem } from "../../lib/inventoryMarket.js";
  import { isRankedGroup } from "../../../config/shared/numeric.js";

  export let item: InventoryViewItem;
  export let showDucats = true;
  export let canExpand = true;
  export let selectionMode = false;
  export let selected = false;
  /** False for rows the bulk-sell queue would reject; the box stays disabled. */
  export let selectable = true;

  const dispatch = createEventDispatcher<{
    select: InventoryViewItem;
    visible: InventoryViewItem;
    expand: InventoryViewItem;
    toggle: { item: InventoryViewItem; shiftKey: boolean };
  }>();
  let cardEl: HTMLDivElement | null = null;
  let visibilityObserver: IntersectionObserver | null = null;
  let visibilityReported = false;

  // Only Warframes carry sockets, so an empty result also means "not a frame".
  $: shardCopies = $archonShardsBySuit.get(item.uniqueName || item.internalName || "") ?? [];

  $: mastered = item.rank >= item.maxRank && item.maxRank > 1;
  $: canShowRank = item.maxRank > 1 && isRankedGroup(item.inventoryGroup);
  $: rankFillPct =
    canShowRank && item.maxRank > 0
      ? Math.max(0, Math.min(100, (item.rank / item.maxRank) * 100))
      : 0;

  $: showRankOrderSummary = isRankedGroup(item.inventoryGroup) && item.maxRank > 1;
  $: rankCapLabel = Number.isFinite(item.maxRank) ? Math.max(0, Math.floor(item.maxRank)) : 0;

  $: wtsRank0Label = item.wtsR0 != null ? `${item.wtsR0}p` : "-";
  $: wtbRank0Label = item.wtbR0 != null ? `${item.wtbR0}p` : "-";
  $: wtsRankMaxLabel = item.wtsRmax != null ? `${item.wtsRmax}p` : "-";
  $: wtbRankMaxLabel = item.wtbRmax != null ? `${item.wtbRmax}p` : "-";

  function selectCard(event: MouseEvent | KeyboardEvent): void {
    if (selectionMode) {
      if (selectable) dispatch("toggle", { item, shiftKey: event.shiftKey });
      return;
    }
    dispatch("select", item);
  }

  onMount(() => {
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

<div
  class="item-card group relative {mastered ? 'border-success/25' : ''} {item.isPrime
    ? 'border-accent/30'
    : ''} {selectionMode && !selectable ? 'opacity-45' : ''} {selected
    ? 'outline outline-2 outline-offset-[-2px] outline-[color:var(--accent)]'
    : ''}"
  role="button"
  tabindex="0"
  aria-label={!selectionMode
    ? $tr("common.openDetailsFor", { name: itemLabel(item) })
    : selectable
      ? $tr("inventory.selectItem", { name: itemLabel(item) })
      : $tr("inventory.notSellableItem", { name: itemLabel(item) })}
  aria-pressed={selectionMode ? selected : undefined}
  aria-disabled={selectionMode && !selectable ? true : undefined}
  on:click={selectCard}
  on:keydown={(event) => (event.key === "Enter" || event.key === " ") && selectCard(event)}
  bind:this={cardEl}
>
  {#if selectionMode}
    <!-- Sits where the Details button would be, which selection mode hides. The
         card is the labelled control, so the box is state paint, not a second one. -->
    <input
      type="checkbox"
      class="absolute top-1.5 right-1.5 z-10 h-4 w-4 accent-[color:var(--accent)]"
      checked={selected}
      disabled={!selectable}
      data-inventory-select-item={item.internalName}
      title={selectable ? undefined : $tr("inventory.notSellable")}
      aria-hidden="true"
      tabindex="-1"
      on:click|stopPropagation={(event) => {
        if (selectable) dispatch("toggle", { item, shiftKey: event.shiftKey });
      }}
    />
  {:else if canExpand}
    <button
      type="button"
      class="expand-link absolute top-1.5 right-1.5 z-10 inline-flex items-center rounded border border-border bg-black/45 px-1.5 py-0.5 font-display text-xs font-semibold text-text-secondary opacity-0 transition-[opacity,color,border-color] duration-100 group-hover:opacity-100 hover:text-accent hover:border-accent-dim"
      title={$tr("inventory.openItemDetails")}
      aria-label={$tr("common.openDetailsFor", { name: itemLabel(item) })}
      on:click|stopPropagation={() => dispatch("expand", item)}
    >
      {$tr("common.details")}
    </button>
  {/if}
  <div class="item-img-wrap">
    <ItemImage
      src={item.displayImageUrl}
      fallbackSrc={item.imageUrl !== item.displayImageUrl ? item.imageUrl : null}
      alt={itemLabel(item)}
      auditKey={item.name}
    />
    {#if item.vaulted}<span class="vault-badge">V</span>{/if}
    {#if shardCopies.length > 0}
      <!-- Absolute so a shardless card keeps exactly the same height. -->
      <span class="absolute bottom-1.5 left-1.5 flex flex-col items-start gap-0.5">
        {#each shardCopies as copy, copyIndex (copy.instanceId ?? copyIndex)}
          <ArchonShardPips
            slots={copy.slots}
            title={$tr("archon.shardCount", { count: copy.filled })}
          />
        {/each}
      </span>
    {/if}
    {#if item.orderPlaced}
      <span
        class="absolute top-1.5 left-1.5 inline-flex items-center justify-center rounded-full border border-border bg-black/50 p-1"
        title={$tr("inventory.listedOnWfm")}
      >
        <img src={NAV_ICON_URLS.market} alt={$tr("inventory.listedOnWfm")} class="h-3 w-3" />
      </span>
    {/if}
    {#if item.inventoryGroup === "incomplete_sets"}
      <span
        class="absolute right-2 bottom-1.5 font-display text-base font-bold text-info drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
        >{item.ownedPartTypes ?? 0}/{item.totalPartTypes ?? 0}</span
      >
    {:else}
      <span
        class="absolute right-2 bottom-1.5 font-display text-base font-bold text-success drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
        >x{item.amount}</span
      >
    {/if}
  </div>
  <div class="item-body">
    <span class="item-name">{itemLabel(item)}</span>
    <span class="item-type">
      {item.categoryLabel}
      {#if item.inventoryGroup === "full_sets"}
        {$tr("inventory.completeCount", {
          count: typeof item.completeSets === "number" ? item.completeSets : 0,
        })}
      {:else if item.inventoryGroup === "incomplete_sets"}
        {typeof item.missingParts === "number" && item.missingParts === 1
          ? $tr("inventory.needsPartsOne", { count: item.missingParts })
          : $tr("inventory.needsPartsMany", {
              count: typeof item.missingParts === "number" ? item.missingParts : 0,
            })}
      {/if}
    </span>

    <MarketMetricStrip
      platinum={item.platinum}
      ducats={item.ducats}
      ratio={item.ducatonator}
      {showDucats}
      className="mt-1"
    />

    {#if showRankOrderSummary}
      <div class="grid grid-cols-2 gap-1">
        <span
          class="inventory-rank-order-box grid gap-0.5 min-h-8 content-center border border-accent-bright/50 bg-accent/20 rounded-md py-1 px-1.5"
        >
          <span class="inventory-rank-order-label text-xs uppercase tracking-[0.04em] font-display"
            >{$tr("inventory.wtsRank", { rank: rankCapLabel })}</span
          >
          <strong>{wtsRankMaxLabel}</strong>
        </span>
        <span
          class="inventory-rank-order-box grid gap-0.5 min-h-8 content-center border border-accent-bright/50 bg-accent/20 rounded-md py-1 px-1.5"
        >
          <span class="inventory-rank-order-label text-xs uppercase tracking-[0.04em] font-display"
            >{$tr("inventory.wtbRank", { rank: rankCapLabel })}</span
          >
          <strong>{wtbRankMaxLabel}</strong>
        </span>
        <span
          class="inventory-rank-order-box grid gap-0.5 min-h-8 content-center border border-accent-bright/50 bg-accent/20 rounded-md py-1 px-1.5"
        >
          <span class="inventory-rank-order-label text-xs uppercase tracking-[0.04em] font-display"
            >{$tr("inventory.wtsR0")}</span
          >
          <strong>{wtsRank0Label}</strong>
        </span>
        <span
          class="inventory-rank-order-box grid gap-0.5 min-h-8 content-center border border-accent-bright/50 bg-accent/20 rounded-md py-1 px-1.5"
        >
          <span class="inventory-rank-order-label text-xs uppercase tracking-[0.04em] font-display"
            >{$tr("inventory.wtbR0")}</span
          >
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
      <span class="text-xs text-success whitespace-nowrap overflow-hidden text-ellipsis"
        >{item.equippedSummary}</span
      >
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
