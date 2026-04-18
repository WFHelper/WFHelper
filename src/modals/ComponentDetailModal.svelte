<script lang="ts">
  import { activeComponent } from "../stores/modals.js";
  import { itemDb, wfmItems } from "../stores/data.js";
  import { loadItemPrice, openOnWfm } from "../lib/priceLoader.js";
  import { resolveDrops } from "../lib/resolveDrops.js";
  import { toOfficialWikiUrl, buildWikiUrl } from "../lib/wikiUrl.js";
  import { send } from "../lib/ipc.js";

  let priceText = "";
  let priceSlug: string | null = null;
  let showAllDrops = false;

  $: data = $activeComponent;
  $: comp = data?.comp;
  $: parentName = data?.parentName || '';

  // Fall back to itemDb drops when comp.drops is empty (non-prime components)
  $: compDrops = resolveDrops(comp, $itemDb);

  // Get image from itemDb if available
  $: compImageUrl = comp?.uniqueName ? ($itemDb[comp.uniqueName]?.imageUrl || null) : null;

  // Extract location from description (skip generic item descriptions)
  $: compDescription = comp?.uniqueName ? ($itemDb[comp.uniqueName]?.description || '') : '';
  $: compLocation = (() => {
    if (!compDescription) return '';
    const locMatch = compDescription.match(/Location:\s*(.+)/i);
    return locMatch ? locMatch[0] : '';
  })();
  $: compWikiUrl = comp?.uniqueName ? ($itemDb[comp.uniqueName]?.wikiaUrl || null) : null;

  $: if (comp) {
    showAllDrops = false;
    loadPrice();
  }

  async function loadPrice(): Promise<void> {
    priceText = 'Loading price…';
    priceSlug = null;
    const fullName = parentName ? `${parentName} ${comp!.name}` : comp!.name;
    const isTradable = comp?.tradable || !!(($wfmItems || {})[fullName?.toLowerCase()]) || !!(($wfmItems || {})[comp?.name?.toLowerCase() || '']);
    const result = await loadItemPrice(fullName, $wfmItems || {}, isTradable);
    priceText = result.text;
    priceSlug = result.slug;
  }

  function close() { activeComponent.set(null); }
</script>

{#if comp}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="detail-overlay comp-overlay" on:click|self={close}>
    <div class="detail-backdrop" on:click={close}></div>
    <div class="detail-panel comp-panel">
      <div class="detail-panel-top-actions">
        <button class="detail-wiki-btn" on:click={() => send('open-external', compWikiUrl ? toOfficialWikiUrl(compWikiUrl) : buildWikiUrl(parentName ? `${parentName} ${comp.name}` : comp.name))} title="Open on Wiki">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M9 2h5v5l-1.8-1.8L9 8.4 7.6 7l3.2-3.2L9 2zM4 4h3v1.5H4v7h7V9.5h1.5V13a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 13V4.5A.5.5 0 0 1 3.5 4H4z"/>
          </svg>
          <span>Wiki</span>
        </button>
        <button class="detail-close" on:click={close}>&times;</button>
      </div>

      <div class="detail-header">
        {#if compImageUrl}
          <div class="detail-img-wrap">
            <img class="item-img" src={compImageUrl} alt={comp.name} />
          </div>
        {/if}
        <div class="detail-title-area">
          <h2>{comp.name || 'Unknown Component'}</h2>
          <div class="comp-meta-stack">
            {#if parentName}<div class="detail-meta">{parentName}</div>{/if}
            {#if comp.tradable}<div class="detail-meta">Tradable</div>{/if}
            <div class="detail-meta">{comp.ownedCount ?? 0}/{comp.itemCount || 1} owned</div>
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
              {#each (showAllDrops ? compDrops : compDrops.slice(0, 5)) as d}
                <div class="drop-entry">
                  <span class="drop-location">{d.location}</span>
                  {#if d.chance}<span class="drop-chance">{(d.chance * 100).toFixed(1)}%</span>{/if}
                  {#if d.rarity}<span class="drop-rarity">({d.rarity})</span>{/if}
                </div>
              {/each}
              {#if !showAllDrops && compDrops.length > 5}
                <button class="drop-view-all" on:click={() => showAllDrops = true}>View all {compDrops.length} sources</button>
              {:else if showAllDrops && compDrops.length > 5}
                <button class="drop-view-all" on:click={() => showAllDrops = false}>Show fewer</button>
              {/if}
            </div>
          </div>
        {/if}

        <div class="detail-section detail-market-section">
          <h3>Warframe.market</h3>
          <div class="detail-market-body">
            {priceText}
            {#if priceSlug}
              <br/>
              <button class="market-link-btn" on:click={() => openOnWfm(priceSlug)}>Open on warframe.market</button>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}
