<script lang="ts">
  import { activeItem, activeComponent } from "../stores/modals.js";
  import { wfmItems } from "../stores/data.js";
  import { fetchPriceByName } from "../lib/wfmPrice.js";
  import ItemImage from "../components/ItemImage.svelte";
  import { ipc } from "../lib/ipc.js";

  let priceText = "";
  let priceSlug: string | null = null;

  $: item = $activeItem;

  $: if (item) {
    loadPrice(item.name);
  }

  async function loadPrice(name: string): Promise<void> {
    priceText  = 'Loading price…';
    priceSlug  = null;
    const isTradable = item?.tradable || item?.isPrime ||
      !!(($wfmItems || {})[name?.toLowerCase()]) ||
      !!(($wfmItems || {})[`${name} Set`.toLowerCase()]);

    if (!isTradable) {
      priceText  = 'Item is not tradable.';
      return;
    }

    try {
      const result = await fetchPriceByName(name, $wfmItems, { priority: "high" });
      if (result?.median != null) {
          priceText  = `~${result.median} platinum (48h median)`;
        priceSlug  = result.slug;
      } else {
        const mapping = ($wfmItems || {})[name?.toLowerCase()] || ($wfmItems || {})[`${name} Set`.toLowerCase()];
        if (mapping) {
              priceText  = 'No recent price data.';
          priceSlug  = mapping.url_name;
        } else {
              priceText  = 'No listing found for this item.';
        }
      }
    } catch {
      priceText  = 'Failed to load price data.';
    }
  }

  function openOnWfm() {
    if (priceSlug) ipc.openExternal(`https://warframe.market/items/${priceSlug}`);
  }

  function close() { activeItem.set(null); }
</script>

{#if item}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="detail-overlay" on:click|self={close}>
    <div class="detail-backdrop" on:click={close}></div>
    <div class="detail-panel">
      <button class="detail-close" on:click={close}>&times;</button>

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
          </div>
          <div class="detail-meta">
            {[item.categoryLabel || item.category, item.masteryReq ? `MR ${item.masteryReq}` : null, (item.rank != null && item.maxRank) ? `Rank ${item.rank}/${item.maxRank}` : null].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>

      <div class="detail-body">
        {#if item.description}
          <div class="detail-desc">{item.description}</div>
        {/if}

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
                  on:click={() => activeComponent.set({ comp, parentName: item.name })}
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
              {#each (item.drops || []).slice(0, 10) as d}
                <div class="drop-entry">
                  <span class="drop-location">{d.location}</span>
                  {#if d.rarity}<span class="drop-rarity">({d.rarity})</span>{/if}
                </div>
              {/each}
              {#if (item.drops || []).length > 10}
                <div class="drop-entry drop-entry-more">…and {item.drops.length - 10} more sources</div>
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
              <button class="market-link-btn" on:click={openOnWfm}>Open on warframe.market</button>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

