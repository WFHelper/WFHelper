<script lang="ts">
  import { itemLabel } from "../lib/itemLabel.js";
  import type { CraftingTreeFilters, CraftingTreeNode } from "../lib/craftingTree.js";
  import {
    MAX_EXPAND_DEPTH,
    canExpandCraftingNode,
    expandCraftingNode,
    expandedChildAncestors,
    filterExpandedChildren,
  } from "../lib/craftingTree.js";
  import { resolveComponentByUniqueName } from "../lib/componentResolution.js";
  import { formatBuildTime, formatNumber } from "../lib/format.js";
  import { itemDb, componentOwnership } from "../stores/data.js";
  import { activeComponent } from "../stores/modals.js";
  import { tr } from "../lib/i18n.js";
  import ItemImage from "./ItemImage.svelte";

  export let node: CraftingTreeNode;
  /** uniqueName path above this node, root first. Guards expansion against loops. */
  export let ancestors: string[] = [];
  /** Lazily expanded levels between this node and the eagerly built tree. */
  export let expandDepth = 0;
  /** Name -> uniqueName index, built once by the tree so leaf clicks stay cheap. */
  export let nameIndex: Map<string, string> = new Map();
  /** Toolbar filters, applied to expanded children the tree filter never saw. */
  export let filters: CraftingTreeFilters = { hideCompleted: false, hideBlueprints: false };
  /** Same "open the recipe" callback the "Used for crafting" cards fire. */
  export let onOpenItem: ((uniqueName: string) => void) | null = null;
  /** Fired after an expand/collapse changes the tree footprint. */
  export let onLayoutChange: (() => void) | null = null;

  let expanded = false;
  let expandedFor = "";

  $: db = $itemDb || {};
  $: gotEnough = node.owned >= node.count;
  $: qtyLabel =
    node.count >= 1000 ? formatNumber(node.count) : node.count > 1 ? `${node.count}x` : "";

  $: hasBuiltChildren = node.children.length > 0;
  $: childAncestors = expandedChildAncestors(node, db, ancestors);
  $: canExpand = !hasBuiltChildren && canExpandCraftingNode(node, db, ancestors);
  // At the cap the sub-recipe is still reachable, just in its own modal.
  $: atExpandCap = canExpand && expandDepth >= MAX_EXPAND_DEPTH;
  $: canOpenComponent = !hasBuiltChildren && !canExpand && Boolean(db[node.uniqueName]?.name);
  $: interactive = (canExpand && !atExpandCap) || (atExpandCap && !!onOpenItem) || canOpenComponent;
  $: cardTitle = !interactive
    ? undefined
    : atExpandCap
      ? $tr("common.open", { name: itemLabel(node) })
      : canExpand
        ? expanded
          ? $tr("crafting.collapseRecipe")
          : $tr("crafting.expandRecipe")
        : $tr("common.openDetailsFor", { name: itemLabel(node) });

  // Collapse when the card is reused for a different item.
  $: if (node.uniqueName !== expandedFor) {
    // eslint-disable-next-line no-useless-assignment -- guard: persists between reactive runs
    expandedFor = node.uniqueName;
    expanded = false;
  }

  // Nothing resolves until the user opens the node; ownership edits stay live after.
  $: expandedChildren =
    expanded && canExpand
      ? filterExpandedChildren(
          expandCraftingNode(node, db, $componentOwnership, ancestors),
          filters,
        )
      : [];
  $: shownChildren = hasBuiltChildren ? node.children : expandedChildren;

  function onCardClick(): void {
    if (atExpandCap) {
      onOpenItem?.(node.uniqueName);
      return;
    }
    if (canExpand) {
      expanded = !expanded;
      onLayoutChange?.();
      return;
    }
    if (!canOpenComponent) return;
    // The node carries its own uniqueName, so a display name shared with another
    // entry cannot send the panel to the wrong component.
    const resolved = resolveComponentByUniqueName(node.uniqueName, db, $componentOwnership);
    if (resolved) activeComponent.set(resolved);
  }
</script>

<div class="tree-node flex flex-col items-center">
  <!-- Node card + label -->
  <div class="flex flex-col items-center px-1">
    <button
      type="button"
      disabled={!interactive}
      aria-expanded={canExpand && !atExpandCap ? expanded : undefined}
      title={cardTitle}
      class="node-card group/node relative flex h-16 w-16 items-center justify-center rounded-lg border-2 p-0 text-inherit transition-colors duration-150 enabled:cursor-pointer enabled:hover:border-accent-dim enabled:hover:bg-surface-hover disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent {gotEnough
        ? 'border-success/50 bg-success/10'
        : 'border-border-subtle bg-surface-hover'}"
      on:pointerdown|stopPropagation
      on:click={onCardClick}
    >
      {#if qtyLabel}
        <span
          class="node-qty absolute -left-1 -top-1.5 z-[2] rounded bg-bg-raised px-[3px] text-xs font-bold leading-snug text-text-primary border border-border font-display"
        >
          {qtyLabel}
        </span>
      {/if}
      {#if gotEnough}
        <span
          class="node-check absolute -bottom-0.5 -right-0.5 z-[2] flex h-[15px] w-[15px] items-center justify-center rounded-full bg-success text-bg-deep"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            class="h-2.5 w-2.5"
          >
            <path d="M3 8.5l3.5 3.5 6.5-7" />
          </svg>
        </span>
      {/if}
      <ItemImage src={node.imageUrl} alt={itemLabel(node)} cls="h-12 w-12 object-contain" />
      {#if canExpand && interactive}
        <span
          class="node-expand absolute -bottom-2 left-1/2 z-[2] flex h-4 w-4 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-bg-raised text-text-secondary"
          class:rotate-180={expanded && !atExpandCap}
        >
          {#if atExpandCap}
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              class="h-2.5 w-2.5"
              aria-hidden="true"
            >
              <path d="M6.5 3H3v10h10V9.5" />
              <path d="M9 3h4v4M13 3L7.5 8.5" />
            </svg>
          {:else}
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="h-2.5 w-2.5"
              aria-hidden="true"
            >
              <path d="M4 6l4 4 4-4" />
            </svg>
          {/if}
        </span>
      {/if}
      {#if node.recipe}
        <div
          class="node-tooltip pointer-events-none absolute -bottom-9 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-surface-tooltip px-1.5 py-0.5 text-xs text-text-primary opacity-0 transition-opacity duration-100 group-hover/node:opacity-100"
        >
          {#if node.recipe.buildPrice > 0}{node.recipe.buildPrice.toLocaleString()} cr{/if}
          {#if node.recipe.buildPrice > 0 && node.recipe.buildTime > 0}
            ·
          {/if}
          {#if node.recipe.buildTime > 0}{formatBuildTime(node.recipe.buildTime)}{/if}
        </div>
      {/if}
    </button>
    <span
      class="mt-0.5 max-w-[90px] break-words text-center font-display text-xs font-semibold leading-tight text-text-primary"
      class:opacity-40={gotEnough}
    >
      {itemLabel(node)}
    </span>
  </div>

  <!-- Connector lines + children -->
  {#if shownChildren.length > 0}
    <!-- Vertical line down from parent -->
    <div class="mx-auto h-4 w-0.5 bg-border-subtle"></div>

    <!-- Children row -->
    <div class="flex items-start">
      {#each shownChildren as child, i (child.uniqueName)}
        {@const isFirst = i === 0}
        {@const isLast = i === shownChildren.length - 1}
        <div class="flex flex-col items-center">
          <!-- Connector: horizontal segment + vertical drop -->
          <div class="relative flex h-4 w-full">
            <!-- Left half of horizontal connector -->
            <div class="h-0 flex-1 {!isFirst ? 'border-t-2 border-border-subtle' : ''}"></div>
            <!-- Center vertical line -->
            <div class="h-full w-0.5 shrink-0 bg-border-subtle"></div>
            <!-- Right half of horizontal connector -->
            <div class="h-0 flex-1 {!isLast ? 'border-t-2 border-border-subtle' : ''}"></div>
          </div>
          <svelte:self
            node={child}
            ancestors={childAncestors}
            expandDepth={hasBuiltChildren ? expandDepth : expandDepth + 1}
            {nameIndex}
            {filters}
            {onOpenItem}
            {onLayoutChange}
          />
        </div>
      {/each}
    </div>
  {/if}
</div>
