<script lang="ts">
  import { masteryData } from "../stores/mastery.js";
  import { wfmItems } from "../stores/data.js";
  import { activeItem, activeComponent } from "../stores/modals.js";
  import { hideFounderMasteryItems } from "../stores/preferences.js";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import HeaderTabs from "../components/HeaderTabs.svelte";
  import SummaryStrip, { type SummaryStripItem } from "../components/SummaryStrip.svelte";
  import ThemedPanel from "../components/ThemedPanel.svelte";
  import { applySharedFiltersAndSort } from "../lib/filters.js";
  import { sharedFilters } from "../stores/filters.js";
  import ItemImage from "../components/ItemImage.svelte";
  import { send } from "../lib/ipc.js";
  import type { MasteryCategoryStats } from "../types/inventory.js";

  const CAT_ORDER = ['Warframes', 'Primary', 'Secondary', 'Melee', 'Companions', 'Archwing', 'Amps', 'Necramech', 'Misc'];
  const MASTERY_SORT_OPTIONS = [
    ["name", "Name"],
    ["owned", "Owned"],
  ] satisfies Array<["name" | "owned", string]>;
  const FOUNDER_ITEM_NAMES = new Set(["Excalibur Prime", "Lato Prime", "Skana Prime"]);

  let catFilter    = 'all';
  let statusFilter = 'all';
  const masteryFilters = sharedFilters("mastery");
  const STATUS_TABS = [
    { key: "all", label: "All" },
    { key: "missing", label: "Missing" },
    { key: "progress", label: "In Progress" },
    { key: "mastered", label: "Mastered" },
  ];

  function orderedCategories(byCategory: Record<string, MasteryCategoryStats>): string[] {
    const keys = Object.keys(byCategory);
    const ordered = CAT_ORDER.filter(c => keys.includes(c));
    const extras  = keys.filter(c => !CAT_ORDER.includes(c)).sort((a, b) => a.localeCompare(b));
    return [...ordered, ...extras];
  }

  function isFounderItem(name: string): boolean {
    return FOUNDER_ITEM_NAMES.has(name);
  }

  function masteryStatsForItems(
    items: NonNullable<typeof $masteryData>["items"],
    data: NonNullable<typeof $masteryData>,
  ): NonNullable<typeof $masteryData>["stats"] {
    const stats: NonNullable<typeof $masteryData>["stats"] = {
      total: items.length,
      mastered: 0,
      inProgress: 0,
      missing: 0,
      byCategory: {},
      profileMastery: data.stats.profileMastery ?? null,
    };

    for (const item of items) {
      if (!stats.byCategory[item.category]) {
        stats.byCategory[item.category] = { total: 0, mastered: 0, inProgress: 0, missing: 0 };
      }
      stats.byCategory[item.category].total++;
      if (item.status === "mastered") {
        stats.mastered++;
        stats.byCategory[item.category].mastered++;
      } else if (item.status === "progress") {
        stats.inProgress++;
        stats.byCategory[item.category].inProgress++;
      } else {
        stats.missing++;
        stats.byCategory[item.category].missing++;
      }
    }

    return stats;
  }

  function masteryViewData(data: typeof $masteryData, hideFounder: boolean): typeof $masteryData {
    if (!data || !hideFounder) return data;
    const items = data.items.filter((item) => !isFounderItem(item.name));
    return {
      ...data,
      items,
      stats: masteryStatsForItems(items, data),
    };
  }

  $: displayMasteryData = masteryViewData($masteryData, $hideFounderMasteryItems);
  $: categories = displayMasteryData ? orderedCategories(displayMasteryData.stats.byCategory) : [];

  function buildMasterySummary(data: typeof $masteryData): SummaryStripItem[] {
    if (!data) return [];
    const stats = data.stats;
    const profileMastery = stats.profileMastery || null;
    const rows: SummaryStripItem[] = [
      { key: "mastered", value: stats.mastered, label: "Mastered", tone: "success" },
      { key: "progress", value: stats.inProgress, label: "In Progress", tone: "warning" },
      { key: "missing", value: stats.missing, label: "Missing", tone: "danger" },
      { key: "total", value: stats.total, label: "Total" },
    ];
    if (profileMastery && profileMastery.rank != null) {
      rows.push({
        key: "mr",
        value: `MR ${profileMastery.rank}`,
        label: profileMastery.percentToNext != null
          ? `${profileMastery.percentToNext}% to next`
          : "Progress unavailable",
      });
    }
    return rows;
  }

  $: masterySummaryItems = buildMasterySummary(displayMasteryData);

  // Pre-compute per-item derived values here so {#each} never reads
  // $wfmItems directly - a wfmItems store update won't trigger a full
  // template re-render; Svelte will patch only changed items via the key.
  function hydrateAndFilterMastery(
    data: typeof $masteryData,
    wfmLookup: typeof $wfmItems,
    sharedFilters: typeof $masteryFilters,
    cat: string,
    status: string,
  ) {
    if (!data) return [];
    let items = data.items;
    if (cat !== 'all') items = items.filter(i => i.category === cat);
    if (status !== 'all') items = items.filter(i => i.status === status);
    const hydrated = items.map(item => {
      const mastered = item.status === 'mastered';
      const missing  = item.status === 'missing';
      const nextPct  = missing ? 0 : Math.max(0, Math.min(100,
        Math.floor((item.rank / Math.max(item.maxRank, 1)) * 100)));
      const wfm = wfmLookup[item.name.toLowerCase()] || null;
      return {
        ...item,
        mastered,
        missing,
        nextPct,
        wfm,
        partType: item.isPrime ? ("prime" as const) : ("normal" as const),
        leveledUp: item.rank > 0,
        amount: item.status !== "missing" || item.currentlyOwned ? 1 : 0,
        owned: item.status !== "missing" || item.currentlyOwned === true,
      };
    });

    return applySharedFiltersAndSort(hydrated, sharedFilters);
  }

  $: filtered = hydrateAndFilterMastery(
    displayMasteryData,
    $wfmItems,
    $masteryFilters,
    catFilter,
    statusFilter,
  );

  function formatPercent(n: number, total: number): string {
    return total > 0 ? ((n / total) * 100).toFixed(1) : "0.0";
  }
  function boundedPercent(n: number, total: number): number {
    const percent = total > 0 ? (n / total) * 100 : 0;
    return Math.max(0, Math.min(100, percent));
  }
  const RING_R = 52;
  const RING_C = 2 * Math.PI * RING_R;

  $: categoryTabs = [
    { key: "all", label: "All" },
    ...categories.map((cat) => ({ key: cat, label: cat })),
  ];
</script>

<section class="view active">
  <div class="view-header">
    <h2>Mastery Helper</h2>
  </div>

  <SharedFilterBar scope="mastery" sortOptions={MASTERY_SORT_OPTIONS} />

  {#if displayMasteryData}
    {@const stats = displayMasteryData.stats}
    {@const masteredPct = formatPercent(stats.mastered, stats.total)}

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
        <SummaryStrip items={masterySummaryItems} variant="mastery" />
      </div>

      <ThemedPanel className="grid gap-2 p-2.5">
        {#each categories as cat}
          {@const cs = stats.byCategory[cat]}
          {@const masteredWidth = boundedPercent(cs.mastered, cs.total)}
          {@const progressWidth = boundedPercent(cs.inProgress, cs.total)}
          <div class="grid items-center gap-2 grid-cols-[minmax(72px,110px)_1fr_auto]">
            <span class="text-xs text-text-secondary">{cat}</span>
            <svg class="block h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true">
              <rect class="fill-success" x="0" y="0" width={masteredWidth} height="1"></rect>
              <rect
                class="fill-warning opacity-60"
                x={masteredWidth}
                y="0"
                width={progressWidth}
                height="1"
              ></rect>
            </svg>
            <span class="whitespace-nowrap text-xs text-text-secondary">{cs.mastered}/{cs.total} <small class="text-text-muted">({formatPercent(cs.mastered, cs.total)}%)</small></span>
          </div>
        {/each}
      </ThemedPanel>
    </div>

    <!-- Filters -->
    <div class="grid gap-2 mb-3">
      <div class="flex items-end border-b border-white/[0.09]">
        <HeaderTabs options={categoryTabs} activeKey={catFilter} onSelect={(key) => (catFilter = key)} />
      </div>
      <div class="flex items-end border-b border-white/[0.09]">
        <HeaderTabs
          options={STATUS_TABS}
          activeKey={statusFilter}
          onSelect={(key) => (statusFilter = key)}
        />
      </div>
    </div>

    <!-- Item grid -->
    <div class="item-grid">
      {#if filtered.length === 0}
        <div class="empty-state col-span-full"><p>No items match your filters</p></div>
      {:else}
        {#each filtered as item, itemIndex (`${item.uniqueName || item.internalName || item.name}-${itemIndex}`)}
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div
            class="item-card group {item.status === 'missing' ? 'opacity-60' : item.status === 'mastered' ? 'border-success/25' : item.status === 'progress' ? 'border-warning/25' : ''}"
            on:click={() => activeItem.set(item)}
          >
            <div class="item-img-wrap">
              <ItemImage src={item.imageUrl} alt={item.name} />
              {#if item.vaulted}<span class="vault-badge">V</span>{/if}
              <span class="absolute right-1.5 bottom-1.5 w-1.5 h-1.5 rounded-full shadow-[0_0_0_2px_rgba(0,0,0,0.38)] {item.status === 'mastered' ? 'bg-success' : item.status === 'progress' ? 'bg-warning' : 'bg-danger opacity-70'}"></span>
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
                <span class="text-xs text-text-muted">Not owned</span>
              {/if}
              {#if (item.components || []).length > 0}
                <div class="mt-1.5 flex flex-wrap gap-1">
                  {#each (item.components || []).slice(0, 8) as comp, compIndex (`${comp.uniqueName || comp.name || 'component'}-${compIndex}`)}
                    {@const isOwned = comp.owned || ((comp.ownedCount ?? 0) >= (comp.itemCount || 1))}
                    <!-- svelte-ignore a11y-click-events-have-key-events -->
                    <!-- svelte-ignore a11y-no-static-element-interactions -->
                    <span
                      class="comp-dot h-1.5 w-1.5 rounded-full border border-transparent {isOwned ? 'owned' : 'missing'}"
                      title="{comp.name || '?'}: {isOwned ? 'owned' : 'missing'}"
                      on:click|stopPropagation={() => activeComponent.set({ comp, parentName: item.name })}
                    ></span>
                  {/each}
                </div>
              {/if}
              {#if item.wfm}
                <button
                  type="button"
                  class="wfm-link absolute top-1.5 right-1.5 inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-black/25 text-text-muted opacity-0 transition-[opacity,color,border-color] duration-100 group-hover:opacity-100 hover:text-accent hover:border-accent-dim"
                  title="View on warframe.market"
                  aria-label="View {item.name} on warframe.market"
                  on:click|stopPropagation={() => send('open-external', `https://warframe.market/items/${item.wfm.url_name}`)}
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3.5 w-3.5">
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
      <p>Loading mastery data...</p>
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
