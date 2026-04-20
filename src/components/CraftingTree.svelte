<script lang="ts">
  import type { CraftingTreeNode } from "../lib/craftingTree.js";
  import { formatBuildTime } from "../lib/craftingTree.js";
  import ItemImage from "./ItemImage.svelte";

  export let node: CraftingTreeNode;
  export let depth: number = 0;

  let expanded = depth < 2;

  function toggle() {
    expanded = !expanded;
  }

  $: hasChildren = node.children.length > 0;
  $: gotEnough = node.owned >= node.count;
</script>

<div class="text-[0.85rem]" class:text-[0.9rem]={depth === 0}>
  <button
    type="button"
    class="flex w-full items-center gap-1.5 rounded border-none bg-transparent px-1.5 py-0.5 text-left text-text-primary transition-colors duration-150 hover:enabled:cursor-pointer hover:enabled:bg-surface-hover disabled:cursor-default"
    class:has-enough={gotEnough}
    class:is-craftable={node.isCraftable && !gotEnough}
    on:click={toggle}
    disabled={!hasChildren}
  >
    <span class="shrink-0" style="width: {depth * 20}px"></span>

    {#if hasChildren}
      <span class="shrink-0 w-3.5 text-xs text-text-muted transition-transform duration-150" class:rotate-90={expanded}>&#9656;</span>
    {:else}
      <span class="shrink-0 w-3.5"></span>
    {/if}

    <span class="shrink-0 h-[22px] w-[22px]">
      <ItemImage src={node.imageUrl} alt={node.name} cls="h-[22px] w-[22px]" />
    </span>

    <span class="min-w-0 flex-1 truncate" class:opacity-50={gotEnough}>{node.name}</span>

    <span class="shrink-0 text-[0.8rem] font-semibold tabular-nums" class:text-text-muted={!gotEnough} class:text-grade-s={gotEnough}>
      {node.owned}/{node.count}
    </span>

    {#if node.recipe}
      <span class="shrink-0 text-[0.7rem] text-text-muted opacity-70">
        {formatBuildTime(node.recipe.buildTime)}
        {#if node.recipe.buildPrice > 0}
          · {node.recipe.buildPrice.toLocaleString()} cr
        {/if}
      </span>
    {/if}
  </button>

  {#if hasChildren && expanded}
    <div class="ml-4 border-l border-white/[0.08]">
      {#each node.children as child (child.uniqueName)}
        <svelte:self node={child} depth={depth + 1} />
      {/each}
    </div>
  {/if}
</div>

