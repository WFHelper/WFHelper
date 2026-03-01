<script>
  import { activeRelic } from '../stores/modals.js';
  import { relicOwnedCounts, relicSquadSize } from '../stores/relics.js';
  import { fetchPriceBySlug } from '../lib/wfmPrice.js';
  import { computeSquadEV, fissureTierClass, RELIC_ICON_PATHS } from '../lib/relic.js';

  const QUAL_LABELS = { intact: 'Intact', exceptional: 'Exceptional', flawless: 'Flawless', radiant: 'Radiant' };

  $: group = $activeRelic;
  $: qualities = group ? Object.keys(group.qualities || {}).filter(q => QUAL_LABELS[q]) : [];

  let activeQuality = 'intact';
  let rewards = [];
  let prices = null;
  let loadingPrices = false;
  let currentGroup = null;
  let currentQuality = null;

  $: if (group && group !== currentGroup) {
    currentGroup = group;
    activeQuality = qualities[0] || 'intact';
    loadQuality(group, activeQuality);
  }

  $: if (group && activeQuality && (group !== currentGroup || activeQuality !== currentQuality)) {
    loadQuality(group, activeQuality);
  }

  async function loadQuality(g, quality) {
    const qData = g?.qualities?.[quality];
    if (!qData) return;
    currentGroup = g;
    currentQuality = quality;
    rewards = qData.rewards || [];
    prices = null;
    loadingPrices = true;

    try {
      const token_g = g;
      const token_q = quality;
      const fetched = await Promise.all(
        rewards.map(r => r?.urlName ? fetchPriceBySlug(r.urlName).then(p => p?.median ?? null) : Promise.resolve(null))
      );
      // Only apply if still viewing same group+quality
      if ($activeRelic === token_g && activeQuality === token_q) {
        prices = fetched;
      }
    } catch (e) {
      console.warn('[RelicDetail] price fetch failed:', e);
    } finally {
      loadingPrices = false;
    }
  }

  function rarityClass(r) {
    const low = (r || '').toLowerCase();
    if (low === 'rare') return 'rarity-rare';
    if (low === 'uncommon') return 'rarity-uncommon';
    return 'rarity-common';
  }

  $: squadEV = (prices && rewards.length)
    ? computeSquadEV(rewards, prices, $relicSquadSize)
    : null;
  $: hasAnyPrice = prices?.some(p => p != null);
  $: squadLabel = $relicSquadSize === 1 ? 'Solo' : `best of ${$relicSquadSize}`;
  $: qualLabel = QUAL_LABELS[activeQuality] || activeQuality;

  $: owned = group ? ($relicOwnedCounts[group.key] || {}) : {};

  $: tierCls = group ? fissureTierClass(group.tier) : '';
  $: iconSrc = group ? (group.imageUrl || RELIC_ICON_PATHS[tierCls] || RELIC_ICON_PATHS.default) : '';

  function close() { activeRelic.set(null); }
</script>

{#if group}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="detail-overlay" style="display:flex;" on:click|self={close}>
    <div class="detail-backdrop" on:click={close}></div>
    <div class="detail-panel relic-detail-panel">
      <button class="detail-close" on:click={close}>&times;</button>

      <div class="detail-header relic-detail-header">
        <div class="relic-detail-icon">
          <span class="relic-icon {tierCls}" style="width:52px;height:52px;">
            <img class="relic-icon-img" src={iconSrc} alt={group.name} style="width:52px;height:52px;" />
          </span>
        </div>
        <div class="relic-detail-title-area">
          <h2>{group.name}</h2>
          <div class="relic-detail-owned">
            {#each Object.entries(QUAL_LABELS) as [q, label]}
              {#if (owned[q] || 0) > 0}
                <span class="relic-owned-pill">{label}: ×{owned[q]}</span>
              {/if}
            {:else}
              <span style="color:var(--text-muted)">None owned</span>
            {/each}
          </div>
        </div>
      </div>

      <!-- Quality tabs -->
      <div class="relic-quality-tabs filter-tabs">
        {#each qualities as q}
          <button
            class="filter-tab"
            class:active={activeQuality === q}
            on:click={() => { activeQuality = q; }}
          >{QUAL_LABELS[q] || q}</button>
        {/each}
      </div>

      <!-- Squad selector -->
      <div class="relic-squad-selector">
        <span class="relic-squad-label">Squad:</span>
        {#each [[1,'Solo'],[2,'2P'],[3,'3P'],[4,'4P']] as [size, label]}
          <button
            class="relic-squad-btn"
            class:active={$relicSquadSize === size}
            on:click={() => relicSquadSize.set(size)}
          >{label}</button>
        {/each}
      </div>

      <!-- Rewards list -->
      <div class="relic-rewards-list">
        <div class="relic-rewards-header">
          <span></span><span>Item</span><span style="text-align:right">Chance</span>
          <span style="text-align:right">Price</span><span style="text-align:right">E.V.</span>
        </div>
        {#each rewards as r, i}
          {@const price = prices ? prices[i] : null}
          {@const ev = (price != null) ? (r.chance / 100) * price : null}
          <div class="relic-reward-row">
            <span class="relic-reward-rarity {rarityClass(r.rarity)}" title={r.rarity}>{r.rarity?.charAt(0) || '?'}</span>
            <span class="relic-reward-name" title={r.name}>{r.name}</span>
            <span class="relic-reward-chance">{r.chance}%</span>
            <span class="relic-reward-price">
              {#if price != null}
                <span class="relic-plat">{price}p</span>
              {:else}
                <span style="color:var(--text-muted)">-</span>
              {/if}
            </span>
            <span class="relic-reward-ev">{ev != null ? `~${ev.toFixed(1)}p` : ''}</span>
          </div>
        {/each}
      </div>

      <!-- EV total -->
      <div class="relic-ev-total">
        {#if loadingPrices}
          Loading prices…
        {:else if !hasAnyPrice}
          Expected value ({qualLabel}): <strong>N/A</strong> (no price data)
        {:else if squadEV != null}
          Expected value ({qualLabel}, {squadLabel}): <strong>~{squadEV.toFixed(1)} platinum</strong>
        {/if}
      </div>
    </div>
  </div>
{/if}
