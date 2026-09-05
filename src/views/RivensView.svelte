<script lang="ts">
  import { onMount } from "svelte";
  import { invoke, on } from "../lib/ipc.js";
  import {
    ELEMENT_ICON_URLS,
    NAV_ICON_URLS,
    RIVEN_TEMPLATE_URL,
    STAT_ICON_URLS,
  } from "../lib/assetUrls.js";
  import { compareSharedFilterSort, matchesSharedFilters } from "../lib/filters.js";
  import { attrGradeColor, gradeColor } from "../lib/rivenGradeColors.js";
  import { rivenDissolveHint } from "../lib/rivens/dissolve.js";
  import { matchRivenListings, rivenNameSuffix } from "../lib/marketContract.js";
  import {
    ensureRivenContractsLoaded,
    invalidateRivenContractsRefresh,
  } from "../lib/marketContractsSync.js";
  import { rivenChatTag, rivenWtsLine } from "../lib/rivenChatTag.js";
  import type { DecodedRiven, VeiledRivenEntry, VeiledRivenGroup } from "../types/ipc.js";
  import type { WfmContract } from "../types/market.js";
  import RivenDetailModal from "../modals/RivenDetailModal.svelte";
  import RivenFinder from "../components/RivenFinder.svelte";
  import HeaderTabs from "../components/HeaderTabs.svelte";
  import SegmentedControl from "../components/SegmentedControl.svelte";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import RivenPolarityIcon from "../components/RivenPolarityIcon.svelte";
  import ItemImage from "../components/ItemImage.svelte";
  import { inventoryData, itemDb } from "../stores/data.js";
  import { sharedFilters } from "../stores/filters.js";
  import { rivenCardSize, type RivenCardSize } from "../stores/rivenCardSize.js";
  import { marketContracts } from "../stores/market.js";
  import { addToast } from "../stores/toasts.js";
  import { readStorage, writeStorage } from "../lib/persistence.js";
  import { tr } from "../lib/i18n.js";
  import {
    RIVEN_ATTR_GRADE_KEYS,
    RIVEN_ATTR_GRADE_ORDER,
    RIVEN_TYPE_KEYS,
  } from "../lib/rivenLabels.js";

  type RivenSortKey = "name" | "disposition" | "rerolls" | "grade" | "attr_grade";
  type RivenViewTab = "unveiled" | "veiled" | "finder";

  const VIEW_TAB_KEY = "wf_rivens_tab";

  function restoreViewTab(): RivenViewTab {
    const raw = readStorage(VIEW_TAB_KEY);
    return raw === "veiled" || raw === "finder" ? raw : "unveiled";
  }

  let rivens: DecodedRiven[] = $state([]);
  let veiledRivens: VeiledRivenEntry[] = $state([]);
  let veiledUnseen: VeiledRivenGroup[] = $state([]);
  let loading = $state(true);
  let typeFilter = $state("all");
  let gradeFilter = $state("all");
  let attrGradeFilter = $state("all");
  let selectedRiven = $state<DecodedRiven | null>(null);
  let viewTab = $state<RivenViewTab>(restoreViewTab());
  let listingsRefreshing = $state(false);
  let cardMenu = $state<{ riven: DecodedRiven; x: number; y: number } | null>(null);

  const TYPES = ["all", "Rifle", "Shotgun", "Pistol", "Melee", "Archgun", "Kitgun", "Zaw"];
  const TYPE_OPTIONS = $derived(
    TYPES.map((value) => ({
      value,
      label: value === "all" ? $tr("common.all") : $tr(RIVEN_TYPE_KEYS[value]),
    })),
  );
  // Letter families: grading emits +/- variants (A+, B-, ...), S and F stand alone.
  const GRADES = ["all", "S", "A", "B", "C", "F"];
  const GRADE_OPTIONS = $derived(
    GRADES.map((value) => ({
      value,
      label: value === "all" ? $tr("common.all") : value,
    })),
  );
  // "?" is not offered: an unknown weapon has no attribute verdict to filter on.
  const ATTR_GRADES = ["all", "Great", "Good", "OK", "Bad"];
  const ATTR_GRADE_OPTIONS = $derived(
    ATTR_GRADES.map((value) => ({
      value,
      label: value === "all" ? $tr("common.all") : $tr(RIVEN_ATTR_GRADE_KEYS[value]),
    })),
  );
  const VIEW_TABS = $derived([
    { key: "unveiled", label: $tr("rivens.tab.unveiled") },
    { key: "veiled", label: $tr("rivens.tab.veiled") },
    { key: "finder", label: $tr("rivens.tab.finder") },
  ]);
  const SORT_OPTIONS: Array<[RivenSortKey, string]> = $derived([
    ["name", $tr("common.name")],
    ["disposition", $tr("rivens.sort.disposition")],
    ["rerolls", $tr("common.rerolls")],
    ["grade", $tr("rivens.sort.grade")],
    ["attr_grade", $tr("rivens.sort.attributeGrade")],
  ]);
  const CARD_SIZE_OPTIONS: { value: RivenCardSize; label: string }[] = $derived([
    { value: "full", label: $tr("rivens.cardSize.full") },
    { value: "compact", label: $tr("rivens.cardSize.compact") },
  ]);
  const rivenFilters = sharedFilters("rivens");
  function filterableRiven(riven: DecodedRiven): {
    name: string;
    keywords: string[];
    disposition: number;
    rerolls: number;
    grade: string;
    attrGradeRank: number | null;
  } {
    return {
      name: riven.weaponName,
      // rivenName makes the generated suffix searchable ("satidra", "croni").
      keywords: [riven.rivenName, ...riven.stats.map((stat) => stat.name)],
      disposition: riven.disposition,
      rerolls: riven.rerolls,
      grade: riven.overallGrade,
      attrGradeRank: RIVEN_ATTR_GRADE_ORDER[riven.attributeGrade] ?? null,
    };
  }

  const filteredRivens = $derived.by(() => {
    let list = rivens;
    list = list.filter((riven) => matchesSharedFilters(filterableRiven(riven), $rivenFilters));
    if (typeFilter !== "all") {
      list = list.filter((r) => r.rivenType === typeFilter);
    }
    if (gradeFilter !== "all") {
      list = list.filter((r) => r.overallGrade.toUpperCase().startsWith(gradeFilter));
    }
    if (attrGradeFilter !== "all") {
      list = list.filter((r) => r.attributeGrade === attrGradeFilter);
    }
    list = [...list].sort((a, b) =>
      compareSharedFilterSort(filterableRiven(a), filterableRiven(b), $rivenFilters),
    );
    return list;
  });

  const totalVeiled = $derived(
    veiledRivens.length + veiledUnseen.reduce((sum, g) => sum + g.count, 0),
  );

  const listingByRiven = $derived(matchRivenListings(rivens, $marketContracts.contracts));

  // The buyout is what a buyer can take; only an auction without one advertises
  // its opening bid instead.
  function listingPlatinum(contract: WfmContract): number {
    return contract.buyoutPlatinum ?? contract.platinum;
  }

  // Right-click menus are placed by hand, so keep the box inside the viewport.
  const MENU_WIDTH = 224;
  const MENU_HEIGHT = 96;

  function openCardMenu(event: MouseEvent, riven: DecodedRiven): void {
    event.preventDefault();
    cardMenu = {
      riven,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - MENU_WIDTH)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - MENU_HEIGHT)),
    };
  }

  async function copyToClipboard(text: string): Promise<void> {
    cardMenu = null;
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
      addToast({ level: "error", message: $tr("common.clipboardUnavailableInThisEnvironment") });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      addToast({ level: "success", message: $tr("common.copied") });
    } catch {
      addToast({ level: "error", message: $tr("common.copyFailed") });
    }
  }

  /** The cached list is stale the moment the modal creates or removes a listing. */
  function reloadListings(): void {
    invalidateRivenContractsRefresh();
    void ensureRivenContractsLoaded(true);
  }

  async function refreshListings(): Promise<void> {
    if (listingsRefreshing) return;
    listingsRefreshing = true;
    try {
      if (!(await ensureRivenContractsLoaded(true))) {
        addToast({ level: "error", message: $tr("rivens.listingsRefreshFailed") });
      }
    } finally {
      listingsRefreshing = false;
    }
  }

  async function loadRivens() {
    loading = true;
    try {
      const result = await invoke("getRivens");
      rivens = result.unveiled;
      veiledRivens = result.veiled ?? [];
      veiledUnseen = result.veiledUnseen ?? [];
    } catch {
      rivens = [];
      veiledRivens = [];
      veiledUnseen = [];
    } finally {
      loading = false;
    }
  }

  function setViewTab(key: string): void {
    viewTab = key as RivenViewTab;
    writeStorage(VIEW_TAB_KEY, key);
  }

  const ELEMENT_ICONS: Record<string, string> = ELEMENT_ICON_URLS;

  function elementIcon(statName: string): string | null {
    const lower = statName.toLowerCase();
    for (const [key, path] of Object.entries(ELEMENT_ICONS)) {
      if (lower.includes(key)) return path;
    }
    return null;
  }

  onMount(() => {
    loadRivens();
    // Read-only and TTL-gated inside the loader, so entering the tab never polls.
    void ensureRivenContractsLoaded();
    const unsub = on("inventory-updated", () => {
      loadRivens();
    });
    return unsub;
  });
</script>

<svelte:window
  onclick={() => (cardMenu = null)}
  onkeydown={(event) => {
    if (event.key === "Escape") cardMenu = null;
  }}
/>

{#snippet copyGlyph()}
  <svg
    class="h-3 w-3"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
{/snippet}

{#snippet listingBadge(listing: WfmContract, cls: string, iconCls: string)}
  <span class={cls} title={$tr("rivens.listedPrice", { plat: listing.platinum })} data-riven-listed>
    <img
      src={NAV_ICON_URLS.market}
      alt={$tr("rivens.listedPrice", { plat: listing.platinum })}
      class={iconCls}
    />
  </span>
{/snippet}

{#snippet gradeBadges(riven: DecodedRiven, gradeCls: string, attrCls: string)}
  {@const attrGradeKey = RIVEN_ATTR_GRADE_KEYS[riven.attributeGrade]}
  <span
    class={gradeCls}
    style="color: {gradeColor(riven.overallGrade)}"
    data-riven-grade={riven.overallGrade}>{riven.overallGrade}</span
  >
  {#if attrGradeKey}
    <span
      class={attrCls}
      style="color: {attrGradeColor(riven.attributeGrade)}"
      title={$tr("rivens.sort.attributeGrade")}
      data-riven-attr-grade={riven.attributeGrade}>{$tr(attrGradeKey)}</span
    >
  {/if}
{/snippet}

{#snippet statRows(riven: DecodedRiven, rowCls: string, iconCls: string)}
  {#each riven.stats as stat}
    <div class={rowCls}>
      <span class="font-bold shrink-0 {stat.positive ? 'text-success' : 'text-danger'}">
        {stat.multiplier
          ? `x${stat.displayValue}`
          : `${stat.displayValue >= 0 ? "+" : ""}${stat.displayValue}%`}
      </span>
      {#if elementIcon(stat.name)}
        <img class={iconCls} src={elementIcon(stat.name)} alt="" />
      {/if}
      <span class="overflow-hidden text-ellipsis text-text-primary font-medium min-w-0"
        >{stat.name}</span
      >
    </div>
  {/each}
{/snippet}

{#snippet metaRow(riven: DecodedRiven, polaritySize: number, polarityCls: string)}
  <span class="text-text-secondary font-bold">{$tr("rivens.mr", { level: riven.masteryReq })}</span>
  <RivenPolarityIcon polarity={riven.polarity} size={polaritySize} className={polarityCls} />
  <span class="text-riven-reroll font-bold"
    >{$tr("rivens.rerollCount", { count: riven.rerolls })}</span
  >
{/snippet}

{#snippet cardActions(riven: DecodedRiven, listing: WfmContract | undefined, wrapperCls: string)}
  <div class={wrapperCls}>
    <button
      class="inline-flex items-center justify-center rounded border border-border bg-bg-deep/60 p-1 text-text-secondary opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
      title={$tr("rivens.copyChatTag")}
      aria-label={$tr("rivens.copyChatTag")}
      onclick={() => copyToClipboard(rivenChatTag(riven))}
      data-riven-copy-tag
    >
      {@render copyGlyph()}
    </button>
    {#if listing}
      <button
        class="inline-flex items-center justify-center rounded border border-border bg-bg-deep/60 px-1.5 py-1 font-display text-[0.625rem] font-bold leading-none text-text-secondary opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
        title={$tr("rivens.copyWtsLine")}
        aria-label={$tr("rivens.copyWtsLine")}
        onclick={() => copyToClipboard(rivenWtsLine(riven, listingPlatinum(listing)))}
        data-riven-copy-wts
      >
        WTS
      </button>
    {/if}
  </div>
{/snippet}

{#snippet emptyState(message: string)}
  <div
    class="empty-state flex flex-col items-center justify-center min-h-[40vh] text-text-muted text-sm"
  >
    <p>{message}</p>
  </div>
{/snippet}

<section class="view active">
  <div class="view-header mb-2">
    <h2>{$tr("common.rivens")}</h2>
  </div>

  <div class="mb-4 flex items-end border-b border-border-subtle" data-tour="riven-view-tabs">
    <HeaderTabs
      options={VIEW_TABS.map((tab) => ({
        ...tab,
        label:
          tab.key === "unveiled"
            ? $tr("rivens.tab.unveiledCount", { count: rivens.length })
            : tab.key === "veiled"
              ? $tr("rivens.tab.veiledCount", { count: totalVeiled })
              : tab.label,
      }))}
      activeKey={viewTab}
      onSelect={setViewTab}
    />
  </div>

  {#if viewTab === "unveiled"}
    <div class="flex items-center gap-3 flex-wrap mb-4">
      <SharedFilterBar
        scope="rivens"
        singleLine
        showAdvanced={false}
        basicVariant="quick"
        sortOptions={SORT_OPTIONS}
      />

      <SegmentedControl
        value={typeFilter}
        options={TYPE_OPTIONS}
        onChange={(value) => (typeFilter = value)}
      />

      <SegmentedControl
        value={gradeFilter}
        options={GRADE_OPTIONS}
        onChange={(value) => (gradeFilter = value)}
      />

      <div data-riven-attr-grade-filter title={$tr("rivens.sort.attributeGrade")}>
        <SegmentedControl
          value={attrGradeFilter}
          options={ATTR_GRADE_OPTIONS}
          onChange={(value) => (attrGradeFilter = value)}
        />
      </div>

      <div data-riven-card-size-control>
        <SegmentedControl
          value={$rivenCardSize}
          options={CARD_SIZE_OPTIONS}
          onChange={(value) => rivenCardSize.set(value)}
        />
      </div>

      <button
        class="btn-secondary btn-sm inline-flex items-center gap-1.5"
        onclick={refreshListings}
        disabled={listingsRefreshing}
        title={$tr("rivens.refreshListings")}
        data-riven-listings-refresh
      >
        <img src={NAV_ICON_URLS.market} alt="" class="h-3 w-3" />
        {$tr("common.refresh")}
      </button>
    </div>

    {#if loading}
      {@render emptyState($tr("rivens.loading"))}
    {:else if filteredRivens.length === 0}
      <!-- Rivens are decoded from the loaded inventory, so an empty list with an
           inventory present means the account owns none, not that nothing loaded. -->
      {@render emptyState(
        rivens.length > 0
          ? $tr("rivens.noResults")
          : $inventoryData
            ? $tr("rivens.noUnveiled")
            : $tr("rivens.noData"),
      )}
    {:else}
      {#if $rivenCardSize === "compact"}
        <!-- The compact tile drops the rank pips and the dissolve-endo badge on purpose:
             there is no room at this size and both are in the detail modal. -->
        <div
          class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3"
          data-riven-card-size={$rivenCardSize}
        >
          {#each filteredRivens as riven (riven.itemId)}
            {@const listing = listingByRiven.get(riven.itemId)}
            {@const suffix = rivenNameSuffix(riven.rivenName, riven.weaponName)}
            <div class="relative" data-riven-card={riven.itemId}>
              <button
                class="block w-full cursor-pointer rounded-lg border border-border-subtle bg-surface-card p-2 text-left transition-[border-color] duration-150 hover:border-border-strong focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
                onclick={() => (selectedRiven = riven)}
                oncontextmenu={(event) => openCardMenu(event, riven)}
              >
                <div class="flex items-start gap-2">
                  <!-- ItemImage's own h-auto/w-auto outrank a size utility, so the box
                       clamps the art instead. -->
                  <div class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden">
                    <ItemImage
                      src={$itemDb[riven.weaponUniqueName]?.imageUrl ?? null}
                      alt={riven.weaponName}
                      cls="max-h-full max-w-full"
                    />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="truncate font-display text-sm font-bold text-text-heading">
                      {riven.weaponName}
                    </div>
                    {#if suffix}
                      <div class="truncate font-display text-xs text-text-secondary">{suffix}</div>
                    {/if}
                  </div>
                  <div class="flex shrink-0 flex-col items-end gap-0.5">
                    {@render gradeBadges(
                      riven,
                      "font-display text-sm font-extrabold leading-none [text-shadow:0_0_4px_rgba(0,0,0,0.55)]",
                      "font-display text-[0.55rem] font-bold uppercase leading-none tracking-[0.06em]",
                    )}
                  </div>
                </div>

                <div class="mt-1.5 flex flex-col gap-0.5">
                  {@render statRows(
                    riven,
                    "flex items-baseline gap-[0.25em] overflow-hidden whitespace-nowrap font-display text-xs leading-[1.15]",
                    "h-3 w-3 shrink-0 self-center align-middle",
                  )}
                </div>

                <div
                  class="mt-1.5 flex items-center gap-2 pr-12 font-display text-[0.625rem] leading-none"
                >
                  {@render metaRow(riven, 12, "inline-flex min-w-3 object-contain")}
                  {#if listing}
                    {@render listingBadge(listing, "inline-flex items-center", "h-3 w-3")}
                  {/if}
                </div>
              </button>

              {@render cardActions(
                riven,
                listing,
                "absolute bottom-1.5 right-1.5 z-[2] flex gap-1",
              )}
            </div>
          {/each}
        </div>
      {:else}
        <div
          class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-5 justify-items-center"
          data-riven-card-size={$rivenCardSize}
        >
          {#each filteredRivens as riven (riven.itemId)}
            {@const listing = listingByRiven.get(riven.itemId)}
            {@const suffix = rivenNameSuffix(riven.rivenName, riven.weaponName)}
            {@const dissolveEndo = rivenDissolveHint(riven)}
            <div
              class="relative mx-auto w-[min(100%,18rem)] max-[700px]:w-[min(100%,16rem)] aspect-[316/400] transition-transform duration-[0.18s] ease hover:-translate-y-1 hover:z-[2]"
              data-riven-card={riven.itemId}
            >
              <button
                class="relative block w-full h-full p-0 border-0 outline-none bg-transparent appearance-none cursor-pointer overflow-visible focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
                onclick={() => (selectedRiven = riven)}
                oncontextmenu={(event) => openCardMenu(event, riven)}
              >
                <div
                  class="relative w-full h-full bg-center bg-[length:100%_100%] bg-no-repeat"
                  style:background-image={`url("${RIVEN_TEMPLATE_URL}")`}
                >
                  {#if listing}
                    {@render listingBadge(
                      listing,
                      "absolute top-[9%] left-[13%] z-[2] inline-flex items-center justify-center rounded-full border border-accent bg-bg-deep/85 p-1.5 shadow-[0_0_6px_rgba(0,0,0,0.9)]",
                      "h-4 w-4",
                    )}
                  {/if}

                  {@render gradeBadges(
                    riven,
                    "absolute top-[10%] right-[15%] z-[2] font-display font-extrabold text-base leading-none [text-shadow:0_0_4px_rgba(0,0,0,1),0_0_8px_rgba(0,0,0,0.9)]",
                    "absolute top-[15.5%] right-[13%] z-[2] font-display text-[0.6rem] font-bold uppercase tracking-[0.06em] leading-none [text-shadow:0_0_4px_rgba(0,0,0,1),0_0_8px_rgba(0,0,0,0.9)]",
                  )}

                  {#if dissolveEndo !== null}
                    <span
                      class="absolute top-[19.5%] right-[12%] z-[2] inline-flex items-center gap-1 rounded-full border border-border bg-bg-deep/80 px-1.5 py-0.5 font-display text-[0.6rem] font-bold leading-none text-text-secondary"
                      title={$tr("rivens.dissolveValue", { endo: dissolveEndo })}
                      data-riven-dissolve-endo={dissolveEndo}
                    >
                      <img src={STAT_ICON_URLS.endoDelta} alt="" class="h-2.5 w-2.5" />
                      {dissolveEndo}
                    </span>
                  {/if}

                  <div class="absolute z-[1] left-[13%] right-[11%] top-[51%] text-center">
                    <span
                      class="font-display text-xl max-[700px]:text-xl font-bold text-text-heading leading-[1.1] [text-shadow:0_0_4px_rgba(0,0,0,1),0_0_8px_rgba(0,0,0,1),0_2px_12px_rgba(0,0,0,0.95),0_0_20px_rgba(80,40,160,0.3)]"
                      >{riven.weaponName}</span
                    >
                    {#if suffix}
                      <span
                        class="font-display text-sm font-semibold text-text-primary leading-[1.1] [text-shadow:0_0_4px_rgba(0,0,0,1),0_0_8px_rgba(0,0,0,0.95)]"
                      >
                        {suffix}</span
                      >
                    {/if}
                  </div>

                  <div
                    class="absolute z-[1] left-[13%] right-[11%] top-[59%] flex flex-col gap-0 items-center text-center"
                  >
                    {@render statRows(
                      riven,
                      "flex items-baseline justify-center gap-[0.25em] w-full text-base max-[700px]:text-sm font-display leading-[1.05] whitespace-nowrap overflow-hidden text-ellipsis [text-shadow:0_0_3px_rgba(0,0,0,1),0_0_6px_rgba(0,0,0,1),0_2px_8px_rgba(0,0,0,0.95)]",
                      "w-4 h-4 align-middle shrink-0 self-center [filter:drop-shadow(0_1px_3px_rgba(0,0,0,0.8))]",
                    )}
                  </div>

                  <div
                    class="absolute z-[1] left-[18%] right-[18%] top-[94%] flex justify-center gap-1"
                  >
                    {#each Array(riven.maxRank) as _, i}
                      <span
                        class="w-2 h-2 rounded-[1px] border {i < riven.currentRank
                          ? 'bg-riven-pip border-riven-pip shadow-[0_0_4px_rgba(94,200,255,0.9),0_0_8px_rgba(94,200,255,0.5),0_0_12px_rgba(94,200,255,0.25)]'
                          : 'bg-surface-card border-border-subtle'}"
                      ></span>
                    {/each}
                  </div>

                  <div
                    class="absolute z-[1] left-[22%] right-[22%] top-[83.5%] flex items-center justify-between text-xs font-display leading-none [text-shadow:0_0_3px_rgba(0,0,0,1),0_0_6px_rgba(0,0,0,1)]"
                  >
                    {@render metaRow(
                      riven,
                      14,
                      "inline-flex min-w-3.5 -translate-y-0.5 object-contain",
                    )}
                  </div>
                </div>
              </button>

              {@render cardActions(
                riven,
                listing,
                "absolute right-[7%] top-[90%] z-[3] flex gap-1",
              )}
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  {:else if viewTab === "veiled"}
    {#if loading}
      {@render emptyState($tr("rivens.loading"))}
    {:else if veiledRivens.length === 0 && veiledUnseen.length === 0}
      {@render emptyState($tr("rivens.noVeiled"))}
    {:else}
      {#if veiledRivens.length > 0}
        <div class="mb-5">
          <div class="flex flex-col gap-2">
            {#each veiledRivens as entry}
              <div
                class="flex items-center justify-between py-2.5 px-4 bg-bg-surface border border-border rounded-lg transition-[border-color] duration-150 hover:border-border-strong"
              >
                <div class="font-display text-sm font-semibold text-text-primary min-w-16 shrink-0">
                  {$tr("rivens.rivenMod", { label: entry.label })}
                </div>
                {#if entry.challengeDesc}
                  <div class="flex items-center gap-3 flex-1 min-w-0">
                    <span class="text-xs text-text-secondary">{entry.challengeDesc}</span>
                    {#if entry.challengeProgress != null && entry.challengeRequired != null}
                      <div
                        class="w-20 h-[6px] bg-surface-hover rounded-[3px] overflow-hidden shrink-0"
                      >
                        <div
                          class="h-full bg-accent rounded-[3px] transition-[width] duration-300"
                          style="width: {Math.min(
                            100,
                            (entry.challengeProgress / Math.max(entry.challengeRequired, 1)) * 100,
                          )}%"
                        ></div>
                      </div>
                      <span class="font-display text-xs text-text-muted shrink-0">
                        {entry.challengeProgress} / {entry.challengeRequired}
                      </span>
                    {/if}
                  </div>
                {:else}
                  <div class="flex items-center gap-3 flex-1 min-w-0">
                    <span class="text-xs text-text-muted italic"
                      >{$tr("rivens.challengeNotAssigned")}</span
                    >
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}

      {#if veiledUnseen.length > 0}
        <div class="mb-5">
          <h3 class="font-display text-sm font-semibold text-text-secondary m-0 mb-2">
            {$tr("rivens.unseenTitle")}
          </h3>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
            {#each veiledUnseen as group}
              <div
                class="flex flex-col items-center text-center py-4 px-3 bg-surface-card border border-border-subtle rounded-lg gap-2 transition-[border-color] duration-150 hover:border-border-strong"
              >
                <div class="font-display text-base font-bold text-text-primary">{group.label}</div>
                <div class="text-xs text-text-muted leading-[1.3]">
                  {$tr("rivens.equipToReveal")}
                </div>
                <div class="flex items-center gap-2 mt-auto">
                  <span class="font-display text-sm font-bold text-text-secondary"
                    >x{group.count}</span
                  >
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  {:else if viewTab === "finder"}
    <RivenFinder />
  {/if}
</section>

{#if cardMenu}
  {@const menuRiven = cardMenu.riven}
  {@const menuListing = listingByRiven.get(menuRiven.itemId)}
  <div
    class="fixed z-[60] min-w-[13rem] rounded-lg border border-border bg-bg-surface py-1 shadow-lg"
    style="left: {cardMenu.x}px; top: {cardMenu.y}px"
    role="menu"
    tabindex="-1"
    data-riven-card-menu
  >
    <button
      class="block w-full px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary"
      role="menuitem"
      onclick={() => copyToClipboard(rivenChatTag(menuRiven))}
    >
      {$tr("rivens.copyChatTag")}
    </button>
    {#if menuListing}
      <button
        class="block w-full px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        role="menuitem"
        onclick={() => copyToClipboard(rivenWtsLine(menuRiven, listingPlatinum(menuListing)))}
      >
        {$tr("rivens.copyWtsLine")}
      </button>
    {/if}
  </div>
{/if}

{#if selectedRiven}
  <RivenDetailModal
    riven={selectedRiven}
    contract={listingByRiven.get(selectedRiven.itemId) ?? null}
    oncontractupdated={reloadListings}
    onclose={() => (selectedRiven = null)}
  />
{/if}
