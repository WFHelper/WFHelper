<script lang="ts">
  import { createEventDispatcher } from "svelte";

  import InventoryCard from "./InventoryCard.svelte";
  import { tr } from "../../lib/i18n.js";
  import type { InventoryViewItem } from "../../lib/inventoryMarket.js";

  export let items: InventoryViewItem[] = [];
  export let showDucats = true;
  /** Internal names the detail modal can actually open; null = no gating. */
  export let detailKeys: Set<string> | null = null;
  /** Unsliced result count; null means `items` is already the complete list. */
  export let totalCount: number | null = null;
  export let selectionMode = false;
  /** Selected/eligible keys are Sets so a thousand-card page stays O(1) per card. */
  export let selectedKeys: ReadonlySet<string> | null = null;
  export let eligibleKeys: ReadonlySet<string> | null = null;

  const dispatch = createEventDispatcher<{
    select: InventoryViewItem;
    visible: InventoryViewItem;
    expand: InventoryViewItem;
    toggle: { item: InventoryViewItem; shiftKey: boolean };
    more: void;
  }>();

  // Fires once per sentinel node; the {#key} below remounts it after every
  // extension so a viewport taller than one page keeps filling.
  function observeMore(node: HTMLElement): { destroy: () => void } {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) dispatch("more");
      },
      { rootMargin: "600px" },
    );
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }

  function handleSelect(event: CustomEvent<InventoryViewItem>): void {
    dispatch("select", event.detail);
  }

  function handleExpand(event: CustomEvent<InventoryViewItem>): void {
    dispatch("expand", event.detail);
  }

  function handleVisible(event: CustomEvent<InventoryViewItem>): void {
    dispatch("visible", event.detail);
  }

  function handleToggle(event: CustomEvent<{ item: InventoryViewItem; shiftKey: boolean }>): void {
    dispatch("toggle", event.detail);
  }
</script>

<div class="item-grid">
  {#if items.length === 0}
    <div class="empty-state col-span-full">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <p>{$tr("inventory.noItemsFound")}</p>
    </div>
  {:else}
    {#each items as item (item.internalName)}
      <InventoryCard
        {item}
        {showDucats}
        {selectionMode}
        selected={selectedKeys?.has(item.internalName) ?? false}
        selectable={eligibleKeys?.has(item.internalName) ?? false}
        canExpand={!detailKeys || detailKeys.has(item.internalName)}
        on:select={handleSelect}
        on:visible={handleVisible}
        on:expand={handleExpand}
        on:toggle={handleToggle}
      />
    {/each}
    {#if totalCount != null && items.length < totalCount}
      {#key items.length}
        <div class="col-span-full h-px" use:observeMore aria-hidden="true"></div>
      {/key}
    {/if}
  {/if}
</div>
