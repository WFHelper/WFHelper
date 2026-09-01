<script lang="ts">
  import { onDestroy } from "svelte";

  import ArchonShardPips from "../archon/ArchonShardPips.svelte";
  import ItemImage from "../ItemImage.svelte";
  import { NAV_ICON_URLS } from "../../lib/assetUrls.js";
  import { archonShardsBySuit } from "../../stores/archonShards.js";
  // Aliased: a store named `tr` makes Svelte treat <tr> table rows as a component.
  import { locale, tr as t } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import { itemLabel } from "../../lib/itemLabel.js";
  import { INVENTORY_LIST_COLUMNS, nextInventorySort } from "./inventoryListColumns.js";
  import type { InventoryViewItem } from "../../lib/inventoryMarket.js";
  import type { SharedSortKey, SortDirection } from "../../types/filters.js";
  import { isRankedGroup } from "../../../config/shared/numeric.js";

  interface Props {
    items: InventoryViewItem[];
    /** Unsliced result count; null means `items` is already the complete list. */
    totalCount: number | null;
    showDucats: boolean;
    /** Internal names the detail modal can actually open; null = no gating. */
    detailKeys: Set<string> | null;
    sortBy: SharedSortKey;
    sortDirection: SortDirection;
    /** Sort keys the active tab can compute; anything else stays a plain header. */
    sortableKeys: ReadonlySet<string>;
    onSort: (patch: { sortBy: SharedSortKey; sortDirection: SortDirection }) => void;
    onSelect: (item: InventoryViewItem) => void;
    onExpand: (item: InventoryViewItem) => void;
    onVisible: (item: InventoryViewItem) => void;
    onMore: () => void;
    selectionMode?: boolean;
    /** Selected/eligible keys are Sets so a paged table stays O(1) per row. */
    selectedKeys?: ReadonlySet<string> | null;
    eligibleKeys?: ReadonlySet<string> | null;
    onToggleSelect?: (item: InventoryViewItem, shiftKey: boolean) => void;
  }

  let {
    items,
    totalCount,
    showDucats,
    detailKeys,
    sortBy,
    sortDirection,
    sortableKeys,
    onSort,
    onSelect,
    onExpand,
    onVisible,
    onMore,
    selectionMode = false,
    selectedKeys = null,
    eligibleKeys = null,
    onToggleSelect = () => {},
  }: Props = $props();

  // Keys land with this feature's i18n commit; cast until en.json carries them.
  const k = (key: string): MessageKey => key as MessageKey;

  const columns = $derived(
    INVENTORY_LIST_COLUMNS.filter((column) => showDucats || column.key !== "ducats"),
  );

  // One observer for the whole table, not one per row: a page is 120 rows and
  // the Everything tab pages through thousands. Plain Map/Set on purpose, since
  // nothing renders from them and a reactive source per entry would only cost.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const rowItems = new Map<Element, InventoryViewItem>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const reportedVisible = new Set<string>();
  const visibilityObserver: IntersectionObserver | null =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const item = rowItems.get(entry.target);
              if (!item || reportedVisible.has(item.internalName)) continue;
              reportedVisible.add(item.internalName);
              visibilityObserver?.unobserve(entry.target);
              onVisible(item);
            }
          },
          { root: null, rootMargin: "160px 0px 240px 0px", threshold: 0.01 },
        );

  onDestroy(() => {
    visibilityObserver?.disconnect();
    rowItems.clear();
  });

  function trackRow(
    node: HTMLElement,
    item: InventoryViewItem,
  ): { update: (next: InventoryViewItem) => void; destroy: () => void } {
    rowItems.set(node, item);
    if (!reportedVisible.has(item.internalName)) visibilityObserver?.observe(node);
    return {
      update(next: InventoryViewItem): void {
        rowItems.set(node, next);
      },
      destroy(): void {
        rowItems.delete(node);
        visibilityObserver?.unobserve(node);
      },
    };
  }

  // Fires once per sentinel node; the {#key} below remounts it after every
  // extension so a viewport taller than one page keeps filling.
  function observeMore(node: HTMLElement): { destroy: () => void } {
    if (typeof IntersectionObserver === "undefined") return { destroy: () => {} };
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onMore();
      },
      { rootMargin: "600px" },
    );
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }

  function headerSortKey(column: (typeof INVENTORY_LIST_COLUMNS)[number]): SharedSortKey | null {
    return column.sortKey && sortableKeys.has(column.sortKey) ? column.sortKey : null;
  }

  function sortByColumn(sortKey: SharedSortKey): void {
    onSort(nextInventorySort({ sortBy, sortDirection }, sortKey));
  }

  function openRow(item: InventoryViewItem, event?: MouseEvent | KeyboardEvent): void {
    if (selectionMode) {
      if (isSelectable(item)) onToggleSelect(item, event?.shiftKey === true);
      return;
    }
    // A card puts the modal behind its Details button and the order book behind
    // the card body; a row is one target, so the modal wins where it exists.
    if (!detailKeys || detailKeys.has(item.internalName)) onExpand(item);
    else onSelect(item);
  }

  function isSelectable(item: InventoryViewItem): boolean {
    return eligibleKeys?.has(item.internalName) ?? false;
  }

  function ownedLabel(item: InventoryViewItem, code: string): string {
    if (item.inventoryGroup === "incomplete_sets") {
      return `${item.ownedPartTypes ?? 0}/${item.totalPartTypes ?? 0}`;
    }
    return (item.amount ?? 0).toLocaleString(code);
  }

  function numberLabel(value: number | null | undefined, code: string): string {
    return typeof value === "number" ? value.toLocaleString(code) : "-";
  }

  function showsRank(item: InventoryViewItem): boolean {
    return isRankedGroup(item.inventoryGroup) && item.maxRank > 1;
  }

  function isMaxRank(item: InventoryViewItem): boolean {
    return item.maxRank > 1 && item.rank >= item.maxRank;
  }
</script>

<div class="inventory-list" data-inventory-list>
  {#if items.length === 0}
    <div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <p>{$t("inventory.noItemsFound")}</p>
    </div>
  {:else}
    <table class="w-full border-collapse text-sm">
      <thead>
        <tr class="text-left text-xs tracking-wide text-text-muted uppercase">
          {#if selectionMode}
            <th class="w-8 border-b border-border bg-bg-base px-2 py-2">
              <span class="sr-only">{$t(k("inventory.selectMode"))}</span>
            </th>
          {/if}
          {#each columns as column (column.key)}
            {@const sortKey = headerSortKey(column)}
            {@const active = sortKey !== null && sortBy === sortKey}
            <th
              class="border-b border-border bg-bg-base px-2 py-2 font-semibold {column.numeric
                ? 'text-right'
                : 'text-left'} {column.key === 'icon' ? 'w-10' : ''}"
              data-list-column={column.key}
              aria-sort={active ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
            >
              {#if column.labelKey === null}
                <span class="sr-only">{$t("common.item")}</span>
              {:else if sortKey === null}
                {$t(column.labelKey)}
              {:else}
                <button
                  type="button"
                  class="inline-flex w-full items-center gap-1 uppercase {column.numeric
                    ? 'justify-end'
                    : 'justify-start'} {active ? 'text-accent' : 'hover:text-text-secondary'}"
                  data-list-sort={sortKey}
                  title={sortDirection === "asc"
                    ? $t("common.sortDirectionAscending")
                    : $t("common.sortDirectionDescending")}
                  onclick={() => sortByColumn(sortKey)}
                >
                  {$t(column.labelKey)}
                  {#if active}
                    <svg
                      class="h-3 w-3 shrink-0 {sortDirection === 'asc' ? '' : 'rotate-180'}"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                      aria-hidden="true"
                    >
                      <path d="M6 15l6-6 6 6" />
                    </svg>
                  {/if}
                </button>
              {/if}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each items as item (item.internalName)}
          <!-- Only Warframes carry sockets, so an empty result also means "not a frame". -->
          {@const shardCopies =
            $archonShardsBySuit.get(item.uniqueName || item.internalName || "") ?? []}
          {@const selected = selectedKeys?.has(item.internalName) ?? false}
          <tr
            class="cursor-pointer border-b border-border/50 transition-colors duration-100 hover:bg-bg-raised {selected
              ? 'bg-accent/15'
              : ''} {selectionMode && !isSelectable(item) ? 'opacity-45' : ''}"
            data-list-row={item.internalName}
            use:trackRow={item}
            onclick={(event) => openRow(item, event)}
          >
            {#if selectionMode}
              <td class="px-2 py-1">
                <input
                  type="checkbox"
                  class="themed-checkbox"
                  checked={selected}
                  disabled={!isSelectable(item)}
                  data-inventory-select-item={item.internalName}
                  title={isSelectable(item) ? undefined : $t(k("inventory.notSellable"))}
                  aria-label={$t(k("inventory.selectItem"), { name: itemLabel(item) })}
                  onclick={(event) => {
                    event.stopPropagation();
                    if (isSelectable(item)) onToggleSelect(item, event.shiftKey);
                  }}
                />
              </td>
            {/if}
            <td class="px-2 py-1">
              <span
                class="flex h-8 w-8 items-center justify-center overflow-hidden rounded border border-border/60 bg-black/25"
              >
                <ItemImage
                  src={item.displayImageUrl}
                  fallbackSrc={item.imageUrl !== item.displayImageUrl ? item.imageUrl : null}
                  alt={itemLabel(item)}
                  auditKey={item.name}
                  cls="max-h-7 max-w-7 object-contain"
                />
              </span>
            </td>
            <td class="px-2 py-1">
              <!-- The row click is a convenience; this button is what keyboard
                   users reach, so it carries the same action. -->
              <button
                type="button"
                class="block text-left font-semibold hover:text-accent {item.isPrime
                  ? 'text-accent'
                  : 'text-text-primary'}"
                aria-label={$t("common.openDetailsFor", { name: itemLabel(item) })}
                onclick={(event) => {
                  event.stopPropagation();
                  openRow(item, event);
                }}
              >
                {itemLabel(item)}
              </button>
              <span class="flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
                <span>{item.categoryLabel}</span>
                {#if item.vaulted}<span
                    class="vault-badge vault-badge--inline"
                    title={$t("common.vaulted")}>V</span
                  >{/if}
                {#each shardCopies as copy, copyIndex (copy.instanceId ?? copyIndex)}
                  <ArchonShardPips
                    slots={copy.slots}
                    title={$t("archon.shardCount", { count: copy.filled })}
                  />
                {/each}
              </span>
            </td>
            <td class="px-2 py-1 text-right font-semibold text-success tabular-nums">
              {ownedLabel(item, $locale)}
            </td>
            <td class="px-2 py-1 text-xs whitespace-nowrap">
              {#if showsRank(item)}
                <span
                  class="tabular-nums {isMaxRank(item) ? 'text-success' : 'text-text-secondary'}"
                  >{item.rank}/{item.maxRank}</span
                >
              {:else if item.parentMastered === true || isMaxRank(item)}
                <span class="text-success">{$t("common.mastered")}</span>
              {:else if item.parentMastered === false}
                <span class="text-text-muted">{$t("common.notMastered")}</span>
              {:else}
                <span class="text-text-muted">-</span>
              {/if}
            </td>
            <td
              class="px-2 py-1 text-right tabular-nums {item.platinum == null
                ? 'text-text-muted'
                : 'text-accent-bright'}"
            >
              {numberLabel(item.platinum, $locale)}
            </td>
            {#if showDucats}
              <td
                class="px-2 py-1 text-right tabular-nums {item.ducats == null
                  ? 'text-text-muted'
                  : 'text-accent'}"
              >
                {numberLabel(item.ducats, $locale)}
              </td>
            {/if}
            <td class="px-2 py-1">
              <button
                type="button"
                class="inline-flex items-center gap-1 text-xs text-text-muted hover:text-accent"
                data-list-order-state={item.orderPlaced ? "listed" : "unlisted"}
                title={item.orderPlaced ? $t("inventory.listedOnWfm") : $t("browse.tabOrders")}
                aria-label={item.orderPlaced ? $t("inventory.listedOnWfm") : $t("browse.tabOrders")}
                onclick={(event) => {
                  event.stopPropagation();
                  if (selectionMode) openRow(item, event);
                  else onSelect(item);
                }}
              >
                {#if item.orderPlaced}
                  <img src={NAV_ICON_URLS.market} alt="" class="h-3.5 w-3.5" />
                {:else}
                  <span aria-hidden="true">-</span>
                {/if}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if totalCount != null && items.length < totalCount}
      {#key items.length}
        <div class="h-px" use:observeMore aria-hidden="true"></div>
      {/key}
    {/if}
  {/if}
</div>

<style>
  /* Pins under the header band, whose measured height InventoryHeader publishes. */
  .inventory-list th {
    position: sticky;
    top: var(--inventory-sticky-height, 0px);
    z-index: 1;
  }
</style>
