<script lang="ts">
  import ViewPerfMark from "../components/ViewPerfMark.svelte";
  import { masteryData } from "../stores/mastery.js";
  import { wfmItems, itemDb } from "../stores/data.js";
  import { debugMode } from "../stores/app.js";
  import { activeItem, activeComponent, openWithCraftingTree } from "../stores/modals.js";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import { applySharedFiltersAndSort } from "../lib/filters.js";
  import { sharedFilters } from "../stores/filters.js";
  import ItemImage from "../components/ItemImage.svelte";
  import { send } from "../lib/ipc.js";
  import type { MasteryCategoryStats } from "../types/inventory.js";

  const CAT_ORDER = ['Warframes', 'Primary', 'Secondary', 'Melee', 'Companions', 'Archwing', 'Amps', 'Necramech', 'Misc'];

  let catFilter    = 'all';
  let statusFilter = 'all';
  const masteryFilters = sharedFilters("mastery");

  function orderedCategories(byCategory: Record<string, MasteryCategoryStats>): string[] {
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
    // Pre-compute per-item derived values here so {#each} never reads
    // $wfmItems directly — a wfmItems store update won't trigger a full
    // template re-render; Svelte will patch only changed items via the key.
    const hydrated = items.map(item => {
        const mastered = item.status === 'mastered';
        const missing  = item.status === 'missing';
        const nextPct  = missing ? 0 : Math.max(0, Math.min(100,
          Math.floor((item.rank / Math.max(item.maxRank, 1)) * 100)));
        const wfm = $wfmItems[item.name.toLowerCase()] || null;
        return {
          ...item,
          mastered,
          missing,
          nextPct,
          wfm,
          partType: item.isPrime ? ("prime" as const) : ("normal" as const),
          leveledUp: item.rank > 0,
          amount: item.currentlyOwned ? 1 : 0,
        };
      });

    return applySharedFiltersAndSort(hydrated, $masteryFilters);
  })();

  function pct(n: number, total: number): string {
    return total > 0 ? ((n / total) * 100).toFixed(1) : "0.0";
  }
  function pctRaw(n: number, total: number): number {
    return total > 0 ? (n / total) * 100 : 0;
  }
  function clampPct(n: number, total: number): number {
    return Math.max(0, Math.min(100, pctRaw(n, total)));
  }
  const RING_R = 52;
  const RING_C = 2 * Math.PI * RING_R;
</script>

<section class="view active">
<ViewPerfMark name="mastery" />
  <div class="view-header">
    <h2>Mastery Helper</h2>
  </div>

  <SharedFilterBar scope="mastery" />

  {#if $masteryData}
    {@const stats = $masteryData.stats}
    {@const masteredPct = pct(stats.mastered, stats.total)}
    {@const profileMastery = stats.profileMastery || null}

    <!-- Stats overview -->
    <div class="grid gap-3 mb-3.5">
      <div class="flex flex-wrap items-center gap-3.5">
        <div class="shrink-0">
          <svg class="h-[120px] w-[120px]" viewBox="0 0 120 120">
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
        <div class="inline-flex flex-wrap items-stretch gap-x-5 gap-y-3 self-start rounded-lg border border-border bg-bg-surface px-6 py-4">
          <div class="flex items-center gap-3">
            <span class="font-display text-[2.6rem] font-bold text-success leading-none">{stats.mastered}</span>
            <span class="text-lg font-semibold text-text-secondary">Mastered</span>
          </div>
          <span class="self-stretch w-px bg-border" aria-hidden="true"></span>
          <div class="flex items-center gap-3">
            <span class="font-display text-[2.6rem] font-bold text-warning leading-none">{stats.inProgress}</span>
            <span class="text-lg font-semibold text-text-secondary">In Progress</span>
          </div>
          <span class="self-stretch w-px bg-border" aria-hidden="true"></span>
          <div class="flex items-center gap-3">
            <span class="font-display text-[2.6rem] font-bold text-danger leading-none">{stats.missing}</span>
            <span class="text-lg font-semibold text-text-secondary">Missing</span>
          </div>
          <span class="self-stretch w-px bg-border" aria-hidden="true"></span>
          <div class="flex items-center gap-3">
            <span class="font-display text-[2.6rem] font-bold text-text-primary leading-none">{stats.total}</span>
            <span class="text-lg font-semibold text-text-secondary">Total</span>
          </div>
          {#if profileMastery && profileMastery.rank != null}
            <span class="self-stretch w-px bg-border" aria-hidden="true"></span>
            <div class="flex items-center gap-3">
              <span class="font-display text-[2.6rem] font-bold text-text-primary leading-none">MR {profileMastery.rank}</span>
              <span class="text-lg font-semibold text-text-secondary">
                {profileMastery.percentToNext != null ? `${profileMastery.percentToNext}% to next` : 'Progress unavailable'}
              </span>
            </div>
          {/if}
        </div>
      </div>

      <div class="grid gap-[0.46rem] rounded-[0.6rem] border border-border bg-bg-surface p-2.5">
        {#each categories as cat}
          {@const cs = stats.byCategory[cat]}
          {@const masteredWidth = clampPct(cs.mastered, cs.total)}
          {@const progressWidth = clampPct(cs.inProgress, cs.total)}
          <div class="grid items-center gap-2 grid-cols-[minmax(72px,110px)_1fr_auto]">
            <span class="text-[0.8rem] text-text-secondary">{cat}</span>
            <svg class="block h-[0.36rem] w-full overflow-hidden rounded-full bg-white/[0.07]" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true">
              <rect class="fill-success" x="0" y="0" width={masteredWidth} height="1"></rect>
              <rect
                class="fill-warning opacity-60"
                x={masteredWidth}
                y="0"
                width={progressWidth}
                height="1"
              ></rect>
            </svg>
            <span class="whitespace-nowrap text-[0.77rem] text-text-secondary">{cs.mastered}/{cs.total} <small class="text-text-muted">({pct(cs.mastered, cs.total)}%)</small></span>
          </div>
        {/each}
      </div>
    </div>

    <!-- Filters -->
    <div class="grid gap-2 mb-3">
      <div class="filter-tabs">
        <button class="filter-tab" class:active={catFilter === 'all'} on:click={() => (catFilter = 'all')}>All</button>
        {#each categories as cat}
          <button class="filter-tab" class:active={catFilter === cat} on:click={() => (catFilter = cat)}>{cat}</button>
        {/each}
      </div>
      <div class="filter-tabs gap-[0.35rem]">
        {#each [['all','All'],['missing','Missing'],['progress','In Progress'],['mastered','Mastered']] as [key, label]}
          <button class="filter-tab" class:active={statusFilter === key} on:click={() => (statusFilter = key)}>{label}</button>
        {/each}
      </div>
    </div>

    <!-- Item grid -->
    <div class="item-grid">
      {#if filtered.length === 0}
        <div class="empty-state col-span-full"><p>No items match your filters</p></div>
      {:else}
        {#each filtered as item, itemIndex (`${item.uniqueName || item.internalName || item.name}-${itemIndex}`)}
          {@const hasRecipe = !!($itemDb || {})[item.uniqueName || item.internalName]?.recipe}
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div
            class="item-card group {item.status === 'missing' ? 'opacity-[0.62]' : item.status === 'mastered' ? 'border-[rgba(74,222,128,0.24)]' : item.status === 'progress' ? 'border-[rgba(251,191,36,0.24)]' : ''}"
            class:prime={item.isPrime}
            on:click={() => activeItem.set(item)}
          >
            <div class="item-img-wrap">
              <ItemImage src={item.imageUrl} alt={item.name} />
              {#if item.isPrime}<span class="prime-badge">P</span>{/if}
              {#if item.vaulted}<span class="vault-badge">V</span>{/if}
              <span class="absolute right-1.5 bottom-1.5 w-[0.42rem] h-[0.42rem] rounded-full shadow-[0_0_0_2px_rgba(0,0,0,0.38)] {item.status === 'mastered' ? 'bg-success' : item.status === 'progress' ? 'bg-warning' : 'bg-danger opacity-70'}"></span>
            </div>
            <div class="item-body">
              <span class="item-name">{item.name}</span>
              <span class="item-type">{item.category}{item.masteryReq ? ` · MR ${item.masteryReq}` : ''}</span>
              {#if !item.missing}
                {@const rankWidth = item.maxRank > 0 ? Math.max(0, Math.min(100, (item.rank / item.maxRank) * 100)) : 0}
                <div class="item-rank-bar">
                  <svg class="rank-bar-svg" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
                    <rect
                      class="rank-fill-svg"
                      class:max={item.mastered}
                      class:partial={!item.mastered}
                      x="0"
                      y="0"
                      width={rankWidth}
                      height="4"
                      rx="2"
                      ry="2"
                    ></rect>
                  </svg>
                </div>
                <span class="item-rank-text">Lv {item.rank}/{item.maxRank} · {item.nextPct}%</span>
              {:else}
                <span class="text-[0.72rem] text-text-muted">Not owned</span>
              {/if}
              {#if $debugMode}
                <span class="debug-reason">{item.debugReason || 'show:mastery'}</span>
              {/if}
              {#if (item.components || []).length > 0}
                <div class="mt-1.5 flex flex-wrap gap-1">
                  {#each (item.components || []).slice(0, 8) as comp, compIndex (`${comp.uniqueName || comp.name || 'component'}-${compIndex}`)}
                    {@const isOwned = comp.owned || ((comp.ownedCount ?? 0) >= (comp.itemCount || 1))}
                    <!-- svelte-ignore a11y-click-events-have-key-events -->
                    <!-- svelte-ignore a11y-no-static-element-interactions -->
                    <span
                      class="comp-dot h-[0.42rem] w-[0.42rem] rounded-full border border-transparent {isOwned ? 'owned' : 'missing'}"
                      title="{comp.name || '?'}: {isOwned ? 'owned' : 'missing'}"
                      on:click|stopPropagation={() => activeComponent.set({ comp, parentName: item.name })}
                    ></span>
                  {/each}
                </div>
              {/if}
              {#if item.wfm}
                <button
                  type="button"
                  class="wfm-link absolute top-1.5 right-1.5 inline-flex h-[1.45rem] w-[1.45rem] items-center justify-center rounded-[0.3rem] border border-border bg-black/25 text-text-muted opacity-0 transition-[opacity,color,border-color] duration-[120ms] group-hover:opacity-100 hover:text-accent hover:border-accent-dim"
                  title="View on warframe.market"
                  aria-label="View {item.name} on warframe.market"
                  on:click|stopPropagation={() => send('open-external', `https://warframe.market/items/${item.wfm.url_name}`)}
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-[0.86rem] w-[0.86rem]">
                    <path d="M6 3H3v10h10v-3"/>
                    <path d="M9 2h5v5"/>
                    <path d="M14 2L7 9"/>
                  </svg>
                </button>
              {/if}
              {#if hasRecipe}
              <button
                  type="button"
                  class="absolute bottom-1.5 right-1.5 inline-flex h-[1.45rem] w-[1.45rem] items-center justify-center rounded-[0.3rem] border border-border bg-black/25 text-text-muted transition-[opacity,color,border-color] duration-[120ms] hover:text-accent hover:border-accent-dim"
                  title="Open crafting tree"
                  aria-label="Crafting tree for {item.name}"
                  on:click|stopPropagation={() => { openWithCraftingTree.set(true); activeItem.set(item); }}
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-[0.86rem] w-[0.86rem]">
                    <circle cx="8" cy="3" r="1.5" />
                    <circle cx="3" cy="13" r="1.5" />
                    <circle cx="13" cy="13" r="1.5" />
                    <path d="M8 4.5V8M8 8L3 11.5M8 8l5 3.5" />
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

<style>
  .comp-dot.owned {
    background: color-mix(in oklab, var(--success) 65%, transparent);
    border-color: color-mix(in oklab, var(--success) 60%, transparent);
  }
  .comp-dot.missing {
    background: color-mix(in oklab, var(--danger) 65%, transparent);
    border-color: color-mix(in oklab, var(--danger) 60%, transparent);
  }
</style>
