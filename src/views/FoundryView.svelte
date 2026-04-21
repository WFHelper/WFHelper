<script lang="ts">
  import ViewPerfMark from "../components/ViewPerfMark.svelte";
  import { onMount, onDestroy } from "svelte";
  import { itemDb, componentOwnership, enrichComponents, foundryData } from "../stores/data.js";
  import { activeItem } from "../stores/modals.js";
  import { formatTimeRemaining, formatNumber } from "../lib/format.js";
  import ItemImage from "../components/ItemImage.svelte";
  import SearchBox from "../components/SearchBox.svelte";
  import type {
    FoundryBuildingItem,
    FoundryRecipeItem,
    ParsedItem,
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
    const item: ParsedItem = {
      name: db.name || "Unknown",
      internalName: uniqueName,
      category: db.category || "",
      categoryLabel: db.category || "",
      rank: 0,
      maxRank: 0,
      imageUrl: db.imageUrl || null,
      isPrime: db.isPrime || false,
      masteryReq: db.masteryReq || 0,
      vaulted: db.vaulted || false,
      tradable: db.tradable || false,
      description: db.description || "",
      components: enrichComponents(db.components || [], $componentOwnership),
      drops: db.drops || [],
      wikiaUrl: db.wikiaUrl || null,
      uniqueName,
    };
    activeItem.set(item);
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
          {#if sortDir === "asc"}
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M8 3v10" />
              <path d="M5.5 5.5L8 3l2.5 2.5" />
            </svg>
          {:else}
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M8 3v10" />
              <path d="M5.5 10.5L8 13l2.5-2.5" />
            </svg>
          {/if}
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
            <div class="flex-1 min-w-0 flex flex-col gap-0.5">
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
                  <span class="font-display text-[0.6rem] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded bg-white/5 text-text-muted border border-border">
                    Used in crafting
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

          <!-- Footer: credits icon + cost · build time -->
          {#if item.buildPrice > 0 || (item.source === "blueprint" && item.buildTime > 0) || (item.source === "blueprint" && item.ingredients.length === 0)}
            <div class="flex items-center justify-between gap-3 pt-2 border-t border-border text-[0.9rem] text-text-secondary">
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
              </div>
              {#if item.source === "blueprint" && item.ingredients.length === 0}
                <span class="text-text-muted italic">No recipe data</span>
              {/if}
            </div>
          {/if}
        </button>
      {/each}
    {/if}
  </div>
</section>
