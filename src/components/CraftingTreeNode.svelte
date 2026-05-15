<script lang="ts">
  import type { CraftingTreeNode } from "../lib/craftingTree.js";
  import { formatBuildTime } from "../lib/format.js";
  import ItemImage from "./ItemImage.svelte";

  export let node: CraftingTreeNode;

  $: gotEnough = node.owned >= node.count;
  $: qtyLabel =
    node.count >= 1000
      ? `${Math.round(node.count / 1000)}K`
      : node.count > 1
        ? `${node.count}x`
        : "";
</script>

<div class="tree-node flex flex-col items-center">
  <!-- Node card + label -->
  <div class="flex flex-col items-center px-1">
    <div
      class="node-card group/node relative flex h-16 w-16 items-center justify-center rounded-lg border-2 {gotEnough ? 'border-[rgba(74,222,128,0.5)] bg-[rgba(74,222,128,0.12)]' : 'border-[rgba(255,255,255,0.15)] bg-[rgba(255,255,255,0.04)]'}"
    >
      {#if qtyLabel}
        <span class="node-qty absolute -left-1 -top-1.5 z-[2] rounded bg-bg-raised px-[3px] text-xs font-bold leading-snug text-text-primary border border-border font-display">
          {qtyLabel}
        </span>
      {/if}
      {#if gotEnough}
        <span class="node-check absolute -bottom-0.5 -right-0.5 z-[2] flex h-[15px] w-[15px] items-center justify-center rounded-full bg-success text-bg-deep">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" class="h-2.5 w-2.5">
            <path d="M3 8.5l3.5 3.5 6.5-7" />
          </svg>
        </span>
      {/if}
      <ItemImage src={node.imageUrl} alt={node.name} cls="h-12 w-12 object-contain" />
      {#if node.recipe}
        <div class="node-tooltip pointer-events-none absolute -bottom-9 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-black/90 px-1.5 py-0.5 text-xs text-text-primary opacity-0 transition-opacity duration-100 group-hover/node:opacity-100">
          {#if node.recipe.buildPrice > 0}{node.recipe.buildPrice.toLocaleString()} cr{/if}
          {#if node.recipe.buildPrice > 0 && node.recipe.buildTime > 0} · {/if}
          {#if node.recipe.buildTime > 0}{formatBuildTime(node.recipe.buildTime)}{/if}
        </div>
      {/if}
    </div>
    <span
      class="mt-0.5 max-w-[90px] break-words text-center font-display text-xs font-semibold leading-tight text-text-primary"
      class:opacity-40={gotEnough}
    >
      {node.name}
    </span>
  </div>

  <!-- Connector lines + children -->
  {#if node.children.length > 0}
    <!-- Vertical line down from parent -->
    <div class="mx-auto h-4 w-0.5 bg-white/[0.18]"></div>

    <!-- Children row -->
    <div class="flex items-start">
      {#each node.children as child, i (child.uniqueName)}
        {@const isFirst = i === 0}
        {@const isLast = i === node.children.length - 1}
        <div class="flex flex-col items-center">
          <!-- Connector: horizontal segment + vertical drop -->
          <div class="relative flex h-4 w-full">
            <!-- Left half of horizontal connector -->
            <div class="h-0 flex-1 {!isFirst ? 'border-t-2 border-white/[0.18]' : ''}"></div>
            <!-- Center vertical line -->
            <div class="h-full w-0.5 shrink-0 bg-white/[0.18]"></div>
            <!-- Right half of horizontal connector -->
            <div class="h-0 flex-1 {!isLast ? 'border-t-2 border-white/[0.18]' : ''}"></div>
          </div>
          <svelte:self node={child} />
        </div>
      {/each}
    </div>
  {/if}
</div>

