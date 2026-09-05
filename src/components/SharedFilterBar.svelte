<script lang="ts">
  import { resetSharedFilters, sharedFilters, updateSharedFilters } from "../stores/filters.js";
  import { filterLayout } from "../stores/filterLayout.js";
  import {
    FILTER_CONTROL_IDS,
    defaultSortDirection,
    isBasicFilterControl,
  } from "../lib/filters.js";
  import { tr } from "../lib/i18n.js";
  import SortControl from "./SortControl.svelte";
  import SearchBox from "./SearchBox.svelte";
  import FilterCustomizePopover from "./FilterCustomizePopover.svelte";
  import type {
    FilterControlId,
    FilterScope,
    FoundryStateFilterMode,
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
  export let sortOptions: Array<[SharedSortKey, string]> | null = null;
  export let showSubsumed = false;
  export let showVaulted = false;
  export let showFoundryState = false;
  export let showBuildableSets = false;

  const ADVANCED_CONTROLS = FILTER_CONTROL_IDS.filter((id) => !isBasicFilterControl(id));

  let customizeOpen = false;
  let customizeAnchor: HTMLElement | null = null;

  $: PRIME_OPTIONS = [
    ["all", $tr("common.all")],
    ["prime", $tr("common.prime")],
    ["non_prime", $tr("filters.nonPrime")],
  ] as Array<[PrimeFilterMode, string]>;

  $: MASTERED_OPTIONS = [
    ["all", $tr("common.all")],
    ["mastered", $tr("common.mastered")],
    ["not_mastered", $tr("common.notMastered")],
  ] as Array<[MasteredFilterMode, string]>;

  $: FOUNDRY_STATE_OPTIONS = [
    ["all", $tr("common.all")],
    ["claimable", $tr("common.ready")],
    ["not_ready", $tr("filters.notReady")],
    ["buildable", $tr("common.canBuild")],
    ...(showBuildableSets
      ? ([["buildable_sets", $tr("filters.buildableSets")]] as Array<
          [FoundryStateFilterMode, string]
        >)
      : []),
  ] as Array<[FoundryStateFilterMode, string]>;

  $: VAULTED_OPTIONS = [
    ["all", $tr("common.all")],
    ["yes", $tr("common.vaulted")],
    ["no", $tr("common.unvaulted")],
  ] as Array<[YesNoFilterMode, string]>;

  $: SUBSUMED_OPTIONS = [
    ["all", $tr("common.all")],
    ["yes", $tr("common.subsumed")],
    ["no", $tr("filters.notSubsumed")],
  ] as Array<[YesNoFilterMode, string]>;

  $: DEFAULT_SORT_OPTIONS = [
    ["name", $tr("common.name")],
    ["platinum", $tr("common.platinum")],
    ["ducats", $tr("common.ducats")],
    ["amount", $tr("filters.amount")],
    ["ducatonator", $tr("filters.ducatonator")],
    ["complete_sets", $tr("filters.completeSets")],
    ["missing_parts", $tr("filters.partsToComplete")],
  ] as Array<[SharedSortKey, string]>;

  $: YES_NO_OPTIONS = [
    ["yes", $tr("filters.yes")],
    ["no", $tr("filters.no")],
  ] as Array<[Exclude<YesNoFilterMode, "all">, string]>;

  $: scopeStore = sharedFilters(scope);
  $: state = $scopeStore;
  $: layoutStore = filterLayout(scope);
  $: layout = $layoutStore;
  $: isInventoryScope = scope === "inventory";
  $: activeSortOptions = sortOptions ?? DEFAULT_SORT_OPTIONS;
  $: if (state && !activeSortOptions.some(([value]) => value === state.sortBy)) {
    const fallback = activeSortOptions[0]?.[0] ?? "name";
    updateSharedFilters(scope, { sortBy: fallback, sortDirection: defaultSortDirection(fallback) });
  }

  // Which controls this bar may render at all. Customization reorders and hides
  // within this set; it can never surface one the props kept off.
  $: fullBasic = showBasic && basicVariant === "full";
  $: enabled = new Set<FilterControlId>([
    ...(showBasic ? (["search", "sort"] as FilterControlId[]) : []),
    ...(fullBasic ? (["prime", "mastery"] as FilterControlId[]) : []),
    ...(fullBasic && showFoundryState ? (["foundryState"] as FilterControlId[]) : []),
    ...(fullBasic && showVaulted ? (["vaulted"] as FilterControlId[]) : []),
    ...(fullBasic && showSubsumed ? (["subsumed"] as FilterControlId[]) : []),
    ...(isInventoryScope && showAdvanced ? ADVANCED_CONTROLS : []),
  ]);
  // Basic before advanced whatever the stored order says: the two are separate rows
  // of the bar, and only inventory renders both (from two bar instances).
  $: shown = layout.order.filter((id) => enabled.has(id) && !layout.hidden.includes(id));
  $: visibleControls = [
    ...shown.filter((id) => isBasicFilterControl(id)),
    ...shown.filter((id) => !isBasicFilterControl(id)),
  ];

  function setSearch(value: string): void {
    updateSharedFilters(scope, { search: value });
  }

  function setPrimeMode(mode: PrimeFilterMode): void {
    updateSharedFilters(scope, { primeMode: mode });
  }

  function setMasteredMode(mode: MasteredFilterMode): void {
    updateSharedFilters(scope, { masteredMode: mode });
  }

  function selectedValue(event: Event): string {
    return (event.currentTarget as HTMLSelectElement).value;
  }

  function setSortBy(value: string): void {
    const sortBy = value as SharedSortKey;
    updateSharedFilters(scope, { sortBy, sortDirection: defaultSortDirection(sortBy) });
  }

  function toggleSortDirection(): void {
    const next: SortDirection = state.sortDirection === "asc" ? "desc" : "asc";
    updateSharedFilters(scope, { sortDirection: next });
  }

  function setYesNoFilter(
    key:
      | "orderPlaced"
      | "mastered"
      | "spares"
      | "vaulted"
      | "favorite"
      | "equipped"
      | "leveledUp"
      | "subsumed",
    value: Exclude<YesNoFilterMode, "all">,
  ): void {
    const next = state[key] === value ? "all" : value;
    updateSharedFilters(scope, { [key]: next });
  }

  function setPartTypeFilter(value: PartType): void {
    const next = state.partType === value ? "all" : value;
    updateSharedFilters(scope, { partType: next });
  }

  function setMinimumPlatinum(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const value = input.valueAsNumber;
    const minimumPlatinum = Number.isFinite(value)
      ? Math.max(0, Math.min(1_000_000, Math.floor(value)))
      : 0;
    updateSharedFilters(scope, { minimumPlatinum });
  }
</script>

<div class="shared-filter-bar" class:shared-filter-bar-inline={singleLine} data-tour="filter-bar">
  <div class="view-controls shared-filter-controls">
    {#each visibleControls as id (id)}
      {#if id === "search"}
        <SearchBox class="shared-filter-search" value={state.search} onValueChange={setSearch} />
      {:else if id === "prime"}
        <div class="shared-select-group">
          <span class="shared-chip-label">{$tr("common.prime")}</span>
          <select
            class="shared-filter-select"
            title={$tr("filters.primeFilterTitle")}
            value={state.primeMode}
            on:change={(event) => setPrimeMode(selectedValue(event) as PrimeFilterMode)}
          >
            {#each PRIME_OPTIONS as [mode, label] (mode)}
              <option value={mode}>{label}</option>
            {/each}
          </select>
        </div>
      {:else if id === "mastery"}
        <div class="shared-select-group">
          <span class="shared-chip-label">{$tr("common.mastery")}</span>
          <select
            class="shared-filter-select"
            title={$tr("filters.masteredFilterTitle")}
            value={state.masteredMode}
            on:change={(event) => setMasteredMode(selectedValue(event) as MasteredFilterMode)}
          >
            {#each MASTERED_OPTIONS as [mode, label] (mode)}
              <option value={mode}>{label}</option>
            {/each}
          </select>
        </div>
      {:else if id === "foundryState"}
        <div class="shared-select-group">
          <span class="shared-chip-label">{$tr("filters.claimLabel")}</span>
          <select
            class="shared-filter-select"
            data-foundry-state
            title={$tr("filters.claimTitle")}
            value={state.foundryState}
            on:change={(event) =>
              updateSharedFilters(scope, {
                foundryState: selectedValue(event) as FoundryStateFilterMode,
              })}
          >
            {#each FOUNDRY_STATE_OPTIONS as [mode, label] (mode)}
              <option value={mode}>{label}</option>
            {/each}
          </select>
        </div>
      {:else if id === "vaulted"}
        <div class="shared-select-group">
          <span class="shared-chip-label">{$tr("common.vaulted")}</span>
          <select
            class="shared-filter-select"
            title={$tr("filters.vaultedTitle")}
            value={state.vaulted}
            on:change={(event) =>
              updateSharedFilters(scope, { vaulted: selectedValue(event) as YesNoFilterMode })}
          >
            {#each VAULTED_OPTIONS as [mode, label] (mode)}
              <option value={mode}>{label}</option>
            {/each}
          </select>
        </div>
      {:else if id === "subsumed"}
        <div class="shared-select-group">
          <span class="shared-chip-label">{$tr("common.subsumed")}</span>
          <select
            class="shared-filter-select"
            data-subsumed
            title={$tr("filters.subsumedTitle")}
            value={state.subsumed}
            on:change={(event) =>
              updateSharedFilters(scope, { subsumed: selectedValue(event) as YesNoFilterMode })}
          >
            {#each SUBSUMED_OPTIONS as [mode, label] (mode)}
              <option value={mode}>{label}</option>
            {/each}
          </select>
        </div>
      {:else if id === "sort"}
        <SortControl
          value={state.sortBy}
          options={activeSortOptions}
          direction={state.sortDirection}
          onSelect={setSortBy}
          onToggleDirection={toggleSortDirection}
        />
      {:else if id === "orderPlaced"}
        <div class="shared-chip-group" title={$tr("filters.orderPlaced")}>
          <span class="shared-chip-label">{$tr("filters.orderPlaced")}</span>
          <div class="filter-tabs">
            {#each YES_NO_OPTIONS as [mode, label]}
              <button
                class="filter-tab"
                class:active={state.orderPlaced === mode}
                on:click={() => setYesNoFilter("orderPlaced", mode)}>{label}</button
              >
            {/each}
          </div>
        </div>
      {:else if id === "mastered"}
        <div class="shared-chip-group" title={$tr("filters.masteredHint")}>
          <span class="shared-chip-label">{$tr("common.mastered")}</span>
          <div class="filter-tabs">
            {#each YES_NO_OPTIONS as [mode, label]}
              <button
                class="filter-tab"
                class:active={state.mastered === mode}
                on:click={() => setYesNoFilter("mastered", mode)}>{label}</button
              >
            {/each}
          </div>
        </div>
      {:else if id === "spares"}
        <div class="shared-chip-group" title={$tr("filters.sparesHint")}>
          <span class="shared-chip-label">{$tr("filters.spares")}</span>
          <div class="filter-tabs">
            {#each YES_NO_OPTIONS as [mode, label]}
              <button
                class="filter-tab"
                class:active={state.spares === mode}
                on:click={() => setYesNoFilter("spares", mode)}>{label}</button
              >
            {/each}
          </div>
        </div>
      {:else if id === "vaultedChips"}
        <div class="shared-chip-group" title={$tr("filters.vaultedHint")}>
          <span class="shared-chip-label">{$tr("common.vaulted")}</span>
          <div class="filter-tabs">
            {#each YES_NO_OPTIONS as [mode, label]}
              <button
                class="filter-tab"
                class:active={state.vaulted === mode}
                on:click={() => setYesNoFilter("vaulted", mode)}>{label}</button
              >
            {/each}
          </div>
        </div>
      {:else if id === "partType"}
        <div class="shared-chip-group" title={$tr("filters.partTypeTitle")}>
          <span class="shared-chip-label">{$tr("filters.partTypeTitle")}</span>
          <div class="filter-tabs">
            <button
              class="filter-tab"
              class:active={state.partType === "normal"}
              on:click={() => setPartTypeFilter("normal")}>{$tr("common.normal")}</button
            >
            <button
              class="filter-tab"
              class:active={state.partType === "prime"}
              on:click={() => setPartTypeFilter("prime")}>{$tr("common.prime")}</button
            >
          </div>
        </div>
      {:else if id === "favorite"}
        <div class="shared-chip-group" title={$tr("filters.favoriteTitle")}>
          <span class="shared-chip-label">{$tr("filters.favoriteTitle")}</span>
          <div class="filter-tabs">
            {#each YES_NO_OPTIONS as [mode, label]}
              <button
                class="filter-tab"
                class:active={state.favorite === mode}
                on:click={() => setYesNoFilter("favorite", mode)}>{label}</button
              >
            {/each}
          </div>
        </div>
      {:else if id === "minPlatinum"}
        <div class="shared-chip-group" title={$tr("filters.minPlatinumTitle")}>
          <span class="shared-chip-label">{$tr("filters.minPlatinumTitle")}</span>
          <div class="filter-tabs">
            <label class="shared-number-filter">
              <input
                type="number"
                min="0"
                max="1000000"
                step="1"
                value={state.minimumPlatinum || ""}
                placeholder={$tr("filters.any")}
                aria-label={$tr("filters.customMinPlatinum")}
                on:input={setMinimumPlatinum}
              />
              <span>p</span>
            </label>
          </div>
        </div>
      {:else if id === "minAmount"}
        <div class="shared-chip-group" title={$tr("filters.amountHint")}>
          <span class="shared-chip-label">{$tr("filters.amount")}</span>
          <div class="filter-tabs">
            <button
              class="filter-tab"
              class:active={state.minimumAmount === 0}
              on:click={() => updateSharedFilters(scope, { minimumAmount: 0 })}
              >{$tr("filters.any")}</button
            >
            <button
              class="filter-tab"
              class:active={state.minimumAmount === 2}
              on:click={() => updateSharedFilters(scope, { minimumAmount: 2 })}>&gt;1</button
            >
          </div>
        </div>
      {:else if id === "equipped"}
        <div class="shared-chip-group" title={$tr("common.equippedModsOnly")}>
          <span class="shared-chip-label">{$tr("common.equippedModsOnly")}</span>
          <div class="filter-tabs">
            {#each YES_NO_OPTIONS as [mode, label]}
              <button
                class="filter-tab"
                class:active={state.equipped === mode}
                on:click={() => setYesNoFilter("equipped", mode)}>{label}</button
              >
            {/each}
          </div>
        </div>
      {:else if id === "leveledUp"}
        <div class="shared-chip-group" title={$tr("filters.leveledUpTitle")}>
          <span class="shared-chip-label">{$tr("filters.leveledUpLabel")}</span>
          <div class="filter-tabs">
            {#each YES_NO_OPTIONS as [mode, label]}
              <button
                class="filter-tab"
                class:active={state.leveledUp === mode}
                on:click={() => setYesNoFilter("leveledUp", mode)}>{label}</button
              >
            {/each}
          </div>
        </div>
      {/if}
    {/each}

    {#if showAdvanced || basicVariant === "full"}
      <button
        class="filter-tab"
        on:click={() => resetSharedFilters(scope)}
        title={$tr("filters.resetTitle")}
      >
        {$tr("common.reset")}
      </button>
    {/if}

    {#if enabled.size > 0}
      <button
        class="filter-tab"
        bind:this={customizeAnchor}
        data-filter-customize-toggle={scope}
        aria-expanded={customizeOpen}
        aria-label={$tr("filters.customizeTitle")}
        title={$tr("filters.customizeTitle")}
        on:click={() => (customizeOpen = !customizeOpen)}
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        >
          <path d="M2 4.5h9M13 4.5h1M2 11.5h3M7 11.5h7" />
          <circle cx="12" cy="4.5" r="1.6" />
          <circle cx="6" cy="11.5" r="1.6" />
        </svg>
      </button>
    {/if}
  </div>
</div>

{#if customizeOpen}
  <FilterCustomizePopover
    {scope}
    order={layout.order}
    hidden={layout.hidden}
    anchor={customizeAnchor}
    onClose={() => (customizeOpen = false)}
  />
{/if}
