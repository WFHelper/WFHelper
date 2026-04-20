<script lang="ts">
  import type { CraftingTreeNode } from "../lib/craftingTree.js";
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
  <div class="flex flex-col items-center px-1.5">
    <div
      class="node-card relative flex h-16 w-16 items-center justify-center rounded-[10px] border-2 {gotEnough ? 'border-[rgba(74,222,128,0.5)] bg-[rgba(74,222,128,0.12)]' : 'border-[rgba(255,255,255,0.15)] bg-[rgba(255,255,255,0.04)]'}"
    >
      {#if qtyLabel}
        <span class="node-qty absolute -left-1 -top-1.5 z-[2] rounded bg-bg-raised px-[3px] text-[0.6rem] font-bold leading-snug text-text-primary border border-border font-display">
          {qtyLabel}
        </span>
      {/if}
      {#if gotEnough}
        <span class="node-check absolute -bottom-1 -right-1 z-[2] flex h-[18px] w-[18px] items-center justify-center rounded-full bg-success text-bg-deep">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" class="h-3 w-3">
            <path d="M3 8.5l3.5 3.5 6.5-7" />
          </svg>
        </span>
      {/if}
      <ItemImage src={node.imageUrl} alt={node.name} cls="h-10 w-10 object-contain" />
    </div>
    <span
      class="mt-1 max-w-[80px] break-words text-center font-display text-[0.65rem] font-semibold leading-tight text-text-primary"
      class:opacity-40={gotEnough}
    >
      {node.name}
    </span>
  </div>

  <!-- Connector lines + children -->
  {#if node.children.length > 0}
    <!-- Vertical line down from parent -->
    <div class="mx-auto h-6 w-0.5 bg-white/[0.18]"></div>

    <!-- Children row -->
    <div class="flex items-start">
      {#each node.children as child, i (child.uniqueName)}
        {@const isFirst = i === 0}
        {@const isLast = i === node.children.length - 1}
        <div class="flex flex-col items-center">
          <!-- Connector: horizontal segment + vertical drop -->
          <div class="relative flex h-6 w-full">
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

