<script lang="ts">
  import { onDestroy, tick } from "svelte";

  import type { CraftingTreeNode } from "../lib/craftingTree.js";
  import { computeCraftingSummary } from "../lib/craftingTree.js";
  import { formatBuildTime } from "../lib/format.js";
  import { CREDITS_ICON_URL } from "../lib/assetUrls.js";
  import CraftingTreeNodeCard from "./CraftingTreeNode.svelte";
  import ItemImage from "./ItemImage.svelte";

  export let tree: CraftingTreeNode;
  export let onOpenItem: ((uniqueName: string) => void) | null = null;

  let hideCompleted = false;
  let hideBlueprints = false;
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panEl: HTMLDivElement;
  let zoomEl: HTMLDivElement;
  let canvasEl: HTMLDivElement;
  let panFrame = 0;

  $: summary = computeCraftingSummary(tree);

  $: visibleTree = applyTreeFilters(tree, hideCompleted, hideBlueprints);
  $: usedFor = tree.usedFor || [];

  // Wide trees (necramechs) start unreadably cropped at 100%; fit whenever the
  // tree footprint changes.
  $: if (visibleTree) void refitAfterRender(visibleTree);

  $: missingBlueprints = summary.blueprints.filter((b) => b.owned < b.count);
  $: missingResources = summary.resources.filter((r) => r.owned < r.count);

  $: creditsLabel =
    summary.totalCredits >= 1000
      ? `${Math.round(summary.totalCredits / 1000)}K`
      : String(summary.totalCredits);

  function applyTreeFilters(
    root: CraftingTreeNode,
    dropCompleted: boolean,
    dropBlueprints: boolean,
  ): CraftingTreeNode | null {
    let result: CraftingTreeNode | null = dropBlueprints ? stripBlueprints(root) : root;
    if (dropCompleted && result) result = filterCompleted(result, result);
    return result;
  }

  function stripBlueprints(node: CraftingTreeNode): CraftingTreeNode {
    return {
      ...node,
      children: node.children.filter((c) => !c.isBlueprintItem).map(stripBlueprints),
    };
  }

  function filterCompleted(
    node: CraftingTreeNode,
    root: CraftingTreeNode,
  ): CraftingTreeNode | null {
    if (node.owned >= node.count && node.children.length === 0) return null;
    const children = node.children
      .map((c) => filterCompleted(c, root))
      .filter((c): c is CraftingTreeNode => c !== null);
    // Keep root even if owned (always show the top item)
    if (node === root) return { ...node, children };
    if (node.owned >= node.count && children.length === 0) return null;
    return { ...node, children };
  }

  function fitToView(): void {
    if (!canvasEl || !zoomEl) return;
    const cw = canvasEl.clientWidth;
    const ch = canvasEl.clientHeight;
    const tw = zoomEl.offsetWidth;
    const th = zoomEl.offsetHeight;
    if (!cw || !ch || !tw || !th) return;
    scale = Math.max(0.15, Math.min(1, cw / tw, ch / th));
    panX = Math.max(0, (cw - tw * scale) / 2);
    panY = 0;
    applyZoom();
    applyPan();
  }

  async function refitAfterRender(_tree: CraftingTreeNode): Promise<void> {
    await tick();
    fitToView();
  }

  function applyZoom() {
    if (zoomEl) {
      zoomEl.style.zoom = String(scale);
    }
  }

  function applyPan() {
    if (panEl) {
      panEl.style.transform = `translate(${panX}px, ${panY}px)`;
    }
  }

  function schedulePan() {
    if (panFrame) return;
    panFrame = requestAnimationFrame(() => {
      panFrame = 0;
      applyPan();
    });
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    scale = Math.max(0.15, Math.min(3, scale * factor));
    applyZoom();
  }

  function handlePointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    isPanning = true;
    panStartX = e.clientX - panX;
    panStartY = e.clientY - panY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    if (!isPanning) return;
    panX = e.clientX - panStartX;
    panY = e.clientY - panStartY;
    schedulePan();
  }

  function handlePointerUp() {
    isPanning = false;
  }

  function resetView() {
    fitToView();
  }

  function openUsedFor(uniqueName: string) {
    onOpenItem?.(uniqueName);
  }

  onDestroy(() => {
    if (panFrame) {
      cancelAnimationFrame(panFrame);
      panFrame = 0;
    }
  });
</script>

<div class="flex flex-col h-full min-h-0">
  <!-- Toolbar -->
  <div class="flex items-center justify-between px-2 py-1.5 border-b border-white/[0.08] shrink-0">
    <div class="flex items-center gap-4">
      <label class="flex items-center gap-2 text-xs text-text-secondary cursor-pointer select-none">
        Hide completed:
        <button
          type="button"
          class="relative inline-block w-9 h-[18px] rounded-full transition-colors duration-150 {hideCompleted
            ? 'bg-accent'
            : 'bg-white/[0.15]'}"
          on:click={() => (hideCompleted = !hideCompleted)}
          aria-pressed={hideCompleted}
          aria-label="Hide completed"
        >
          <span
            class="absolute top-[2px] left-[2px] h-3.5 w-3.5 rounded-full bg-white transition-transform duration-150 {hideCompleted
              ? 'translate-x-[18px]'
              : ''}"
          ></span>
        </button>
      </label>
      <label class="flex items-center gap-2 text-xs text-text-secondary cursor-pointer select-none">
        Hide blueprints:
        <button
          type="button"
          class="relative inline-block w-9 h-[18px] rounded-full transition-colors duration-150 {hideBlueprints
            ? 'bg-accent'
            : 'bg-white/[0.15]'}"
          on:click={() => (hideBlueprints = !hideBlueprints)}
          aria-pressed={hideBlueprints}
          aria-label="Hide blueprints"
        >
          <span
            class="absolute top-[2px] left-[2px] h-3.5 w-3.5 rounded-full bg-white transition-transform duration-150 {hideBlueprints
              ? 'translate-x-[18px]'
              : ''}"
          ></span>
        </button>
      </label>
    </div>
    <div class="flex items-center gap-1.5">
      <button
        class="rounded px-1.5 py-0.5 text-xs text-text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-text-primary"
        on:click={resetView}
        title="Fit to view">↺</button
      >
      <span class="w-10 text-center text-xs tabular-nums text-text-muted"
        >{Math.round(scale * 100)}%</span
      >
    </div>
  </div>

  <!-- Zoomable / pannable canvas -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    bind:this={canvasEl}
    class="flex-1 min-h-0 overflow-hidden relative select-none touch-none cursor-grab {isPanning
      ? 'cursor-grabbing'
      : ''}"
    on:wheel|preventDefault={handleWheel}
    on:pointerdown={handlePointerDown}
    on:pointermove={handlePointerMove}
    on:pointerup={handlePointerUp}
    on:pointercancel={handlePointerUp}
  >
    <div
      bind:this={panEl}
      class="inline-flex will-change-transform"
      style="transform: translate({panX}px, {panY}px)"
    >
      <div
        bind:this={zoomEl}
        class="inline-flex flex-col items-center gap-8 p-8 origin-top-left"
        style="zoom: {scale}"
      >
        {#if usedFor.length > 0}
          <div class="flex flex-col items-center gap-2">
            <span
              class="font-display text-xs font-semibold uppercase tracking-[0.08em] text-text-secondary"
            >
              Used for crafting:
            </span>
            <div class="flex flex-wrap items-start justify-center gap-3 max-w-[680px]">
              {#each usedFor as usage (usage.uniqueName)}
                <button
                  type="button"
                  class="flex w-16 cursor-pointer flex-col items-center gap-1 rounded-lg border border-border bg-bg-raised/80 px-3 py-2 text-inherit transition-colors duration-150 hover:border-accent-dim hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  title="Open {usage.name}"
                  on:pointerdown|stopPropagation
                  on:click={() => openUsedFor(usage.uniqueName)}
                >
                  <ItemImage src={usage.imageUrl} alt={usage.name} cls="h-14 w-14 object-contain" />
                  <span
                    class="max-w-full break-words text-center font-display text-xs font-semibold leading-tight text-text-primary"
                  >
                    {usage.name}
                  </span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
        {#if visibleTree}
          <CraftingTreeNodeCard node={visibleTree} />
        {/if}
      </div>
    </div>
  </div>

  <!-- Summary panel -->
  <div class="shrink-0 border-t border-white/[0.08] px-3 py-2 text-xs">
    <div class="grid gap-x-6 gap-y-1" style="grid-template-columns: 1fr auto;">
      <div class="max-h-36 overflow-y-auto pr-1">
        <div class="font-display font-semibold text-text-secondary uppercase tracking-wider mb-0.5">
          Blueprints needed:
        </div>
        {#if missingBlueprints.length === 0}
          <span class="text-success">No blueprints missing</span>
        {:else}
          {#each missingBlueprints as bp (bp.uniqueName)}
            <div class="text-text-muted">{bp.name} ({bp.owned}/{bp.count})</div>
          {/each}
        {/if}
        <div
          class="font-display font-semibold text-text-secondary uppercase tracking-wider mt-1.5 mb-0.5"
        >
          Resources needed:
        </div>
        {#if missingResources.length === 0}
          <span class="text-success">No resources missing</span>
        {:else}
          {#each missingResources as res (res.uniqueName)}
            <div class="text-text-muted">{res.name} ({res.owned}/{res.count})</div>
          {/each}
        {/if}
      </div>
      <div class="flex flex-col items-end justify-end">
        <div class="px-3 py-1.5 text-xs text-text-secondary">
          <div class="flex items-center gap-1">
            Total <img src={CREDITS_ICON_URL} alt="credits" class="h-4 w-4 inline-block" />:
            <strong class="text-text-primary">{creditsLabel}</strong>
          </div>
          <div>
            Min. time: <strong class="text-text-primary"
              >{formatBuildTime(summary.minBuildTime)}</strong
            >
          </div>
          <div>
            Max. time: <strong class="text-text-primary"
              >{formatBuildTime(summary.maxBuildTime)}</strong
            >
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
