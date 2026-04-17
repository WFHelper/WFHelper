<script lang="ts">
  import { activeItem } from "../stores/modals.js";
  import { itemDb, wfmItems } from "../stores/data.js";
  import { loadItemPrice, openOnWfm } from "../lib/priceLoader.js";
  import ItemImage from "../components/ItemImage.svelte";
  import { send } from "../lib/ipc.js";
  import { toOfficialWikiUrl, buildWikiUrl } from "../lib/wikiUrl.js";
  import { resolveDrops } from "../lib/resolveDrops.js";
  import type { ComponentInfo, DropInfo } from "../types/inventory.js";

  let priceText = "";
  let priceSlug: string | null = null;

  // Inline component panel state
  let selectedComp: ComponentInfo | null = null;
  let compPriceText = "";
  let compPriceSlug: string | null = null;

  // Drop source expansion state
  let showAllDrops = false;
  let showAllCompDrops = false;

  $: item = $activeItem;

  // Reset selected component when item changes
  $: if (item) {
    selectedComp = null;
    showAllDrops = false;
    showAllCompDrops = false;
    loadPrice(item.name);
  }

  // Derived component data
  $: compDrops = resolveDrops(selectedComp, $itemDb);
  $: compImageUrl = selectedComp?.uniqueName ? ($itemDb[selectedComp.uniqueName]?.imageUrl || null) : null;
  $: compDescription = selectedComp?.uniqueName ? ($itemDb[selectedComp.uniqueName]?.description || '') : '';
  $: compLocation = (() => {
    if (!compDescription) return '';
    const locMatch = compDescription.match(/Location:\s*(.+)/i);
    return locMatch ? locMatch[0] : '';
  })();
  $: compWikiUrl = selectedComp?.uniqueName ? ($itemDb[selectedComp.uniqueName]?.wikiaUrl || null) : null;

  async function loadPrice(name: string): Promise<void> {
    priceText = 'Loading price…';
    priceSlug = null;
    const isTradable = item?.tradable || item?.isPrime ||
      !!(($wfmItems || {})[name?.toLowerCase()]) ||
      !!(($wfmItems || {})[`${name} Set`.toLowerCase()]);
    const result = await loadItemPrice(name, $wfmItems || {}, isTradable);
    priceText = result.text;
    priceSlug = result.slug;
  }

  function selectComponent(comp: ComponentInfo) {
    if (selectedComp === comp) {
      selectedComp = null;
      return;
    }
    selectedComp = comp;
    showAllCompDrops = false;
    loadCompPrice(comp);
  }

  async function loadCompPrice(comp: ComponentInfo): Promise<void> {
    compPriceText = 'Loading price…';
    compPriceSlug = null;
    // Build full tradeable name: "Trinity Prime" + "Chassis" = "Trinity Prime Chassis"
    const fullName = item ? `${item.name} ${comp.name}` : comp.name;
    const isTradable = comp.tradable || !!(($wfmItems || {})[fullName?.toLowerCase()]) || !!(($wfmItems || {})[comp.name?.toLowerCase()]);
    const result = await loadItemPrice(fullName, $wfmItems || {}, isTradable);
    compPriceText = result.text;
    compPriceSlug = result.slug;
  }

  function close() {
    selectedComp = null;
    activeItem.set(null);
  }
</script>

{#if item}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="detail-overlay" on:click|self={close}>
    <div class="detail-backdrop" on:click={close}></div>
    <div class="detail-dual-container" class:has-comp={selectedComp}>
      <div class="detail-panel">
        <div class="detail-panel-top-actions">
          {#if item.wikiaUrl}
            <button class="detail-wiki-btn" on:click={() => send('open-external', toOfficialWikiUrl(item.wikiaUrl!))} title="Open on Wiki">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                <path d="M9 2h5v5l-1.8-1.8L9 8.4 7.6 7l3.2-3.2L9 2zM4 4h3v1.5H4v7h7V9.5h1.5V13a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 13V4.5A.5.5 0 0 1 3.5 4H4z"/>
              </svg>
              <span>Wiki</span>
            </button>
          {/if}
          <button class="detail-close" on:click={close}>&times;</button>
        </div>

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
                  <!-- svelte-ignore a11y-click-events-have-key-events -->
                  <!-- svelte-ignore a11y-no-static-element-interactions -->
                  <div
                    class="detail-comp-row {stateClass}"
                    class:active={selectedComp === comp}
                    on:click={() => selectComponent(comp)}
                  >
                    <span class="comp-name">{comp.name || 'Unknown'}</span>
                    <span class="comp-count {countClass}">{ownedCount}/{needed}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          {#if (item.drops || []).length > 0}
            <div class="detail-section">
              <h3>Acquisition</h3>
              <div class="detail-acquisition">
                {#each (showAllDrops ? item.drops : (item.drops || []).slice(0, 5)) as d}
                  <div class="drop-entry">
                    <span class="drop-location">{d.location}</span>
                    {#if d.chance}<span class="drop-chance">{(d.chance * 100).toFixed(1)}%</span>{/if}
                    {#if d.rarity}<span class="drop-rarity">({d.rarity})</span>{/if}
                  </div>
                {/each}
                {#if !showAllDrops && (item.drops || []).length > 5}
                  <button class="drop-view-all" on:click={() => showAllDrops = true}>View all {item.drops.length} sources</button>
                {/if}
              </div>
            </div>
          {/if}

          <div class="detail-section detail-market-section">
            <h3>Warframe.market</h3>
            <div class="detail-market-body">
              {priceText || '…'}
              {#if priceSlug}
                <br/>
                <button class="market-link-btn" on:click={() => openOnWfm(priceSlug)}>Open on warframe.market</button>
              {/if}
            </div>
          </div>

        </div>
      </div>

      <!-- Inline component detail side panel -->
      {#if selectedComp}
        <div class="detail-panel comp-inline-panel">
          <div class="detail-panel-top-actions">
            <button class="detail-wiki-btn" on:click={() => send('open-external', compWikiUrl ? toOfficialWikiUrl(compWikiUrl) : buildWikiUrl(`${item.name} ${selectedComp?.name || ''}`))} title="Open on Wiki">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                <path d="M9 2h5v5l-1.8-1.8L9 8.4 7.6 7l3.2-3.2L9 2zM4 4h3v1.5H4v7h7V9.5h1.5V13a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 13V4.5A.5.5 0 0 1 3.5 4H4z"/>
              </svg>
              <span>Wiki</span>
            </button>
            <button class="detail-close" on:click={() => selectedComp = null}>&times;</button>
          </div>

          <div class="detail-header">
            {#if compImageUrl}
              <div class="detail-img-wrap">
                <img class="item-img" src={compImageUrl} alt={selectedComp.name} />
              </div>
            {/if}
            <div class="detail-title-area">
              <h2>{selectedComp.name || 'Unknown Component'}</h2>
              <div class="comp-meta-stack">
                {#if item.name}<div class="detail-meta">{item.name}</div>{/if}
                {#if selectedComp.tradable}<div class="detail-meta">Tradable</div>{/if}
                <div class="detail-meta">{selectedComp.ownedCount ?? 0}/{selectedComp.itemCount || 1} owned</div>
              </div>
            </div>
          </div>

          <div class="detail-body">
            {#if compLocation}
              <div class="detail-desc">{compLocation}</div>
            {/if}

            {#if compDrops.length > 0}
              <div class="detail-section">
                <h3>Drop Sources</h3>
                <div class="detail-acquisition">
                  {#each (showAllCompDrops ? compDrops : compDrops.slice(0, 5)) as d}
                    <div class="drop-entry">
                      <span class="drop-location">{d.location}</span>
                      {#if d.chance}<span class="drop-chance">{(d.chance * 100).toFixed(1)}%</span>{/if}
                      {#if d.rarity}<span class="drop-rarity">({d.rarity})</span>{/if}
                    </div>
                  {/each}
                  {#if !showAllCompDrops && compDrops.length > 5}
                    <button class="drop-view-all" on:click={() => showAllCompDrops = true}>View all {compDrops.length} sources</button>
                  {/if}
                </div>
              </div>
            {/if}

            <div class="detail-section detail-market-section">
              <h3>Warframe.market</h3>
              <div class="detail-market-body">
                {compPriceText}
                {#if compPriceSlug}
                  <br/>
                  <button class="market-link-btn" on:click={() => openOnWfm(compPriceSlug)}>Open on warframe.market</button>
                {/if}
              </div>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}
