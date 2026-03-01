<script>
  import { onMount, onDestroy } from 'svelte';
  import { relicDb, relicTierFilter, relicSearch, relicSortMode, relicQualityMode, relicSquadSize, relicOwnedCounts, relicEvRevision } from '../stores/relics.js';
  import { inventoryData } from '../stores/data.js';
  import { activeRelic } from '../stores/modals.js';
  import { RELIC_ICON_PATHS, RELIC_TIER_ORDER, fissureTierClass, getCachedEv, evHasFreshNoData, warmupRelicEvs, resetEvCaches, cancelWarmup } from '../lib/relic.js';
  import { parseOwnedRelics } from '../lib/relic.js';

  let loading = false;
  let error = '';

  onMount(async () => {
    if (!$relicDb) {
      loading = true;
      try {
        const db = await window.api.getRelicDatabase();
        relicDb.set(db);
        if ($inventoryData) {
          relicOwnedCounts.set(parseOwnedRelics($inventoryData, db));
        }
      } catch (e) {
        error = 'Failed to load relic database.';
        console.error('[Relics] getRelicDatabase failed:', e);
      } finally {
        loading = false;
      }
    }
    if ($relicDb) startWarmup();
  });

  // Cancel the background warmup when navigating away from this view
  // to prevent hundreds of queued API requests from continuing.
  onDestroy(() => cancelWarmup());

  // Re-run warmup if squad/quality change
  $: if ($relicSquadSize || $relicQualityMode) {
    if ($relicDb) startWarmup();
  }

  function startWarmup() {
    const groups = Object.values($relicDb?.groups || {});
    if (!groups.length) return;
    // Debounce UI updates — bump the revision at most once per 800ms so
    // rapid batch completions don't trigger 24+ full re-renders.
    let debounceTimer = null;
    const onBatchDone = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => relicEvRevision.update(n => n + 1), 800);
    };
    warmupRelicEvs(groups, onBatchDone);
  }

  $: groups = (() => {
    void $relicEvRevision; // reactive dependency
    if (!$relicDb) return [];
    let g = Object.values($relicDb.groups);
    // When inventory is loaded, only show relics the player actually owns
    if ($inventoryData) {
      const ownedKeys = Object.keys($relicOwnedCounts);
      console.log('[RelicsView] inventory loaded, relicOwnedCounts keys:', ownedKeys.length, 'sample:', ownedKeys.slice(0, 3));
      g = g.filter(x => {
        const owned = $relicOwnedCounts[x.key];
        return owned && Object.values(owned).some(c => c > 0);
      });
    }
    if ($relicTierFilter !== 'all') g = g.filter(x => x.tier === $relicTierFilter);
    if ($relicSearch) {
      const q = $relicSearch.toLowerCase();
      g = g.filter(x => x.name.toLowerCase().includes(q));
    }
    if ($relicSortMode === 'ev_desc' || $relicSortMode === 'ev_asc') {
      const dir = $relicSortMode === 'ev_desc' ? -1 : 1;
      g = [...g].sort((a, b) => {
        const aEv = getCachedEv(a.key, $relicSquadSize, $relicQualityMode);
        const bEv = getCachedEv(b.key, $relicSquadSize, $relicQualityMode);
        if ((aEv == null) !== (bEv == null)) return aEv == null ? 1 : -1;
        if (aEv != null && bEv != null && aEv !== bEv) return dir * (aEv - bEv);
        const ta = RELIC_TIER_ORDER[a.tier] ?? 99;
        const tb = RELIC_TIER_ORDER[b.tier] ?? 99;
        return ta !== tb ? ta - tb : a.name.localeCompare(b.name);
      });
    } else {
      g = [...g].sort((a, b) => {
        const ta = RELIC_TIER_ORDER[a.tier] ?? 99;
        const tb = RELIC_TIER_ORDER[b.tier] ?? 99;
        return ta !== tb ? ta - tb : a.name.localeCompare(b.name);
      });
    }
    return g;
  })();

  function evLabel(groupKey) {
    const ev = getCachedEv(groupKey, $relicSquadSize, $relicQualityMode);
    const noData = evHasFreshNoData(groupKey, $relicSquadSize, $relicQualityMode);
    const qLabel = $relicQualityMode === 'best' ? 'Best'
      : $relicQualityMode === 'exceptional' ? 'Ex'
      : $relicQualityMode.charAt(0).toUpperCase() + $relicQualityMode.slice(1, 3);
    const valueStr = ev != null ? `~${ev.toFixed(1)}p` : (noData ? 'N/A' : '…');
    return { text: `${qLabel} ${valueStr}`, cls: ev != null ? 'has-value' : (noData ? 'no-data' : 'loading') };
  }
</script>

<section class="view active">
  <div class="view-header">
    <h2>Relic Planner ({groups.length})</h2>
    <div class="view-controls">
      <div class="search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input type="text" bind:value={$relicSearch} placeholder="Search relics…" />
      </div>

      <!-- Tier filter -->
      <div class="filter-tabs">
        {#each [['all','All'],['Lith','Lith'],['Meso','Meso'],['Neo','Neo'],['Axi','Axi'],['Requiem','Requiem']] as [key, label]}
          <button class="filter-tab" class:active={$relicTierFilter === key} on:click={() => relicTierFilter.set(key)}>{label}</button>
        {/each}
      </div>

      <!-- Sort -->
      <div class="filter-tabs" title="Sort relics">
        {#each [['tier','Default'],['ev_desc','Plat ↓'],['ev_asc','Plat ↑']] as [key, label]}
          <button class="filter-tab" class:active={$relicSortMode === key} on:click={() => relicSortMode.set(key)}>{label}</button>
        {/each}
      </div>

      <!-- Quality -->
      <div class="filter-tabs" title="Relic quality for EV">
        {#each [['best','Best'],['intact','Intact'],['exceptional','Exceptional'],['flawless','Flawless'],['radiant','Radiant']] as [key, label]}
          <button class="filter-tab" class:active={$relicQualityMode === key} on:click={() => relicQualityMode.set(key)}>{label}</button>
        {/each}
      </div>

      <!-- Squad size -->
      <div class="filter-tabs" title="Squad size for EV">
        {#each [[1,'Solo'],[2,'2P'],[3,'3P'],[4,'4P']] as [size, label]}
          <button class="filter-tab" class:active={$relicSquadSize === size} on:click={() => relicSquadSize.set(size)}>{label}</button>
        {/each}
      </div>
    </div>
  </div>

  {#if loading}
    <div class="empty-state"><p>Loading relic database…</p></div>
  {:else if error}
    <div class="empty-state"><p>{error}</p></div>
  {:else if groups.length === 0}
    <div class="empty-state"><p>No relics found</p></div>
  {:else}
    <div id="relic-grid">
      {#each groups as g (g.key)}
        {@const tierCls = fissureTierClass(g.tier)}
        {@const iconSrc = g.imageUrl || RELIC_ICON_PATHS[tierCls] || RELIC_ICON_PATHS.default}
        {@const owned = $relicOwnedCounts[g.key]}
        {@const totalOwned = owned ? Object.values(owned).reduce((s, c) => s + c, 0) : 0}
        {@const ev = evLabel(g.key)}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="relic-card" on:click={() => activeRelic.set(g)}>
          <div class="relic-card-icon">
            <span class="relic-icon {tierCls}">
              <img class="relic-icon-img" src={iconSrc} alt={g.name} loading="lazy" />
            </span>
          </div>
          <div class="relic-card-body">
            <span class="relic-card-name">{g.name}</span>
            <span class="relic-card-tier tier-{tierCls}">{g.tier}</span>
          </div>
          <span class="relic-ev-badge {ev.cls}">{ev.text}</span>
          {#if totalOwned > 0}
            <span class="relic-owned-badge">×{totalOwned}</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>
