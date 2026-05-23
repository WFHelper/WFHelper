<script lang="ts">
  import ViewPerfMark from "../components/ViewPerfMark.svelte";
  import { onMount, onDestroy } from "svelte";
  import {
    itemDb,
    componentOwnership,
    foundryData,
    parsedItems,
  } from "../stores/data.js";
  import { masteryData } from "../stores/mastery.js";
  import { activeItem } from "../stores/modals.js";
  import { formatTimeRemaining, formatNumber } from "../lib/format.js";
  import { buildParsedItemFromDb } from "../lib/parsedItemFromDb.js";
  import ItemImage from "../components/ItemImage.svelte";
  import SearchBox from "../components/SearchBox.svelte";
  import SortArrow from "../components/SortArrow.svelte";
  import type {
    FoundryBuildingItem,
    FoundryRecipeItem,
    MasteryStatus,
    RecipeIngredient,
  } from "../types/inventory.js";

  const CREDITS_ICON = new URL("../../assets/Bounties/Credits.png", import.meta.url).href;

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
    /** Normalised category (Warframe, Primary, …, Misc). */
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

  const SORT_KEY = "foundryView.sort";
  const SORT_DIR_KEY = "foundryView.sortDir";
  const FILTER_KEY = "foundryView.filter";

  type SortDir = "asc" | "desc";

  function loadString<T extends string>(key: string, allowed: T[], fallback: T): T {
    const raw = (typeof localStorage !== "undefined" && localStorage.getItem(key)) || "";
    return (allowed as string[]).includes(raw) ? (raw as T) : fallback;
  }

  let sortMode: SortMode = loadString<SortMode>(SORT_KEY, ["name", "time", "count"], "count");
  let sortDir: SortDir = loadString<SortDir>(SORT_DIR_KEY, ["asc", "desc"], "desc");
  let activeFilter: FilterKey =
    ((typeof localStorage !== "undefined" && localStorage.getItem(FILTER_KEY)) as FilterKey) || "all";
  let query = "";

  $: try { localStorage.setItem(SORT_KEY, sortMode); } catch { /* best effort */ }
  $: try { localStorage.setItem(SORT_DIR_KEY, sortDir); } catch { /* best effort */ }
  $: try { localStorage.setItem(FILTER_KEY, activeFilter); } catch { /* best effort */ }

  function toggleSortDir(): void {
    sortDir = sortDir === "asc" ? "desc" : "asc";
  }

  // 1 s tick so the "claimable" flip and countdown labels update live.
  let nowMs = Date.now();
  let tick: ReturnType<typeof setInterval> | null = null;
  onMount(() => { tick = setInterval(() => { nowMs = Date.now(); }, 1000); });
  onDestroy(() => { if (tick) clearInterval(tick); });

  $: foundry = $foundryData;

  /**
   * parseFoundry output is already normalised to our 10 foundry categories,
   * so just pass the value through — no local remapping needed.
   */
  function normaliseCategory(cat: string): string {
    return (cat || "").trim() || "Misc";
  }

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

  function toEntryFromBuilding(b: FoundryBuildingItem): FoundryEntry {
    return {
      source: "building",
      name: b.name,
      imageUrl: b.imageUrl,
      uniqueName: b.uniqueName,
      productUniqueName: b.productUniqueName,
      category: normaliseCategory(b.category),
      ingredients: b.ingredients,
      buildPrice: b.buildPrice,
      buildTime: 0,
      count: 0,
      endDate: b.endDate,
      isIngredient: false,
    };
  }
  function toEntryFromRecipe(r: FoundryRecipeItem): FoundryEntry {
    return {
      source: "blueprint",
      name: r.name,
      imageUrl: r.imageUrl,
      uniqueName: r.uniqueName,
      productUniqueName: r.productUniqueName,
      category: normaliseCategory(r.category),
      ingredients: r.ingredients,
      buildPrice: r.buildPrice,
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
   *  category right now — matches the in-game Foundry which always displays
   *  the full bar. */
  $: categoriesPresent = CATEGORY_ORDER;

  /** Lookup: ingredient uniqueName → owned count (tracks componentOwnership store). */
  $: ownedMap = $componentOwnership;
  $: productOwnedLookup = (() => {
    const byUniqueName = new Map<string, number>();

    for (const item of $parsedItems) {
      const amount = item.amount ?? 0;
      if (amount <= 0) continue;

      if (item.internalName) {
        byUniqueName.set(item.internalName, (byUniqueName.get(item.internalName) ?? 0) + amount);
      }
    }

    return byUniqueName;
  })();
  $: masteryLookup = (() => {
    const byUniqueName = new Map<string, MasteryStatus>();
    const byName = new Map<string, MasteryStatus>();

    for (const item of $masteryData?.items ?? []) {
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
  })();

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

  $: q = query.trim().toLowerCase();

  $: decorated = allEntries.map((e) => ({ e, status: statusOf(e, nowMs) }));

  function passesActiveFilter(e: FoundryEntry, s: ItemStatus): boolean {
    if (activeFilter === "all") return true;
    if (activeFilter === "status:in-progress") return s === "in-progress" || s === "claimable";
    if (activeFilter === "status:ready") return s === "ready-to-build";
    if (activeFilter.startsWith("cat:")) return e.category === activeFilter.slice(4);
    return true;
  }

  $: filtered = decorated.filter(({ e, status }) => {
    if (!passesActiveFilter(e, status)) return false;
    if (q && !e.name.toLowerCase().includes(q)) return false;
    return true;
  });

  /** Default ordering across statuses: claimable → in-progress → ready → not-ready. */
  const STATUS_RANK: Record<ItemStatus, number> = {
    "claimable": 0,
    "in-progress": 1,
    "ready-to-build": 2,
    "not-ready": 3,
  };

  $: sorted = (() => {
    const copy = [...filtered];
    const dirMul = sortDir === "asc" ? 1 : -1;
    copy.sort((a, b) => {
      const rankDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (rankDiff !== 0) return rankDiff;
      if (sortMode === "name") return a.e.name.localeCompare(b.e.name) * dirMul;
      if (sortMode === "count") {
        if (a.e.source === "blueprint" && b.e.source === "blueprint") {
          return (b.e.count - a.e.count || a.e.name.localeCompare(b.e.name)) * dirMul;
        }
      }
      if (sortMode === "time" || sortMode === "count") {
        if (a.e.source === "building" && b.e.source === "building") {
          const ta = a.e.endDate ? Math.max(a.e.endDate.getTime() - nowMs, 0) : Infinity;
          const tb = b.e.endDate ? Math.max(b.e.endDate.getTime() - nowMs, 0) : Infinity;
          return (ta - tb) * dirMul;
        }
      }
      return a.e.name.localeCompare(b.e.name) * dirMul;
    });
    return copy;
  })();

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

  function ingredientName(un: string): string {
    return $itemDb[un]?.name ?? un.split("/").pop() ?? un;
  }
  function ingredientImage(un: string): string | null {
    return ($itemDb[un]?.imageUrl as string | null) ?? null;
  }

  /** Format a build time in seconds into a compact d/h/m label. */
  function formatBuildTime(seconds: number): string {
    if (!seconds || seconds <= 0) return "";
    const totalMinutes = Math.round(seconds / 60);
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const mins = totalMinutes % 60;
    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    return `${mins}m`;
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
<ViewPerfMark name="foundry" />
  <div class="view-header">
    <h2>Foundry</h2>
  </div>

  <!-- Search + sort toolbar -->
  <div class="shared-filter-bar shared-filter-bar-inline mb-3">
    <div class="view-controls shared-filter-controls">
      <SearchBox bind:value={query} placeholder="Search..." class="shared-filter-search" />
      <div class="shared-sort-controls">
        <button
          type="button"
          class="shared-sort-direction"
          on:click={toggleSortDir}
          title="Sort direction"
          aria-label={sortDir === "asc" ? "Sort ascending" : "Sort descending"}
        >
          <SortArrow asc={sortDir === "asc"} />
        </button>
        <label class="shared-filter-sort">
          <span>Sort</span>
          <select class="shared-filter-select" bind:value={sortMode}>
            <option value="count">Count</option>
            <option value="time">Time</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>
    </div>
  </div>

  <!-- Unified filter row: All / status / categories -->
  <div class="filter-tabs mb-3">
    <button class="filter-tab" class:active={activeFilter === "all"} on:click={() => (activeFilter = "all")}>All</button>
    <button class="filter-tab" class:active={activeFilter === "status:in-progress"} on:click={() => (activeFilter = "status:in-progress")}>In Progress</button>
    <button class="filter-tab" class:active={activeFilter === "status:ready"} on:click={() => (activeFilter = "status:ready")}>Ready to Build</button>
    {#each categoriesPresent as cat (cat)}
      {@const key = `cat:${cat}` as FilterKey}
      <button class="filter-tab" class:active={activeFilter === key} on:click={() => (activeFilter = key)}>{cat}</button>
    {/each}
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
          status === "ready-to-build" ? "border-[rgba(74,222,128,0.35)]" :
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
              <span class="font-display font-semibold text-sm text-text-primary truncate uppercase tracking-wide">
                {item.name}{#if item.source === "blueprint"}<span class="ml-2 text-accent font-bold">×{item.count}</span>{/if}
              </span>
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-display text-[0.7rem] font-bold tracking-wider {statusText}">
                  {#if status === "in-progress" && item.endDate}
                    {formatTimeRemaining(item.endDate)}
                  {:else}
                    {statusLabel(status)}
                  {/if}
                </span>
                {#if item.source === "blueprint" && item.isIngredient}
                  <span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.62rem] font-display font-bold uppercase tracking-[0.08em] border-border bg-white/[0.04] text-text-muted">
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

          <!-- Ingredient grid — slots stay the same (2 cols); icon/text inside scale up when few ingredients. -->
          {#if item.ingredients.length > 0}
            {@const fewIng = item.ingredients.length <= 2}
            <div class="grid grid-cols-2 gap-x-4 gap-y-1.5 pl-1">
              {#each item.ingredients as ing, ingIdx (`${ing.uniqueName}:${ingIdx}`)}
                {@const owned = ownedMap.get(ing.uniqueName) ?? 0}
                {@const ok = owned >= ing.count}
                <div class="flex items-center gap-2 min-w-0 {fewIng ? 'text-[1.1rem]' : 'text-[0.95rem]'}" title={ingredientName(ing.uniqueName)}>
                  <div class="shrink-0 flex items-center justify-center {fewIng ? 'h-14 w-14' : 'h-10 w-10'}">
                    <ItemImage src={ingredientImage(ing.uniqueName)} alt={ingredientName(ing.uniqueName)} cls={fewIng ? 'max-h-14 max-w-14 object-contain' : 'max-h-10 max-w-10 object-contain'} />
                  </div>
                  <span class="truncate {ok ? 'text-text-secondary' : 'text-text-muted'}">
                    {formatNumber(owned)}/{formatNumber(ing.count)}
                  </span>
                  <span class="shrink-0 leading-none {fewIng ? 'text-xl' : 'text-base'} {ok ? 'text-success' : 'text-danger'}" aria-hidden="true">
                    {ok ? '✓' : '✗'}
                  </span>
                </div>
              {/each}
            </div>
          {/if}

          <div class="mt-auto flex items-center justify-between gap-3 pt-2 border-t border-border text-[0.9rem] text-text-secondary">
            <div class="flex items-center gap-3">
              {#if item.buildPrice > 0}
                <span class="flex items-center gap-1.5 font-display font-semibold tracking-wide text-accent">
                  <img src={CREDITS_ICON} alt="Credits" class="h-5 w-5 object-contain" />
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
                class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.62rem] font-display font-bold uppercase tracking-[0.08em] {ownedCount > 0
                  ? 'border-[rgba(74,222,128,0.3)] bg-[rgba(16,185,129,0.12)] text-success'
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
                class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.62rem] font-display font-bold uppercase tracking-[0.08em] {masteryState === 'mastered'
                  ? 'border-[rgba(74,222,128,0.3)] bg-[rgba(16,185,129,0.12)] text-success'
                  : masteryState === 'progress'
                    ? 'border-[rgba(251,191,36,0.28)] bg-[rgba(251,191,36,0.12)] text-warning'
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
