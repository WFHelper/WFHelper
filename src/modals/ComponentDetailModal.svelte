<script>
  import { activeComponent } from '../stores/modals.js';
  import { wfmItems } from '../stores/data.js';
  import { fetchPriceByName } from '../lib/wfmPrice.js';

  let priceText = '';
  let priceSlug = null;

  $: data = $activeComponent;
  $: comp = data?.comp;
  $: parentName = data?.parentName || '';

  $: if (comp) {
    loadPrice(comp.name);
  }

  async function loadPrice(name) {
    priceText = 'Loading price…';
    priceSlug = null;
    const isTradable = comp?.tradable || !!(($wfmItems || {})[name?.toLowerCase()]);
    if (!isTradable) {
      priceText = 'Component is not tradable.';
      return;
    }
    try {
      const result = await fetchPriceByName(name, $wfmItems);
      if (result?.median != null) {
        priceText = `~${result.median} platinum (48h median)`;
        priceSlug = result.slug;
      } else {
        const mapping = ($wfmItems || {})[name?.toLowerCase()];
        if (mapping) {
          priceText = 'No recent price data.';
          priceSlug = mapping.url_name;
        } else {
          priceText = 'No listing found.';
        }
      }
    } catch {
      priceText = 'Failed to load price data.';
    }
  }

  function openOnWfm() {
    if (priceSlug) window.api.openExternal(`https://warframe.market/items/${priceSlug}`);
  }

  function close() { activeComponent.set(null); }
</script>

{#if comp}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="detail-overlay comp-overlay" style="display:flex;" on:click|self={close}>
    <div class="detail-backdrop" on:click={close}></div>
    <div class="detail-panel comp-panel">
      <button class="detail-close" on:click={close}>&times;</button>

      <div class="detail-header">
        <div class="detail-title-area">
          <h2>{comp.name || 'Unknown Component'}</h2>
          <div class="detail-meta">
            {[parentName || null, comp.tradable ? 'Tradable' : null, `${comp.ownedCount ?? 0}/${comp.itemCount || 1} owned`].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>

      <div class="detail-body">
        {#if (comp.drops || []).length > 0}
          <div class="detail-section">
            <h3>Drop Sources</h3>
            <div class="detail-acquisition">
              {#each (comp.drops || []).slice(0, 15) as d}
                <div class="drop-entry">
                  <span class="drop-location">{d.location}</span>
                  {#if d.rarity}<span class="drop-rarity">({d.rarity})</span>{/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <div class="detail-section detail-market-section">
          <h3>Warframe.market</h3>
          <div class="detail-market-body">
            {priceText}
            {#if priceSlug}
              <br/>
              <button class="market-link-btn" on:click={openOnWfm}>Open on warframe.market</button>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}
