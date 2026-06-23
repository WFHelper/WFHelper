<script lang="ts">
  import { activeItem } from "../stores/modals.js";
  import { itemDb, wfmItems, componentOwnership } from "../stores/data.js";
  import { createPriceLoader } from "../lib/priceState.js";
  import { resolveItemPriceLookup } from "../lib/componentResolution.js";
  import { buildCraftingTree } from "../lib/craftingTree.js";
  import { buildParsedItemFromDb } from "../lib/parsedItemFromDb.js";
  import ItemImage from "../components/ItemImage.svelte";
  import DropsList from "../components/DropsList.svelte";
  import MarketPrice from "../components/MarketPrice.svelte";
  import WikiButton from "../components/WikiButton.svelte";
  import DetailModalBase from "./DetailModalBase.svelte";
  import ComponentPanel from "../components/ComponentPanel.svelte";
  import CraftingTree from "../components/CraftingTree.svelte";
  import type { ComponentInfo, ParsedItem } from "../types/inventory.js";

  let priceText = "";
  let priceSlug: string | null = null;
  const priceLoader = createPriceLoader((state) => {
    priceText = state.text;
    priceSlug = state.slug;
  });

  // Inline component panel state
  let selectedComp: ComponentInfo | null = null;
  let showCraftingTree = false;
  let lastItemKey = "";
  let pendingShowCraftingTree: boolean | null = null;
  let internalNavigation = false;
  let navigationStack: Array<{ item: ParsedItem; showCraftingTree: boolean }> = [];

  $: item = $activeItem;

  $: itemKey = item?.uniqueName || item?.internalName || "";
  $: dbEntry = itemKey ? ($itemDb || {})[itemKey] : null;
  $: hasCraftingTree = !!dbEntry?.recipe;
  $: craftingTree = hasCraftingTree && showCraftingTree
    ? buildCraftingTree(itemKey, $itemDb || {}, $componentOwnership)
    : null;

  // Reset selected component when the active item changes.
  $: if (item && itemKey !== lastItemKey) {
    if (!internalNavigation) {
      navigationStack = [];
    }
    selectedComp = null;
    showCraftingTree = pendingShowCraftingTree ?? false;
    // eslint-disable-next-line no-useless-assignment -- persists between reactive runs
    pendingShowCraftingTree = null;
    // eslint-disable-next-line no-useless-assignment -- persists between reactive runs
    internalNavigation = false;
    // eslint-disable-next-line no-useless-assignment -- persists between reactive runs
    lastItemKey = itemKey;
    loadPrice();
  }

  async function loadPrice(): Promise<void> {
    if (!item) return;
    const lookup = $wfmItems || {};
    const plan = resolveItemPriceLookup(item, lookup);
    await priceLoader.load(plan.name, lookup, plan.isTradable);
  }

  function selectComponent(comp: ComponentInfo) {
    if (selectedComp === comp) {
      selectedComp = null;
      return;
    }
    selectedComp = comp;
  }

  function close() {
    priceLoader.clear();
    selectedComp = null;
    lastItemKey = "";
    navigationStack = [];
    pendingShowCraftingTree = null;
    internalNavigation = false;
    activeItem.set(null);
  }

  function closeCompPanel() {
    selectedComp = null;
  }

  function onModalClose() {
    // Escape / backdrop: close inline panel first, then tree, then full close.
    if (selectedComp) closeCompPanel();
    else if (showCraftingTree) showCraftingTree = false;
    else close();
  }

  function openCraftingTreeItem(uniqueName: string) {
    if (!item) return;
    const db = $itemDb[uniqueName];
    if (!db) return;

    navigationStack = [...navigationStack, { item, showCraftingTree }];
    pendingShowCraftingTree = !!db.recipe;
    internalNavigation = true;
    activeItem.set(buildParsedItemFromDb(uniqueName, db, $componentOwnership));
  }

  function goBack() {
    const previous = navigationStack[navigationStack.length - 1];
    if (!previous) return;

    navigationStack = navigationStack.slice(0, -1);
    pendingShowCraftingTree = previous.showCraftingTree;
    internalNavigation = true;
    activeItem.set(previous.item);
  }
</script>

{#if item}
  <DetailModalBase
    ariaLabel={item.name}
    onClose={onModalClose}
    sideState={selectedComp ? "component" : "none"}
    panelClass={showCraftingTree ? "w-[90vw] max-w-[1100px]" : ""}
  >
        <div class="detail-panel-top-actions">
          {#if navigationStack.length > 0}
            <button
              type="button"
              class="rounded border border-border-subtle bg-transparent px-2.5 py-0.5 text-xs text-text-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-text-primary"
              on:click={goBack}
            >
              ← Back
            </button>
          {/if}
          {#if hasCraftingTree}
            <button
              type="button"
              class="rounded border border-border-subtle bg-transparent px-2.5 py-0.5 text-xs text-text-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-text-primary data-[active]:bg-surface-hover data-[active]:text-accent data-[active]:border-accent"
              data-active={showCraftingTree || undefined}
              on:click={() => { showCraftingTree = !showCraftingTree; }}
            >
              {showCraftingTree ? '← Details' : 'Crafting Tree'}
            </button>
          {/if}
          <WikiButton wikiUrl={item.wikiaUrl} fallbackName={item.name} />
          <button class="detail-close" aria-label="Close" on:click={close}>&times;</button>
        </div>

        {#if showCraftingTree && craftingTree}
          <!-- Crafting tree mode: compact header + full tree -->
          <div class="flex items-center gap-3 px-4 py-2 border-b border-white/[0.06]">
            <div class="shrink-0 h-10 w-10">
              <ItemImage src={item.imageUrl} alt={item.name} cls="h-10 w-10 object-contain" />
            </div>
            <div>
              <h2 class="m-0 font-display text-base font-bold text-text-primary">{item.name}</h2>
              <span class="text-xs text-text-muted">Crafting Tree</span>
            </div>
          </div>

          <div class="h-[60vh] min-h-[300px] flex flex-col">
            <CraftingTree tree={craftingTree} onOpenItem={openCraftingTreeItem} />
          </div>
        {:else}
          <!-- Normal detail mode -->
          <div class="detail-header">
            <div class="detail-img-wrap">
              <ItemImage src={item.imageUrl} alt={item.name} cls="item-img" />
            </div>
            <div class="detail-title-area">
              <h2>{item.name}</h2>
              <div class="detail-tags">
                {#if item.isPrime}<span class="detail-tag prime">PRIME</span>{/if}
                {#if item.vaulted}<span class="detail-tag vaulted">VAULTED</span>{/if}
                {#if item.status === 'mastered'}<span class="detail-tag mastered">MASTERED</span>{/if}
                {#if item.status === 'progress'}<span class="detail-tag progress">IN PROGRESS</span>{/if}
                {#if item.status === 'missing'}<span class="detail-tag missing">MISSING</span>{/if}
                {#if item.categoryLabel || item.category}
                  <span class="detail-meta-inline">{item.categoryLabel || item.category}</span>
                {/if}
              </div>
              {#if item.description}
                <div class="detail-desc detail-desc-header">{item.description}</div>
              {/if}
            </div>
          </div>

          <div class="detail-body">
            {#if (item.components || []).length > 0}
              <div class="detail-section">
                <h3>Components</h3>
                <div class="detail-components">
                  {#each item.components as comp}
                  {@const ownedCount = comp.ownedCount ?? 0}
                  {@const needed = comp.itemCount || 1}
                  {@const countClass = ownedCount >= needed ? 'text-success' : ownedCount > 0 ? 'text-warning' : 'text-danger'}
                  <button
                    type="button"
                    class="-mx-1 flex w-full cursor-pointer appearance-none items-center justify-between gap-2 border-0 border-b border-dashed border-white/[0.08] bg-transparent px-1 py-1.5 text-left font-inherit text-inherit last:border-b-0 hover:rounded-[var(--radius-sm)] hover:bg-white/[0.06] hover:text-text-primary {selectedComp === comp ? 'rounded-[var(--radius-sm)] bg-white/10' : ''}"
                    aria-pressed={selectedComp === comp}
                    on:click={() => selectComponent(comp)}
                  >
                    <span class="comp-name">{comp.name || 'Unknown'}</span>
                    <span class="comp-count {countClass}">{ownedCount}/{needed}</span>
                  </button>
                {/each}
              </div>
              </div>
            {/if}

            <DropsList drops={item.drops || []} />

            <MarketPrice text={priceText} slug={priceSlug} />

          </div>
        {/if}

      <svelte:fragment slot="sidePanel">
        {#if selectedComp && !showCraftingTree}
          <ComponentPanel
            comp={selectedComp}
            parentName={item.name}
            panelClass="comp-inline-panel"
            onClose={closeCompPanel}
          />
        {/if}
      </svelte:fragment>
  </DetailModalBase>
{/if}

