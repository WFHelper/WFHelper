<script lang="ts">
  import { activeItem } from "../stores/modals.js";
  import { itemDb, wfmItems, componentOwnership } from "../stores/data.js";
  import { loadItemPrice } from "../lib/priceLoader.js";
  import { buildCraftingTree } from "../lib/craftingTree.js";
  import ItemImage from "../components/ItemImage.svelte";
  import DropsList from "../components/DropsList.svelte";
  import MarketPrice from "../components/MarketPrice.svelte";
  import WikiButton from "../components/WikiButton.svelte";
  import ModalShell from "../components/ModalShell.svelte";
  import ComponentPanel from "../components/ComponentPanel.svelte";
  import CraftingTree from "../components/CraftingTree.svelte";
  import type { ComponentInfo } from "../types/inventory.js";

  let priceText = "";
  let priceSlug: string | null = null;
  // Stale-response guard: see ComponentPanel priceToken comment.
  let priceToken = 0;

  // Inline component panel state
  let selectedComp: ComponentInfo | null = null;
  let showCraftingTree = false;

  $: item = $activeItem;

  // Build crafting tree reactively when item changes
  $: itemKey = item?.uniqueName || item?.internalName || "";
  $: dbEntry = itemKey ? ($itemDb || {})[itemKey] : null;
  $: hasCraftingTree = !!dbEntry?.recipe;
  $: craftingTree = hasCraftingTree && showCraftingTree
    ? buildCraftingTree(itemKey, $itemDb || {}, $componentOwnership)
    : null;

  // Reset selected component when item changes
  $: if (item) {
    selectedComp = null;
    showCraftingTree = false;
    loadPrice(item.name);
  }

  async function loadPrice(name: string): Promise<void> {
    const token = ++priceToken;
    priceText = 'Loading price…';
    priceSlug = null;
    const isTradable = item?.tradable || item?.isPrime ||
      !!(($wfmItems || {})[name?.toLowerCase()]) ||
      !!(($wfmItems || {})[`${name} Set`.toLowerCase()]);
    const result = await loadItemPrice(name, $wfmItems || {}, isTradable);
    if (token !== priceToken) return; // user switched items; discard stale result
    priceText = result.text;
    priceSlug = result.slug;
  }

  function selectComponent(comp: ComponentInfo) {
    if (selectedComp === comp) {
      selectedComp = null;
      return;
    }
    selectedComp = comp;
  }

  function close() {
    // Bump token so an in-flight price fetch discards its result rather than
    // briefly flashing on the modal when it reopens.
    priceToken++;
    selectedComp = null;
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
</script>

{#if item}
  <ModalShell ariaLabel={item.name} onClose={onModalClose}>
    <div class="detail-dual-container" class:has-comp={selectedComp}>
      <div class="detail-panel {showCraftingTree ? 'w-[90vw] max-w-[1100px]' : ''}">
        <div class="detail-panel-top-actions">
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
              <span class="text-[0.72rem] text-text-muted">Crafting Tree</span>
            </div>
          </div>

          <div class="h-[60vh] min-h-[300px] flex flex-col">
            <CraftingTree tree={craftingTree} />
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
                  {@const stateClass = ownedCount >= needed ? 'owned' : ownedCount > 0 ? 'partial' : 'not-owned'}
                  {@const countClass = ownedCount >= needed ? 'has-enough' : ownedCount > 0 ? 'has-some' : 'has-none'}
                  <button
                    type="button"
                    class="detail-comp-row {stateClass}"
                    class:active={selectedComp === comp}
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
      </div>

      {#if selectedComp && !showCraftingTree}
        <ComponentPanel
          comp={selectedComp}
          parentName={item.name}
          panelClass="comp-inline-panel"
          onClose={closeCompPanel}
        />
      {/if}
    </div>
  </ModalShell>
{/if}

