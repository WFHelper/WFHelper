<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import {
    itemDb,
    componentOwnership,
    foundryData,
    parsedItems,
  } from "../stores/data.js";
  import { masteryData } from "../stores/mastery.js";
  import { activeItem } from "../stores/modals.js";
  import { formatBuildTime, formatTimeRemaining, formatNumber } from "../lib/format.js";
  import { compareSharedFilterSort, matchesSharedFilters } from "../lib/filters.js";
  import { collectRecipeMaterialNames } from "../lib/craftingTree.js";
  import { buildParsedItemFromDb } from "../lib/parsedItemFromDb.js";
  import { CREDITS_ICON_URL } from "../lib/assetUrls.js";
  import { clockStore } from "../lib/timers.js";
  import { persistedString } from "../lib/persistence.js";
  import { sharedFilters } from "../stores/filters.js";
  import ItemImage from "../components/ItemImage.svelte";
  import HeaderTabs from "../components/HeaderTabs.svelte";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import type {
    FoundryBuildingItem,
    FoundryRecipeItem,
    MasteryStatus,
    RecipeIngredient,
  } from "../types/inventory.js";

  type SortMode = "name" | "time" | "count";
  /** Unified status for sorting + badges. Order here defines default sort. */
  type ItemStatus = "claimable" | "in-progress" | "ready-to-build" | "not-ready";
  /** One combined filter (merged status + category). */
  type FilterKey =
    | "all"
    | "status:in-progress"
    | "status:ready"
    | `cat:${string}`;

  /** Unified foundry entry: building (PendingRecipes) or blueprint (Recipes). */
  interface FoundryEntry {
    source: "building" | "blueprint";
    name: string;
    imageUrl: string | null;
    uniqueName: string | null;
    productUniqueName: string | null;
    /** Normalised category (Warframe, Primary, ..., Misc). */
    category: string;
    ingredients: RecipeIngredient[];
    buildPrice: number;
    buildTime: number;
    /** Blueprint count (copies owned). Only meaningful when source === "blueprint". */
    count: number;
    /** End time for pending recipes; null otherwise. */
    endDate: Date | null;
    /** True if the blueprint's product is itself consumed in another recipe. */
    isIngredient: boolean;
  }

  const FILTER_KEY = "foundryView.filter";

  $: foundry = $foundryData;

  /** Canonical display order for the category chips in the single filter row. */
  const CATEGORY_ORDER = [
    "Warframe",
    "Primary",
    "Secondary",
    "Melee",
    "Archwing",
    "Companion",
    "Appearance",
    "Gear",
    "Modular",
    "Misc",
  ];

  const foundryFilterTabs = [
    { key: "all", label: "All" },
    { key: "status:in-progress", label: "In Progress" },
    { key: "status:ready", label: "Ready to Build" },
    ...CATEGORY_ORDER.map((cat) => ({ key: `cat:${cat}`, label: cat })),
  ];
  const activeFilter = persistedString<FilterKey>(
    FILTER_KEY,
    foundryFilterTabs.map((tab) => tab.key as FilterKey),
    "all",
  );
  const foundryFilters = sharedFilters("foundry");
  const foundrySortOptions: Array<[SortMode, string]> = [
    ["count", "Count"],
    ["time", "Time"],
    ["name", "Name"],
  ];
  const nowClock = clockStore(1000);
  $: nowMs = $nowClock;

  function commonEntryFields(item: FoundryBuildingItem | FoundryRecipeItem) {
    return {
      name: item.name,
      imageUrl: item.imageUrl,
      uniqueName: item.uniqueName,
      productUniqueName: item.productUniqueName,
      category: (item.category || "").trim() || "Misc",
      ingredients: item.ingredients,
      buildPrice: item.buildPrice,
    };
  }
  function toEntryFromBuilding(b: FoundryBuildingItem): FoundryEntry {
    return {
      ...commonEntryFields(b),
      source: "building",
      buildTime: 0,
      count: 0,
      endDate: b.endDate,
      isIngredient: false,
    };
  }
  function toEntryFromRecipe(r: FoundryRecipeItem): FoundryEntry {
    return {
      ...commonEntryFields(r),
      source: "blueprint",
      buildTime: r.buildTime,
      count: r.count,
      endDate: null,
      isIngredient: r.isIngredient ?? false,
    };
  }

  $: allEntries = [
    ...foundry.building.map(toEntryFromBuilding),
    ...foundry.recipes.map(toEntryFromRecipe),
  ];

  /** All category tabs, always shown regardless of whether items exist in that
   *  category right now - matches the in-game Foundry which always displays
   *  the full bar. */
  /** Lookup: ingredient uniqueName -> owned count (tracks componentOwnership store). */
  $: ownedMap = $componentOwnership;
  function buildProductOwnedLookup(items: typeof $parsedItems): SvelteMap<string, number> {
    const byUniqueName = new SvelteMap<string, number>();

    for (const item of items) {
      const amount = item.amount ?? 0;
      if (amount <= 0) continue;

      if (item.internalName) {
        byUniqueName.set(item.internalName, (byUniqueName.get(item.internalName) ?? 0) + amount);
      }
    }

    return byUniqueName;
  }

  function buildMasteryLookup(data: typeof $masteryData): {
    byUniqueName: SvelteMap<string, MasteryStatus>;
    byName: SvelteMap<string, MasteryStatus>;
  } {
    const byUniqueName = new SvelteMap<string, MasteryStatus>();
    const byName = new SvelteMap<string, MasteryStatus>();

    for (const item of data?.items ?? []) {
      const status = item.status;
      if (!status) continue;

      const uniqueName = item.uniqueName || item.internalName;
      if (uniqueName && !byUniqueName.has(uniqueName)) {
        byUniqueName.set(uniqueName, status);
      }

      const nameKey = normalizeLookupKey(item.name);
      if (nameKey && !byName.has(nameKey)) {
        byName.set(nameKey, status);
      }
    }

    return { byUniqueName, byName };
  }

  $: productOwnedLookup = buildProductOwnedLookup($parsedItems);
  $: masteryLookup = buildMasteryLookup($masteryData);

  function statusOf(entry: FoundryEntry, now: number): ItemStatus {
    if (entry.source === "building") {
      if (entry.endDate && entry.endDate.getTime() <= now) return "claimable";
      return "in-progress";
    }
    if (!entry.ingredients.length) return "not-ready";
    const allOwned = entry.ingredients.every(
      (ing) => (ownedMap.get(ing.uniqueName) ?? 0) >= ing.count,
    );
    return allOwned ? "ready-to-build" : "not-ready";
  }

  function normalizeLookupKey(value: string | null | undefined): string {
    return (value || "").trim().toLowerCase();
  }

  function ownedCountFor(entry: FoundryEntry): number {
    if (!entry.productUniqueName) return 0;
    return productOwnedLookup.get(entry.productUniqueName) ?? 0;
  }

  function masteryStateFor(entry: FoundryEntry): MasteryStatus | "unknown" {
    if (!$masteryData) return "unknown";

    if (entry.productUniqueName) {
      const direct = masteryLookup.byUniqueName.get(entry.productUniqueName);
      if (direct) return direct;
    }

    return masteryLookup.byName.get(normalizeLookupKey(entry.name)) ?? "missing";
  }

  function masteryLabelFor(state: MasteryStatus | "unknown"): string {
    switch (state) {
      case "mastered":
        return "Mastered";
      case "progress":
        return "In Progress";
      case "missing":
        return "Not Mastered";
      default:
        return "Mastery N/A";
    }
  }

  $: decorated = allEntries.map((e) => ({ e, status: statusOf(e, nowMs) }));

  // Search matches materials anywhere in the crafting tree: "rubedo" finds every
  // entry whose recipe - or a sub-part's recipe - consumes rubedo.
  function materialKeywords(productUniqueName: string | null | undefined): string[] {
    if (!productUniqueName) return [];
    return collectRecipeMaterialNames(productUniqueName, $itemDb);
  }

  function filterableFoundryEntry(row: { e: FoundryEntry; status: ItemStatus }): {
    name: string;
    category: string;
    keywords: string[];
    count: number | null;
    time: number | null;
    isPrime: boolean;
    status: MasteryStatus | "unknown";
    vaulted: boolean;
  } {
    const db = row.e.productUniqueName ? $itemDb[row.e.productUniqueName] : null;
    return {
      name: row.e.name,
      category: row.e.category,
      keywords: materialKeywords(row.e.productUniqueName),
      count: row.e.source === "blueprint" ? row.e.count : null,
      time:
        row.e.source === "building" && row.e.endDate
          ? Math.max(row.e.endDate.getTime() - nowMs, 0)
          : null,
      isPrime: db?.isPrime === true || /\bprime\b/i.test(row.e.name),
      status: masteryStateFor(row.e),
      vaulted: db?.vaulted === true,
    };
  }

  function passesActiveFilter(e: FoundryEntry, s: ItemStatus): boolean {
    if ($activeFilter === "all") return true;
    if ($activeFilter === "status:in-progress") return s === "in-progress" || s === "claimable";
    if ($activeFilter === "status:ready") return s === "ready-to-build";
    if ($activeFilter.startsWith("cat:")) return e.category === $activeFilter.slice(4);
    return true;
  }

  $: filtered = decorated.filter(({ e, status }) => {
    if (!passesActiveFilter(e, status)) return false;
    return matchesSharedFilters(filterableFoundryEntry({ e, status }), $foundryFilters);
  });

  /** Default ordering across statuses: claimable -> in-progress -> ready -> not-ready. */
  const STATUS_RANK: Record<ItemStatus, number> = {
    "claimable": 0,
    "in-progress": 1,
    "ready-to-build": 2,
    "not-ready": 3,
  };

  function sortFoundryRows(
    rows: typeof filtered,
    sharedFilters: typeof $foundryFilters,
  ): typeof filtered {
    return [...rows].sort((a, b) => {
      const rankDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (rankDiff !== 0) return rankDiff;
      return compareSharedFilterSort(
        filterableFoundryEntry(a),
        filterableFoundryEntry(b),
        sharedFilters,
      );
    });
  }

  $: sorted = sortFoundryRows(filtered, $foundryFilters);

  /** Build a ParsedItem from an itemDb uniqueName and open the ItemDetailModal. */
  function openItem(uniqueName: string | null): void {
    if (!uniqueName) return;
    const db = $itemDb[uniqueName];
    if (!db) return;
    activeItem.set(buildParsedItemFromDb(uniqueName, db, $componentOwnership));
  }

  function cardKey(entry: FoundryEntry, i: number): string {
    return `${entry.source}:${entry.uniqueName ?? entry.name}:${i}`;
  }

  function setActiveFilter(key: string): void {
    activeFilter.set(key as FilterKey);
  }

  function ingredientName(un: string): string {
    return $itemDb[un]?.name ?? un.split("/").pop() ?? un;
  }
  function ingredientImage(un: string): string | null {
    return ($itemDb[un]?.imageUrl as string | null) ?? null;
  }

  function statusLabel(s: ItemStatus): string {
    switch (s) {
      case "claimable": return "READY";
      case "in-progress": return "BUILDING";
      case "ready-to-build": return "READY TO BUILD";
      case "not-ready": return "MISSING PARTS";
    }
  }
</script>

<section class="view active">
  <div class="view-header">
    <h2>Foundry</h2>
  </div>

  <!-- Search + sort toolbar -->
  <div class="mb-3">
    <SharedFilterBar
      scope="foundry"
      singleLine
      showAdvanced={false}
      basicVariant="full"
      sortOptions={foundrySortOptions}
    />
  </div>

  <!-- Unified filter row: All / status / categories -->
  <div class="mb-3 flex items-end border-b border-white/[0.09]">
    <HeaderTabs options={foundryFilterTabs} activeKey={$activeFilter} onSelect={setActiveFilter} />
  </div>

  <!-- Unified grid -->
  <div class="grid grid-cols-[repeat(auto-fill,minmax(380px,1fr))] gap-3">
    {#if sorted.length === 0}
      <div class="empty-state col-span-full">
        <p>No foundry items match your filters</p>
      </div>
    {:else}
      {#each sorted as { e: item, status }, i (cardKey(item, i))}
        {@const ownedCount = ownedCountFor(item)}
        {@const masteryState = masteryStateFor(item)}
        {@const statusBorder =
          status === "claimable" ? "border-accent/70" :
          status === "in-progress" ? "border-[rgba(80,160,255,0.35)]" :
          status === "ready-to-build" ? "border-success/35" :
          "border-border"}
        {@const statusText =
          status === "claimable" ? "text-accent" :
          status === "in-progress" ? "text-[#6ca8ff]" :
          status === "ready-to-build" ? "text-success" :
          "text-text-muted"}
        <button
          type="button"
          class="resource-card flex flex-col gap-2 px-3 py-2.5 text-left cursor-pointer hover:bg-white/5 transition-colors disabled:cursor-default {statusBorder}"
          on:click={() => openItem(item.productUniqueName)}
          disabled={!item.productUniqueName}
        >
          <!-- Header: item icon + name (+ ×count) + status line -->
          <div class="flex items-center gap-3 min-w-0">
            <div class="h-14 w-14 shrink-0 flex items-center justify-center">
              <ItemImage src={item.imageUrl} alt={item.name} cls="max-h-14 max-w-14 object-contain" />
            </div>
            <div class="flex-1 min-w-0 flex flex-col gap-1">
              <span class="font-display font-semibold text-sm text-text-primary truncate">
                {item.name}{#if item.source === "blueprint"}<span class="ml-2 text-accent font-bold">×{item.count}</span>{/if}
              </span>
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-display text-xs font-bold tracking-wider {statusText}">
                  {#if status === "in-progress" && item.endDate}
                    {formatTimeRemaining(item.endDate)}
                  {:else}
                    {statusLabel(status)}
                  {/if}
                </span>
                {#if item.source === "blueprint" && item.isIngredient}
                  <span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-display font-bold uppercase tracking-[0.08em] border-border bg-white/[0.04] text-text-muted">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" class="h-3.5 w-3.5 shrink-0">
                      <path d="M3 4.5h4.5v4.5H3z" />
                      <path d="M8.5 2h4.5v4.5H8.5z" />
                      <path d="M8.5 9h4.5v4.5H8.5z" />
                      <path d="M7.5 6.75h1M10.75 6.5v2.5" />
                    </svg>
                    <span>Used in crafting</span>
                  </span>
                {/if}
              </div>
            </div>
          </div>

          <!-- Ingredient grid - slots stay the same (2 cols); icon/text inside scale up when few ingredients. -->
          {#if item.ingredients.length > 0}
            {@const fewIng = item.ingredients.length <= 2}
            <div class="grid grid-cols-2 gap-x-4 gap-y-1.5 pl-1">
              {#each item.ingredients as ing, ingIdx (`${ing.uniqueName}:${ingIdx}`)}
                {@const owned = ownedMap.get(ing.uniqueName) ?? 0}
                {@const ok = owned >= ing.count}
                <div class="flex items-center gap-2 min-w-0 {fewIng ? 'text-lg' : 'text-base'}" title={ingredientName(ing.uniqueName)}>
                  <div class="shrink-0 flex items-center justify-center {fewIng ? 'h-14 w-14' : 'h-10 w-10'}">
                    <ItemImage src={ingredientImage(ing.uniqueName)} alt={ingredientName(ing.uniqueName)} cls={fewIng ? 'max-h-14 max-w-14 object-contain' : 'max-h-10 max-w-10 object-contain'} />
                  </div>
                  <span class="truncate {ok ? 'text-text-secondary' : 'text-text-muted'}">
                    {formatNumber(owned)}/{formatNumber(ing.count)}
                  </span>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="shrink-0 {fewIng ? 'h-5 w-5' : 'h-4 w-4'} {ok ? 'text-success' : 'text-danger'}"
                    aria-hidden="true"
                  >
                    {#if ok}
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    {:else}
                      <path d="M6 6l12 12M18 6L6 18" />
                    {/if}
                  </svg>
                </div>
              {/each}
            </div>
          {/if}

          <div class="mt-auto flex items-center justify-between gap-3 pt-2 border-t border-border text-sm text-text-secondary">
            <div class="flex items-center gap-3">
              {#if item.buildPrice > 0}
                <span class="flex items-center gap-1.5 font-display font-semibold tracking-wide text-accent">
                  <img src={CREDITS_ICON_URL} alt="Credits" class="h-5 w-5 object-contain" />
                  {formatNumber(item.buildPrice)}
                </span>
              {/if}
              {#if item.source === "blueprint" && item.buildTime > 0}
                <span class="font-display font-semibold tracking-wide text-text-secondary">
                  ⏱ {formatBuildTime(item.buildTime)}
                </span>
              {/if}
              {#if item.source === "blueprint" && item.ingredients.length === 0}
                <span class="text-text-muted italic">No recipe data</span>
              {/if}
            </div>
            <div class="flex items-center justify-end gap-1.5 flex-wrap">
              <span
                class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-display font-bold uppercase tracking-[0.08em] {ownedCount > 0
                  ? 'border-success/30 bg-emerald-500/10 text-success'
                  : 'border-border bg-white/[0.04] text-text-muted'}"
                title={`Owned copies: ${ownedCount}`}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" class="h-3.5 w-3.5 shrink-0">
                  <path d="M2 5.5 8 2l6 3.5v5L8 14l-6-3.5z" />
                  <path d="M2 5.5 8 9l6-3.5" />
                  <path d="M8 9v5" />
                </svg>
                <span>{ownedCount} Owned</span>
              </span>
              <span
                class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-display font-bold uppercase tracking-[0.08em] {masteryState === 'mastered'
                  ? 'border-success/30 bg-emerald-500/10 text-success'
                  : masteryState === 'progress'
                    ? 'border-warning/30 bg-warning/10 text-warning'
                    : 'border-border bg-white/[0.04] text-text-muted'}"
                title={masteryLabelFor(masteryState)}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" class="h-3.5 w-3.5 shrink-0">
                  <circle cx="8" cy="6.5" r="3.75" />
                  <path d="m6.35 6.55 1.15 1.15 2.25-2.3" />
                  <path d="M6.1 10.4 5 14l3-1.55L11 14l-1.1-3.6" />
                </svg>
                <span>{masteryLabelFor(masteryState)}</span>
              </span>
            </div>
          </div>
        </button>
      {/each}
    {/if}
  </div>
</section>
