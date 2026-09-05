<script lang="ts">
  import { itemLabel } from "../lib/itemLabel.js";
  import { activeItem } from "../stores/modals.js";
  import { itemDb, wfmItems, componentOwnership, inventoryData } from "../stores/data.js";
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
  import ArchonShardPips from "../components/archon/ArchonShardPips.svelte";
  import PetGenetics from "../components/inventory/PetGenetics.svelte";
  import {
    archonShardColorKey,
    archonShardDisplaySlots,
    archonShardUpgradeLabel,
  } from "../lib/inventory/archonShards.js";
  import { archonShardsBySuit } from "../stores/archonShards.js";
  import { parsePetGenetics } from "../lib/inventory/petGenetics.js";
  import { locale, tr, type MessageKey } from "../lib/i18n.js";
  import type { ComponentInfo, ParsedItem } from "../types/inventory.js";

  let priceKey: MessageKey | null = null;
  let priceParams: Record<string, string | number> | undefined;
  let priceSlug: string | null = null;
  const priceLoader = createPriceLoader((state) => {
    priceKey = state.messageKey;
    priceParams = state.messageParams;
    priceSlug = state.slug;
  });

  $: priceText = priceKey ? $tr(priceKey, priceParams) : "";

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
  $: parentUniqueName = dbEntry?.isBuildComponent ? dbEntry.componentOf || null : null;
  $: parentEntry = parentUniqueName ? ($itemDb || {})[parentUniqueName] || null : null;
  // Blueprints have no recipe; root the tree at the product they build.
  $: treeRootKey = dbEntry?.recipe
    ? itemKey
    : dbEntry?.buildsProduct && ($itemDb || {})[dbEntry.buildsProduct]?.recipe
      ? dbEntry.buildsProduct
      : null;
  $: hasCraftingTree = !!treeRootKey;
  // Only Warframes carry sockets, so an empty result also means "not a frame".
  $: shardCopies = itemKey ? ($archonShardsBySuit.get(itemKey) ?? []) : [];
  // Both maps key off the species PowerSuit, which is the companion row's key.
  $: petGenetics = parsePetGenetics($inventoryData);
  $: petSpecies = itemKey ? (petGenetics.bySpecies.get(itemKey) ?? []) : [];
  $: petPrints = itemKey ? (petGenetics.printsBySpecies.get(itemKey) ?? []) : [];
  $: craftingTree =
    treeRootKey && showCraftingTree
      ? buildCraftingTree(treeRootKey, $itemDb || {}, $componentOwnership)
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
    await priceLoader.load(plan.name, lookup, plan.isTradable, {
      preferredSlug: typeof item.marketSlug === "string" ? item.marketSlug : null,
    });
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

  function openParentItem() {
    if (!item || !parentUniqueName || !parentEntry) return;
    navigationStack = [...navigationStack, { item, showCraftingTree }];
    internalNavigation = true;
    activeItem.set(buildParsedItemFromDb(parentUniqueName, parentEntry, $componentOwnership));
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
    ariaLabel={itemLabel(item)}
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
          {$tr("detail.back")}
        </button>
      {/if}
      {#if hasCraftingTree}
        <button
          type="button"
          class="rounded border border-border-subtle bg-transparent px-2.5 py-0.5 text-xs text-text-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-text-primary data-[active]:bg-surface-hover data-[active]:text-accent data-[active]:border-accent"
          data-active={showCraftingTree || undefined}
          on:click={() => {
            showCraftingTree = !showCraftingTree;
          }}
        >
          {showCraftingTree ? $tr("detail.backToDetails") : $tr("detail.craftingTree")}
        </button>
      {/if}
      <WikiButton wikiUrl={item.wikiaUrl} fallbackName={item.name} />
      <button class="detail-close" aria-label={$tr("common.close")} on:click={close}>&times;</button
      >
    </div>

    {#if showCraftingTree && craftingTree}
      <!-- Crafting tree mode: compact header + full tree -->
      <div class="flex items-center gap-3 px-4 py-2 border-b border-border-subtle">
        <div class="shrink-0 h-10 w-10">
          <ItemImage
            src={item.imageUrl}
            alt={itemLabel(item)}
            auditKey={item.name}
            cls="h-10 w-10 object-contain"
          />
        </div>
        <div>
          <h2 class="m-0 font-display text-base font-bold text-text-primary">{itemLabel(item)}</h2>
          <span class="text-xs text-text-muted">{$tr("detail.craftingTree")}</span>
        </div>
      </div>

      <div class="h-[60vh] min-h-[300px] flex flex-col">
        <CraftingTree tree={craftingTree} onOpenItem={openCraftingTreeItem} />
      </div>
    {:else}
      <!-- Normal detail mode -->
      <div class="detail-header">
        <div class="detail-img-wrap">
          <ItemImage
            src={item.imageUrl}
            alt={itemLabel(item)}
            auditKey={item.name}
            cls="item-img"
          />
        </div>
        <div class="detail-title-area">
          <h2>{itemLabel(item)}</h2>
          <div class="detail-tags">
            {#if item.isPrime}<span class="detail-tag prime">{$tr("common.prime")}</span>{/if}
            {#if item.vaulted}<span class="detail-tag vaulted">{$tr("common.vaulted")}</span>{/if}
            {#if item.status === "mastered"}<span class="detail-tag mastered"
                >{$tr("common.mastered")}</span
              >{/if}
            {#if item.status === "progress"}<span class="detail-tag progress"
                >{$tr("common.inProgress")}</span
              >{/if}
            {#if item.status === "missing"}<span class="detail-tag missing"
                >{$tr("common.missing")}</span
              >{/if}
            {#if item.categoryLabel || item.category}
              <span class="detail-meta-inline" data-detail-category={item.category}
                >{item.categoryLabel || item.category}</span
              >
            {/if}
            {#if parentEntry?.name}
              <button
                type="button"
                class="cursor-pointer rounded border border-border-subtle bg-transparent px-2 py-0.5 font-display text-xs text-text-secondary transition-colors duration-150 hover:border-accent hover:bg-surface-hover hover:text-accent"
                title={$tr("common.open", { name: itemLabel(parentEntry) })}
                on:click={openParentItem}
              >
                {$tr("common.partOf", { name: itemLabel(parentEntry) })}
              </button>
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
            <h3>{$tr("detail.components")}</h3>
            <div class="detail-components">
              {#each item.components as comp}
                {@const ownedCount = comp.ownedCount ?? 0}
                {@const needed = comp.itemCount || 1}
                {@const countClass =
                  ownedCount >= needed
                    ? "text-success"
                    : ownedCount > 0
                      ? "text-warning"
                      : "text-danger"}
                <button
                  type="button"
                  class="-mx-1 flex w-full cursor-pointer appearance-none items-center justify-between gap-2 border-0 border-b border-dashed border-border-subtle bg-transparent px-1 py-1.5 text-left font-inherit text-inherit last:border-b-0 hover:rounded-[var(--radius-sm)] hover:bg-surface-hover hover:text-text-primary {selectedComp ===
                  comp
                    ? 'rounded-[var(--radius-sm)] bg-surface-selected'
                    : ''}"
                  aria-pressed={selectedComp === comp}
                  on:click={() => selectComponent(comp)}
                >
                  <span class="comp-name">{itemLabel(comp) || $tr("common.unknown")}</span>
                  <span class="comp-count {countClass}">{ownedCount}/{needed}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}

        {#if shardCopies.length > 0}
          <div class="detail-section" data-archon-slots>
            <h3>{$tr("archon.title")}</h3>
            {#each shardCopies as copy, copyIndex (copy.instanceId ?? copyIndex)}
              {#if shardCopies.length > 1}
                <div class="mt-1.5 text-xs font-semibold text-text-muted">
                  {$tr("archon.copyLabel", { index: copyIndex + 1 })}
                </div>
              {/if}
              <ul class="m-0 list-none p-0 text-sm text-text-secondary">
                {#each archonShardDisplaySlots(copy.slots) as slot (slot.index)}
                  <li
                    class="flex items-center gap-2 border-b border-dashed border-border-subtle py-1.5 last:border-b-0"
                  >
                    <ArchonShardPips slots={[slot]} showEmpty size="md" />
                    <span class="w-24 shrink-0 text-xs">
                      {#if slot.color}
                        {$tr(archonShardColorKey(slot.color))}
                      {:else if slot.filled}
                        {$tr("common.unknown")}
                      {:else}
                        <span class="text-text-muted">{$tr("common.none")}</span>
                      {/if}
                    </span>
                    {#if slot.tauforged}
                      <span
                        class="rounded-[var(--radius-sm)] border border-accent/40 px-1 font-display text-[0.6rem] font-bold tracking-wide text-accent uppercase"
                      >
                        {$tr("archon.tauforged")}
                      </span>
                    {/if}
                    <span class="text-xs text-text-muted">
                      {archonShardUpgradeLabel(slot.upgradeType)}
                    </span>
                  </li>
                {/each}
              </ul>
            {/each}
          </div>
        {/if}

        {#if petSpecies.length > 0 || petPrints.length > 0}
          <div class="detail-section" data-pet-genetics data-pet-species={itemKey}>
            <h3>{$tr("pet.title")}</h3>
            <PetGenetics pets={petSpecies} prints={petPrints} locale={$locale} />
          </div>
        {/if}

        {#if (item.modularParts || []).length > 0}
          <div class="detail-section">
            <h3>{$tr("detail.components")}</h3>
            <ul class="m-0 list-none p-0 text-sm text-text-secondary">
              {#each item.modularParts || [] as part}
                <li class="border-b border-dashed border-border-subtle py-1.5 last:border-b-0">
                  {part}
                </li>
              {/each}
            </ul>
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
