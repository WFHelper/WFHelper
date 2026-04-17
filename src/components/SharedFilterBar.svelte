<script lang="ts">
  import { resetSharedFilters, sharedFilters, updateSharedFilters } from "../stores/filters.js";
  import type {
    FilterScope,
    MasteredFilterMode,
    PrimeFilterMode,
    SharedSortKey,
    SortDirection,
    YesNoFilterMode,
  } from "../types/filters.js";
  import type { PartType } from "../types/inventory.js";

  export let scope: FilterScope;
  export let singleLine = false;
  export let showBasic = true;
  export let showAdvanced = true;
  export let basicVariant: "full" | "quick" = "full";

  const PRIME_OPTIONS: Array<[PrimeFilterMode, string]> = [
    ["all", "All"],
    ["prime", "Prime"],
    ["non_prime", "Non-Prime"],
  ];

  const MASTERED_OPTIONS: Array<[MasteredFilterMode, string]> = [
    ["all", "All"],
    ["mastered", "Mastered"],
    ["not_mastered", "Not Mastered"],
  ];

  const SORT_OPTIONS: Array<[SharedSortKey, string]> = [
    ["name", "Name"],
    ["platinum", "Platinum"],
    ["ducats", "Ducats"],
    ["amount", "Amount"],
    ["ducatonator", "Ducatonator"],
    ["complete_sets", "Complete (Sets)"],
  ];

  const YES_NO_OPTIONS: Array<[Exclude<YesNoFilterMode, "all">, string]> = [
    ["yes", "Yes"],
    ["no", "No"],
  ];

  const MIN_PLAT_OPTIONS: Array<[0 | 5 | 10 | 15, string]> = [
    [0, "Any"],
    [5, "5"],
    [10, "10"],
    [15, "15"],
  ];

  $: scopeStore = sharedFilters(scope);
  $: state = $scopeStore;
  $: isInventoryScope = scope === "inventory";

  function setSearch(value: string): void {
    updateSharedFilters(scope, { search: value });
  }

  function setPrimeMode(mode: PrimeFilterMode): void {
    updateSharedFilters(scope, { primeMode: mode });
  }

  function setMasteredMode(mode: MasteredFilterMode): void {
    updateSharedFilters(scope, { masteredMode: mode });
  }

  function setSortBy(sortBy: SharedSortKey): void {
    updateSharedFilters(scope, { sortBy });
  }

  function toggleSortDirection(): void {
    const next: SortDirection = state.sortDirection === "asc" ? "desc" : "asc";
    updateSharedFilters(scope, { sortDirection: next });
  }

  function onSortByChange(event: Event): void {
    setSortBy((event.currentTarget as HTMLSelectElement).value as SharedSortKey);
  }

  function onSearchInput(event: Event): void {
    setSearch((event.currentTarget as HTMLInputElement).value);
  }

  function setYesNoFilter(
    key: "orderPlaced" | "favorite" | "setComplete" | "equipped" | "leveledUp",
    value: Exclude<YesNoFilterMode, "all">,
  ): void {
    const next = state[key] === value ? "all" : value;
    updateSharedFilters(scope, { [key]: next });
  }

  function setPartTypeFilter(value: PartType): void {
    const next = state.partType === value ? "all" : value;
    updateSharedFilters(scope, { partType: next });
  }
</script>

<div class="shared-filter-bar" class:shared-filter-bar-inline={singleLine}>
  <div class="view-controls shared-filter-controls">
    {#if showBasic}
      <div class="search-box shared-filter-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          value={state.search}
          on:input={onSearchInput}
          placeholder="Search..."
        />
      </div>

      {#if basicVariant === "full"}
        <div class="filter-tabs" title="Prime filter">
          {#each PRIME_OPTIONS as [mode, label]}
            <button
              class="filter-tab"
              class:active={state.primeMode === mode}
              on:click={() => setPrimeMode(mode)}
            >{label}</button>
          {/each}
        </div>

        <div class="filter-tabs" title="Mastered filter">
          {#each MASTERED_OPTIONS as [mode, label]}
            <button
              class="filter-tab"
              class:active={state.masteredMode === mode}
              on:click={() => setMasteredMode(mode)}
            >{label}</button>
          {/each}
        </div>
      {/if}

      <div class="shared-sort-controls">
        <button
          class="shared-sort-direction"
          on:click={toggleSortDirection}
          title="Sort direction"
          aria-label={state.sortDirection === "asc" ? "Sort direction ascending" : "Sort direction descending"}
        >
          {#if state.sortDirection === "asc"}
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
          <select
            class="shared-filter-select"
            value={state.sortBy}
            on:change={onSortByChange}
          >
            {#each SORT_OPTIONS as [value, label]}
              <option value={value}>{label}</option>
            {/each}
          </select>
        </label>
      </div>
    {/if}

    {#if isInventoryScope && showAdvanced}
      <div class="shared-chip-group" title="Order placed">
        <span class="shared-chip-label">Order placed</span>
        <div class="filter-tabs">
          {#each YES_NO_OPTIONS as [mode, label]}
            <button
              class="filter-tab"
              class:active={state.orderPlaced === mode}
              on:click={() => setYesNoFilter("orderPlaced", mode)}
            >{label}</button>
          {/each}
        </div>
      </div>

      <div class="shared-chip-group" title="Part type">
        <span class="shared-chip-label">Part type</span>
        <div class="filter-tabs">
          <button
            class="filter-tab"
            class:active={state.partType === "normal"}
            on:click={() => setPartTypeFilter("normal")}
          >Normal</button>
          <button
            class="filter-tab"
            class:active={state.partType === "prime"}
            on:click={() => setPartTypeFilter("prime")}
          >Prime</button>
        </div>
      </div>

      <div class="shared-chip-group" title="Favorite">
        <span class="shared-chip-label">Favorite</span>
        <div class="filter-tabs">
          {#each YES_NO_OPTIONS as [mode, label]}
            <button
              class="filter-tab"
              class:active={state.favorite === mode}
              on:click={() => setYesNoFilter("favorite", mode)}
            >{label}</button>
          {/each}
        </div>
      </div>

      <div class="shared-chip-group" title="Minimum platinum">
        <span class="shared-chip-label">Minimum platinum</span>
        <div class="filter-tabs">
          {#each MIN_PLAT_OPTIONS as [value, label]}
            <button
              class="filter-tab"
              class:active={state.minimumPlatinum === value}
              on:click={() => updateSharedFilters(scope, { minimumPlatinum: value })}
            >{label}</button>
          {/each}
        </div>
      </div>

      <div class="shared-chip-group" title="Set complete">
        <span class="shared-chip-label">Set complete</span>
        <div class="filter-tabs">
          {#each YES_NO_OPTIONS as [mode, label]}
            <button
              class="filter-tab"
              class:active={state.setComplete === mode}
              on:click={() => setYesNoFilter("setComplete", mode)}
            >{label}</button>
          {/each}
        </div>
      </div>

      <div class="shared-chip-group" title="Equipped (mods only)">
        <span class="shared-chip-label">Equipped (Mods only)</span>
        <div class="filter-tabs">
          {#each YES_NO_OPTIONS as [mode, label]}
            <button
              class="filter-tab"
              class:active={state.equipped === mode}
              on:click={() => setYesNoFilter("equipped", mode)}
            >{label}</button>
          {/each}
        </div>
      </div>

      <div class="shared-chip-group" title="Leveled up (mods and arcanes)">
        <span class="shared-chip-label">Leveled up (Mods & Arcanes)</span>
        <div class="filter-tabs">
          {#each YES_NO_OPTIONS as [mode, label]}
            <button
              class="filter-tab"
              class:active={state.leveledUp === mode}
              on:click={() => setYesNoFilter("leveledUp", mode)}
            >{label}</button>
          {/each}
        </div>
      </div>
    {/if}

    {#if showAdvanced || basicVariant === "full"}
      <button class="filter-tab" on:click={() => resetSharedFilters(scope)} title="Reset filters">
        Reset
      </button>
    {/if}
  </div>
</div>
