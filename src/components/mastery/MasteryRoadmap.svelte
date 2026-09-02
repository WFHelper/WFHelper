<script lang="ts">
  import { itemLabel } from "../../lib/itemLabel.js";
  import HeaderTabs from "../HeaderTabs.svelte";
  import ItemImage from "../ItemImage.svelte";
  import SearchBox from "../SearchBox.svelte";
  import ThemedPanel from "../ThemedPanel.svelte";
  import { easyMasteryPotentialRank } from "../../lib/masteryProjection.js";
  import { readStorage, writeStorage } from "../../lib/persistence.js";
  import { locale, tr } from "../../lib/i18n.js";
  import type { MasteryRoadmap, MasteryRoadmapRecommendation } from "../../lib/masteryRoadmap.js";

  type RoadmapMode = "easy" | "relics" | "platinum";
  type RoadmapSort = "recommended" | "xp" | "price";

  const MODE_TAB_KEY = "wf_mastery_roadmap_tab";

  export let roadmap: MasteryRoadmap;
  export let totalXp: number | null = null;
  export let currentRank: number | null = null;
  export let onOpen: (item: MasteryRoadmapRecommendation) => void;

  $: MODE_TABS = [
    { key: "easy", label: $tr("mastery.roadmap.easy") },
    { key: "relics", label: $tr("mastery.roadmap.fromRelics") },
    { key: "platinum", label: $tr("mastery.roadmap.withPlatinum") },
  ];

  $: ACCESS_LABELS = {
    owned: $tr("mastery.roadmap.accessOwned"),
    claimable: $tr("mastery.roadmap.accessClaimable"),
    building: $tr("mastery.roadmap.accessBuilding"),
    buildable: $tr("common.canBuild"),
    relics: $tr("mastery.roadmap.accessRelics"),
    platinum: $tr("mastery.roadmap.accessPlatinum"),
  };

  function restoreMode(): RoadmapMode {
    const raw = readStorage(MODE_TAB_KEY);
    return raw === "relics" || raw === "platinum" ? raw : "easy";
  }

  let mode: RoadmapMode = restoreMode();
  let sort: RoadmapSort = "recommended";
  let category = "all";
  let search = "";

  $: source =
    mode === "easy" ? roadmap.easy : mode === "relics" ? roadmap.relics : roadmap.platinum;
  $: categories = [
    ...new Set(
      [...roadmap.easy, ...roadmap.relics, ...roadmap.platinum].map((item) => item.category),
    ),
  ].sort((a, b) => a.localeCompare(b));
  $: visible = source
    .filter((item) => category === "all" || item.category === category)
    // Match both: the list shows the localized name but traders search in English.
    .filter((item) => {
      const needle = search.trim().toLowerCase();
      return (
        item.name.toLowerCase().includes(needle) || itemLabel(item).toLowerCase().includes(needle)
      );
    })
    .sort((a, b) => {
      if (sort === "xp") {
        return b.masteryXpRemaining - a.masteryXpRemaining || a.name.localeCompare(b.name);
      }
      if (sort === "price") {
        return (
          (a.estimatedCost ?? Number.POSITIVE_INFINITY) -
            (b.estimatedCost ?? Number.POSITIVE_INFINITY) || a.name.localeCompare(b.name)
        );
      }
      return 0;
    });
  $: easyXp = roadmap.easy.reduce((sum, item) => sum + item.masteryXpRemaining, 0);
  $: relicXp = roadmap.relics.reduce((sum, item) => sum + item.masteryXpRemaining, 0);
  $: buyableXp = roadmap.platinum.reduce((sum, item) => sum + item.masteryXpRemaining, 0);
  $: easyPotentialRank = easyMasteryPotentialRank(currentRank, totalXp, easyXp);
  $: bestValue = roadmap.platinum[0] ?? null;

  function selectMode(value: string): void {
    mode = value as RoadmapMode;
    writeStorage(MODE_TAB_KEY, mode);
    sort = "recommended";
  }

  function formatProbability(value: number | null): string {
    return `${((value ?? 0) * 100).toFixed(2).replace(/\.00$/, "")}%`;
  }

  function ownedPartTypes(item: MasteryRoadmapRecommendation): number {
    return item.components.filter(
      (component) =>
        component.owned || (component.ownedCount ?? 0) >= Math.max(1, component.itemCount ?? 1),
    ).length;
  }
</script>

<div class="grid gap-3" data-tour="mastery-roadmap">
  <div class="grid gap-2 min-[900px]:grid-cols-2 min-[1400px]:grid-cols-4">
    <ThemedPanel className="p-3">
      <span class="block text-xs uppercase tracking-[0.08em] text-text-muted"
        >{$tr("mastery.roadmap.easyMastery")}</span
      >
      <strong class="font-display text-2xl text-success"
        >{$tr("mastery.roadmap.xpAmount", { amount: easyXp.toLocaleString($locale) })}</strong
      >
      <span class="block text-xs text-text-secondary">
        {#if easyPotentialRank != null}{$tr("mastery.roadmap.easyDescWithRank", {
            count: roadmap.easy.length,
            rank: easyPotentialRank,
          })}{:else}{$tr("mastery.roadmap.easyDesc", { count: roadmap.easy.length })}{/if}
      </span>
    </ThemedPanel>
    <ThemedPanel className="p-3">
      <span class="block text-xs uppercase tracking-[0.08em] text-text-muted"
        >{$tr("mastery.roadmap.accessRelics")}</span
      >
      <strong class="font-display text-2xl text-accent"
        >{$tr("mastery.roadmap.xpAmount", { amount: relicXp.toLocaleString($locale) })}</strong
      >
      <span class="block text-xs text-text-secondary">
        {$tr("mastery.roadmap.relicsDesc", { count: roadmap.relics.length })}
      </span>
    </ThemedPanel>
    <ThemedPanel className="p-3">
      <span class="block text-xs uppercase tracking-[0.08em] text-text-muted"
        >{$tr("mastery.roadmap.buyableMastery")}</span
      >
      <strong class="font-display text-2xl text-info"
        >{$tr("mastery.roadmap.xpAmount", { amount: buyableXp.toLocaleString($locale) })}</strong
      >
      <span class="block text-xs text-text-secondary">
        {$tr("mastery.roadmap.buyableDesc", { count: roadmap.platinum.length })}
      </span>
    </ThemedPanel>
    <ThemedPanel className="p-3">
      <span class="block text-xs uppercase tracking-[0.08em] text-text-muted"
        >{$tr("mastery.roadmap.bestValue")}</span
      >
      {#if bestValue}
        <strong class="block truncate font-display text-lg text-accent"
          >{itemLabel(bestValue)}</strong
        >
        <!-- Gated on a real price: "at 0p" would read as a genuine quote. -->
        {#if bestValue.estimatedCost != null}
          <span class="block text-xs text-text-secondary">
            {$tr("mastery.roadmap.xpPerPlatAt", {
              xp: Math.round(bestValue.xpPerPlatinum ?? 0).toLocaleString($locale),
              cost: bestValue.estimatedCost,
            })}
          </span>
        {/if}
      {:else}
        <strong class="font-display text-lg text-text-muted"
          >{$tr("mastery.roadmap.noPricedItems")}</strong
        >
      {/if}
    </ThemedPanel>
  </div>

  <div class="view-sticky-filters grid gap-2">
    <div class="flex flex-wrap items-end border-b border-border-subtle">
      <HeaderTabs options={MODE_TABS} activeKey={mode} onSelect={selectMode} />
      <div class="ml-auto flex flex-wrap items-center justify-end gap-2 pb-2">
        <SearchBox value={search} onValueChange={(value) => (search = value)} />
        <label class="shared-filter-sort">
          <span>{$tr("common.category")}</span>
          <select class="shared-filter-select" bind:value={category}>
            <option value="all">{$tr("common.all")}</option>
            {#each categories as option}
              <option value={option}>{option}</option>
            {/each}
          </select>
        </label>
        <label class="shared-filter-sort">
          <span>{$tr("common.sort")}</span>
          <select class="shared-filter-select" bind:value={sort}>
            <option value="recommended">{$tr("common.recommended")}</option>
            <option value="xp">{$tr("mastery.roadmap.sortMostXp")}</option>
            {#if mode === "platinum"}<option value="price"
                >{$tr("mastery.roadmap.sortLowestPrice")}</option
              >{/if}
          </select>
        </label>
      </div>
    </div>
  </div>

  {#if visible.length === 0}
    <div class="empty-state"><p>{$tr("mastery.roadmap.noItemsMatch")}</p></div>
  {:else}
    <div class="grid gap-2 min-[900px]:grid-cols-2">
      {#each visible as item (`${item.uniqueName || item.internalName}-${item.access}`)}
        <button
          type="button"
          class="grid min-w-0 grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-2.5 text-left text-inherit transition-[border-color,background-color] hover:border-accent-dim hover:bg-bg-hover"
          on:click={() => onOpen(item)}
        >
          <span
            class="flex h-16 w-16 items-center justify-center overflow-hidden rounded-[var(--radius-md)] bg-surface-card"
          >
            <ItemImage src={item.imageUrl} alt={itemLabel(item)} auditKey={item.name} />
          </span>
          <span class="min-w-0">
            <strong class="block truncate font-display text-base text-text-primary"
              >{itemLabel(item)}</strong
            >
            {#if item.access === "relics"}
              <span
                class="block text-xs font-semibold text-success"
                title={$tr("mastery.roadmap.relicChanceTitle")}
              >
                {item.relevantRelicCount === 1
                  ? $tr("mastery.roadmap.chanceWithOneRelic", {
                      prob: formatProbability(item.relicProbability),
                      count: item.relevantRelicCount,
                    })
                  : $tr("mastery.roadmap.chanceWithRelics", {
                      prob: formatProbability(item.relicProbability),
                      count: item.relevantRelicCount,
                    })}
              </span>
              <span class="mt-1 block text-xs text-text-muted">
                {$tr("mastery.roadmap.partsOwnedLine", {
                  category: item.category,
                  owned: ownedPartTypes(item),
                  total: item.components.length,
                })}
              </span>
            {:else}
              <span class="block text-xs text-text-secondary">
                {$tr("mastery.roadmap.categoryAccessLine", {
                  category: item.category,
                  access: ACCESS_LABELS[item.access],
                })}
              </span>
              <span class="mt-1 block text-xs text-text-muted">
                {#if item.access === "owned"}{$tr("mastery.roadmap.levelLine", {
                    rank: item.rank,
                    maxRank: item.maxRank,
                  })}{:else if item.components.length > 0}{$tr("mastery.roadmap.partsOwnedShort", {
                    owned: ownedPartTypes(item),
                    total: item.components.length,
                  })}{:else}{$tr("mastery.notOwned")}{/if}
              </span>
            {/if}
          </span>
          <span class="grid justify-items-end gap-1 text-right">
            <strong class="font-display text-base text-accent"
              >{$tr("mastery.roadmap.xpAmount", {
                amount: item.masteryXpRemaining.toLocaleString($locale),
              })}</strong
            >
            {#if item.estimatedCost != null && item.access === "platinum"}
              <span class="text-sm font-semibold text-info">{item.estimatedCost}p</span>
              <span class="text-[0.68rem] text-text-muted">
                {$tr("mastery.roadmap.xpPerPlat", {
                  xp: Math.round(item.xpPerPlatinum ?? 0).toLocaleString($locale),
                })}
              </span>
            {/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>
