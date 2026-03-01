<script>
  import { masteryData } from '../stores/mastery.js';
  import { wfmItems } from '../stores/data.js';
  import { debugMode } from '../stores/app.js';
  import { activeItem, activeComponent } from '../stores/modals.js';
  import ItemImage from '../components/ItemImage.svelte';

  const CAT_ORDER = ['Warframes', 'Primary', 'Secondary', 'Melee', 'Companions', 'Archwing', 'Amps', 'Necramech'];

  let catFilter    = 'all';
  let statusFilter = 'all';
  let search       = '';

  function orderedCategories(byCategory) {
    const keys = Object.keys(byCategory);
    const ordered = CAT_ORDER.filter(c => keys.includes(c));
    const extras  = keys.filter(c => !CAT_ORDER.includes(c)).sort((a, b) => a.localeCompare(b));
    return [...ordered, ...extras];
  }

  $: categories = $masteryData ? orderedCategories($masteryData.stats.byCategory) : [];

  $: filtered = (() => {
    if (!$masteryData) return [];
    let items = $masteryData.items;
    if (catFilter !== 'all')    items = items.filter(i => i.category === catFilter);
    if (statusFilter !== 'all') items = items.filter(i => i.status === statusFilter);
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(i =>
        i.name.toLowerCase().includes(q) ||
        i.category.toLowerCase().includes(q) ||
        (i.uniqueName || '').toLowerCase().includes(q) ||
        (i.keywords || []).some(kw => kw.includes(q))
      );
    }
    const order = { mastered: 0, progress: 1, missing: 2 };
    return [...items]
      .sort((a, b) =>
        order[a.status] !== order[b.status]
          ? order[a.status] - order[b.status]
          : a.name.localeCompare(b.name)
      )
      // Pre-compute per-item derived values here so {#each} never reads
      // $wfmItems directly — a wfmItems store update won't trigger a full
      // template re-render; Svelte will patch only changed items via the key.
      .map(item => {
        const mastered = item.status === 'mastered';
        const missing  = item.status === 'missing';
        const nextPct  = missing ? 0 : Math.max(0, Math.min(100,
          Math.floor((item.rank / Math.max(item.maxRank, 1)) * 100)));
        const wfm = $wfmItems[item.name.toLowerCase()] || null;
        return { ...item, mastered, missing, nextPct, wfm };
      });
  })();

  function pct(n, total) {
    return total > 0 ? ((n / total) * 100).toFixed(1) : 0;
  }
  function pctRaw(n, total) {
    return total > 0 ? (n / total) * 100 : 0;
  }
  const RING_R = 52;
  const RING_C = 2 * Math.PI * RING_R;
</script>

<section class="view active">
  <div class="view-header">
    <h2>Mastery Helper</h2>
    <div class="view-controls">
      <div class="search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input type="text" bind:value={search} placeholder="Search items…" />
      </div>
    </div>
  </div>

  {#if $masteryData}
    {@const stats = $masteryData.stats}
    {@const masteredPct = pct(stats.mastered, stats.total)}
    {@const profileMastery = stats.profileMastery || null}

    <!-- Stats overview -->
    <div class="mastery-stats">
      <div class="mastery-overview">
        <div class="mastery-ring-wrap">
          <svg class="mastery-ring" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r={RING_R} fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="8"/>
            <circle
              cx="60" cy="60" r={RING_R}
              fill="none" stroke="var(--accent-blue)" stroke-width="8"
              stroke-dasharray={RING_C}
              stroke-dashoffset={RING_C * (1 - stats.mastered / Math.max(stats.total, 1))}
              stroke-linecap="round"
              transform="rotate(-90 60 60)"
            />
            <text x="60" y="55" text-anchor="middle" fill="var(--text-primary)" font-size="22" font-weight="700" font-family="Rajdhani">{masteredPct}%</text>
            <text x="60" y="72" text-anchor="middle" fill="var(--text-muted)" font-size="10" font-family="Barlow">MASTERED</text>
          </svg>
        </div>
        <div class="mastery-stat-cards">
          <div class="mstat-card mastered"><div class="mstat-num">{stats.mastered}</div><div class="mstat-label">Mastered</div></div>
          <div class="mstat-card progress"><div class="mstat-num">{stats.inProgress}</div><div class="mstat-label">In Progress</div></div>
          <div class="mstat-card missing"><div class="mstat-num">{stats.missing}</div><div class="mstat-label">Missing</div></div>
          <div class="mstat-card total"><div class="mstat-num">{stats.total}</div><div class="mstat-label">Total</div></div>
          {#if profileMastery && profileMastery.rank != null}
            <div class="mstat-card">
              <div class="mstat-num">MR {profileMastery.rank}</div>
              <div class="mstat-label">
                {profileMastery.percentToNext != null ? `${profileMastery.percentToNext}% to next` : 'Progress unavailable'}
              </div>
            </div>
          {/if}
        </div>
      </div>

      <div class="mastery-cat-bars">
        {#each categories as cat}
          {@const cs = stats.byCategory[cat]}
          <div class="cat-bar-row">
            <span class="cat-bar-label">{cat}</span>
            <div class="cat-bar-track">
              <div class="cat-bar-fill mastered" style="width:{pctRaw(cs.mastered, cs.total)}%"></div>
              <div class="cat-bar-fill progress" style="width:{pctRaw(cs.inProgress, cs.total)}%; left:{pctRaw(cs.mastered, cs.total)}%"></div>
            </div>
            <span class="cat-bar-nums">{cs.mastered}/{cs.total} <small>({pct(cs.mastered, cs.total)}%)</small></span>
          </div>
        {/each}
      </div>
    </div>

    <!-- Filters -->
    <div class="mastery-controls">
      <div class="filter-tabs">
        <button class="filter-tab" class:active={catFilter === 'all'} on:click={() => (catFilter = 'all')}>All</button>
        {#each categories as cat}
          <button class="filter-tab" class:active={catFilter === cat} on:click={() => (catFilter = cat)}>{cat}</button>
        {/each}
      </div>
      <div class="filter-tabs mastery-status-filters">
        {#each [['all','All'],['missing','Missing'],['progress','In Progress'],['mastered','Mastered']] as [key, label]}
          <button class="filter-tab" class:active={statusFilter === key} on:click={() => (statusFilter = key)}>{label}</button>
        {/each}
      </div>
    </div>

    <!-- Item grid -->
    <div class="item-grid mastery-grid">
      {#if filtered.length === 0}
        <div class="empty-state" style="grid-column:1/-1"><p>No items match your filters</p></div>
      {:else}
        {#each filtered as item (item.uniqueName || item.name)}
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div
            class="item-card mastery-card {item.status}"
            class:prime={item.isPrime}
            on:click={() => activeItem.set(item)}
          >
            <div class="item-img-wrap">
              <ItemImage src={item.imageUrl} alt={item.name} />
              {#if item.isPrime}<span class="prime-badge">P</span>{/if}
              {#if item.vaulted}<span class="vault-badge">V</span>{/if}
              <span class="status-indicator {item.status}"></span>
            </div>
            <div class="item-body">
              <span class="item-name">{item.name}</span>
              <span class="item-type">{item.category}{item.masteryReq ? ` · MR ${item.masteryReq}` : ''}</span>
              {#if !item.missing}
                <div class="item-rank-bar">
                  <div class="rank-fill" class:max={item.mastered} class:partial={!item.mastered} style="width:{item.maxRank > 0 ? (item.rank / item.maxRank) * 100 : 0}%"></div>
                </div>
                <span class="item-rank-text">Lv {item.rank}/{item.maxRank} · {item.nextPct}%</span>
              {:else}
                <span class="mastery-missing-label">Not owned</span>
              {/if}
              {#if $debugMode}
                <span class="debug-reason">{item.debugReason || 'show:mastery'}</span>
              {/if}
              {#if (item.components || []).length > 0}
                <div class="comp-dots">
                  {#each (item.components || []).slice(0, 8) as comp (comp.name || comp.uniqueName)}
                    {@const isOwned = comp.owned || (comp.ownedCount >= (comp.itemCount || 1))}
                    <!-- svelte-ignore a11y-click-events-have-key-events -->
                    <!-- svelte-ignore a11y-no-static-element-interactions -->
                    <span
                      class="comp-dot {isOwned ? 'owned' : 'missing'}"
                      title="{comp.name || '?'}: {isOwned ? 'owned' : 'missing'}"
                      on:click|stopPropagation={() => activeComponent.set({ comp, parentName: item.name })}
                    ></span>
                  {/each}
                </div>
              {/if}
              {#if item.wfm}
                <button
                  type="button"
                  class="wfm-link"
                  title="View on warframe.market"
                  aria-label="View {item.name} on warframe.market"
                  on:click|stopPropagation={() => window.api.openExternal(`https://warframe.market/items/${item.wfm.url_name}`)}
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M6 3H3v10h10v-3"/>
                    <path d="M9 2h5v5"/>
                    <path d="M14 2L7 9"/>
                  </svg>
                </button>
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>
  {:else}
    <div class="empty-state">
      <p>Loading mastery data…</p>
    </div>
  {/if}
</section>
