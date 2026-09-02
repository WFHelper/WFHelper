<script context="module" lang="ts">
  import { registerSections } from "../lib/layout/registry.js";

  /** The stack above the item grid; the grid itself is its own group. */
  const INVENTORY_HEADER_SECTIONS = [
    "inventory.valueStrip",
    "inventory.selectionBar",
    "inventory.filters",
  ];
  const INVENTORY_GRID_SECTIONS = ["inventory.grid"];

  registerSections("inventory", [
    {
      id: "inventory.valueStrip",
      view: "inventory",
      labelKey: "inventory.value.title",
      defaultSpan: "full",
      canCollapse: true,
    },
    {
      id: "inventory.selectionBar",
      view: "inventory",
      labelKey: "layout.section.inventorySelection",
      defaultSpan: "full",
    },
    {
      id: "inventory.filters",
      view: "inventory",
      labelKey: "common.filters",
      defaultSpan: "full",
      canCollapse: true,
    },
    {
      id: "inventory.grid",
      view: "inventory",
      labelKey: "common.inventory",
      defaultSpan: "full",
      minSpan: "full",
      canHide: false,
    },
  ]);
</script>

<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { tr } from "../lib/i18n.js";
  import EditLayoutBar from "../components/layout/EditLayoutBar.svelte";
  import LayoutGrid from "../components/layout/LayoutGrid.svelte";
  import { parsedItems, wfmItems, inventoryData, itemDb } from "../stores/data.js";
  import { masteryData } from "../stores/mastery.js";
  import { marketOrders } from "../stores/market.js";
  import { ensureMarketOrdersLoaded } from "../lib/marketOrdersSync.js";
  import { attachPartMasteryFlags, buildPartMasteryResolver } from "../lib/parentMastery.js";
  import { relicDb } from "../stores/relics.js";
  import InventoryHeader from "../components/inventory/InventoryHeader.svelte";
  import InventoryGrid from "../components/inventory/InventoryGrid.svelte";
  import InventoryList from "../components/inventory/InventoryList.svelte";
  import InventoryValueStrip from "../components/inventory/InventoryValueStrip.svelte";
  import InventorySelectionBar from "../components/inventory/InventorySelectionBar.svelte";
  import InventoryOrderBookPanel from "../components/inventory/InventoryOrderBookPanel.svelte";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import ResourcesView from "./ResourcesView.svelte";
  import ChipToggleRow from "../components/inventory/ChipToggleRow.svelte";
  import { parseResources } from "../lib/inventory.js";
  import {
    EQUIPMENT_CATEGORY_ORDER,
    classifyForFoundry,
  } from "../lib/inventory/foundryResources.js";
  import { applySharedFiltersAndSort, compareNames, matchesSearch } from "../lib/filters.js";
  import { buildDetailKeys } from "../lib/inventory/detailKeys.js";
  import { setRootOf } from "../lib/inventory/fullSets.js";
  import {
    computeInventoryValueTotals,
    isCountedForValue,
    type InventoryValueScope,
  } from "../lib/inventory/valueTotals.js";
  import {
    EVERYTHING_DEFAULT_SOURCES,
    EVERYTHING_SOURCES,
    INVENTORY_FILTERS,
    buildBaseInventoryItems,
    buildInventoryViewItems,
    buildOrderLookups,
    metricNeedsFromFilters,
    shouldHydrateMetrics,
    type InventoryBaseItem,
    type InventoryFilterTab,
    type InventoryViewItem,
    type MetricNeeds,
  } from "../lib/inventoryMarket.js";
  import { buildRelicSearchKeywordIndex, relicGroupForUniqueName } from "../lib/relic.js";
  import { readStorage, writeStorage } from "../lib/persistence.js";
  import { startupPriceCacheReady } from "../lib/startupLoader.js";
  import { log } from "../lib/log.js";
  import {
    getRankedHotsetEntries,
    getRankedHotsetSeenAt,
    recordRankedHotsetEntry,
  } from "../lib/wfm/rankedHotset.js";
  import { getInventoryHydrationController } from "../stores/inventoryHydration.js";
  import { ARCANE_STAND_IN_ART } from "../data/arcaneStandInArt.js";
  import { devMode, degradedIcons } from "../stores/devMode.js";
  import { sharedFilters, updateSharedFilters } from "../stores/filters.js";
  import { inventoryViewMode, type InventoryViewMode } from "../stores/inventoryViewMode.js";
  import { inventoryValueAllTradables, inventoryValueMinPlatinum } from "../stores/preferences.js";
  import { activeItem, activeRelic } from "../stores/modals.js";
  import { inventorySafety } from "../stores/inventorySafety.js";
  import {
    bulkSellOpen,
    clearSelection,
    deleteSavedSelection,
    inventorySelection,
    inventorySelectionMode,
    loadSavedSelection,
    savedSelections,
    saveSelection,
    selectKeys,
    toggleSelected,
    toggleSelectionMode,
  } from "../stores/inventorySelection.js";
  import { masteryPins } from "../stores/masteryPins.js";
  import {
    buildSelectionSafetyContext,
    eligibleSelectionKeys,
  } from "../lib/tradeWorkbench/queueModel.js";
  import { workbenchState } from "../lib/tradeWorkbench/workbenchState.js";
  import { isRankedGroup } from "../../config/shared/numeric.js";
  import type { SharedSortKey, SharedFiltersState, SortDirection } from "../types/filters.js";

  const METRIC_VISIBLE_PREFETCH_LIMIT = 42;
  const METRIC_BACKGROUND_PREFETCH_LIMIT = 210;
  const HOTSET_REFRESH_DELAY_MS = 4_000;
  const HOTSET_REFRESH_LIMIT = 12;

  // One shared empty result for the selection lookups; nothing mutates it and
  // every card only reads `has`, so it never needs to be reactive.
  const NO_SELECTION_KEYS: ReadonlySet<string> = new Set();

  const FILTER_TAB_KEY = "wf_inventory_tab";
  // Both chip rows store the HIDDEN keys, so a source or category a later
  // release adds shows up by default instead of being silently missing.
  const EVERYTHING_HIDDEN_KEY = "wf_inventory_everything_hidden_sources";
  const FULL_SETS_HIDDEN_KEY = "wf_inventory_full_sets_hidden_categories";
  /** Legacy key: held the ENABLED sources; read only to seed the hidden set. */
  const LEGACY_EVERYTHING_SOURCES_KEY = "wf_inventory_everything_sources";

  const EVERYTHING_HIDDEN_BY_DEFAULT = EVERYTHING_SOURCES.filter(
    (source) => !EVERYTHING_DEFAULT_SOURCES.includes(source),
  );

  function restoreFilterTab(): InventoryFilterTab {
    const raw = readStorage(FILTER_TAB_KEY);
    const known = INVENTORY_FILTERS.some((entry) => entry.key === raw);
    return known ? (raw as InventoryFilterTab) : "all_parts";
  }

  function parseKeyList(raw: string | null): string[] {
    return (raw ?? "").split(",").filter((entry) => entry.length > 0);
  }

  function restoreHiddenEverythingSources(): string[] {
    const stored = readStorage(EVERYTHING_HIDDEN_KEY);
    if (stored != null) return parseKeyList(stored);

    const legacy = readStorage(LEGACY_EVERYTHING_SOURCES_KEY);
    if (legacy == null) return [...EVERYTHING_HIDDEN_BY_DEFAULT];
    // Invert once and persist: an empty legacy value was a real choice (all off),
    // and re-deriving each mount would freeze out a source added later.
    const wasEnabled = new Set(parseKeyList(legacy));
    const hidden = EVERYTHING_SOURCES.filter((source) => !wasEnabled.has(source));
    writeStorage(EVERYTHING_HIDDEN_KEY, hidden.join(","));
    return hidden;
  }

  // Only sorts the active tab can actually compute; anything else would
  // silently fall back to a name sort (metrics missing on those items).
  $: FULL_SORT_OPTIONS = [
    ["name", $tr("common.name")],
    ["platinum", $tr("common.platinum")],
    ["ducats", $tr("common.ducats")],
    ["amount", $tr("filters.amount")],
    ["ducatonator", $tr("filters.ducatonator")],
    ["complete_sets", $tr("filters.completeSets")],
    ["missing_parts", $tr("filters.partsToComplete")],
  ] as Array<[SharedSortKey, string]>;
  $: PRICED_SORT_OPTIONS = [
    ["name", $tr("common.name")],
    ["platinum", $tr("common.platinum")],
    ["amount", $tr("filters.amount")],
  ] as Array<[SharedSortKey, string]>;
  $: RESOURCE_SORT_OPTIONS = [
    ["name", $tr("common.name")],
    ["amount", $tr("filters.amount")],
  ] as Array<[SharedSortKey, string]>;
  $: SORT_OPTIONS_BY_TAB = {
    all_parts: FULL_SORT_OPTIONS,
    full_sets: FULL_SORT_OPTIONS,
    resources: RESOURCE_SORT_OPTIONS,
  } as Partial<Record<InventoryFilterTab, Array<[SharedSortKey, string]>>>;

  let filter: InventoryFilterTab = restoreFilterTab();
  let hiddenEverythingSources: string[] = restoreHiddenEverythingSources();
  let hiddenSetCategories: string[] = parseKeyList(readStorage(FULL_SETS_HIDDEN_KEY));
  let missingIconsOnly = false;
  let showFilterPanel = false;
  // Full Sets lists sellable spares; this folds in the sets still missing parts.
  let showIncompleteSets = false;
  let selectedInternalName: string | null = null;
  /** Last ticked row; shift-click extends the selection from here. */
  let selectionAnchor: string | null = null;
  let orderBookPanelOpen = false;
  const FILTERS = INVENTORY_FILTERS;
  const inventoryFilters = sharedFilters("inventory");

  const hydration = getInventoryHydrationController();
  const hydrationMetrics = hydration.metricsByKey;
  let hotsetRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let hotsetRefreshSignature = "";
  let hotsetRefreshCompletedSignature = "";

  function trackRankedHotset(item: InventoryBaseItem | null | undefined): void {
    if (!item || !isRankedGroup(item.inventoryGroup) || !item.marketSlug) return;
    recordRankedHotsetEntry(item.marketSlug, item.maxRank);
  }

  function prefetchVisibleMetrics(items: InventoryBaseItem[], needs: MetricNeeds): void {
    const hydrationCandidates = items.filter((item) => shouldHydrateMetrics(item));
    const visible = hydrationCandidates.slice(0, METRIC_VISIBLE_PREFETCH_LIMIT);
    const background = hydrationCandidates.slice(
      METRIC_VISIBLE_PREFETCH_LIMIT,
      METRIC_VISIBLE_PREFETCH_LIMIT + METRIC_BACKGROUND_PREFETCH_LIMIT,
    );

    // the startup snapshot doesn't cover every slug, so the visible slice may fetch
    hydration.enqueue(visible, $wfmItems, { ...needs, network: true });
    hydration.enqueue(background, $wfmItems, { ...needs, ducats: false, orders: false });
  }

  function handleFilterSelect(event: CustomEvent<InventoryFilterTab>): void {
    filter = event.detail;
    writeStorage(FILTER_TAB_KEY, filter);
    // Resources hides the advanced panel, so a carried-over amount would cut
    // rows with no control and no badge to reveal it.
    if (filter === "resources" && $inventoryFilters.minimumAmount > 0) {
      updateSharedFilters("inventory", { minimumAmount: 0 });
    }
  }

  function toggleHidden(key: string, hidden: string[], entry: string): string[] {
    const next = hidden.includes(entry)
      ? hidden.filter((other) => other !== entry)
      : [...hidden, entry];
    writeStorage(key, next.join(","));
    return next;
  }

  function toggleEverythingSource(source: string): void {
    hiddenEverythingSources = toggleHidden(EVERYTHING_HIDDEN_KEY, hiddenEverythingSources, source);
  }

  function toggleIncompleteSets(): void {
    showIncompleteSets = !showIncompleteSets;
    // Fewest-parts-first on arrival; don't fight a deliberate re-sort.
    if (showIncompleteSets && $inventoryFilters.sortBy !== "missing_parts") {
      updateSharedFilters("inventory", { sortBy: "missing_parts", sortDirection: "asc" });
    }
  }

  function handleToggleFilterPanel(): void {
    showFilterPanel = !showFilterPanel;
  }

  function setViewMode(mode: InventoryViewMode): void {
    inventoryViewMode.set(mode);
  }

  /** Column headers write the shared sort store, same as the sort dropdown. */
  function applyListSort(patch: { sortBy: SharedSortKey; sortDirection: SortDirection }): void {
    updateSharedFilters("inventory", patch);
  }

  function setValueScope(allTradables: boolean): void {
    inventoryValueAllTradables.set(allTradables);
  }

  function setValueMinPlatinum(minPlatinum: number): void {
    inventoryValueMinPlatinum.set(minPlatinum);
  }

  function handleItemSelect(item: InventoryViewItem): void {
    selectedInternalName = item.internalName;
    orderBookPanelOpen = true;

    if (!wfmItemsLoaded) return;
    const selectedBaseItem = tabBaseItems.find((entry) => entry.internalName === item.internalName);
    if (selectedBaseItem && shouldHydrateMetrics(selectedBaseItem)) {
      trackRankedHotset(selectedBaseItem);
      hydration.enqueue([selectedBaseItem], $wfmItems, {
        price: true,
        ducats: false,
        orders: true,
        network: true,
      });
    }
  }

  $: detailKeys = buildDetailKeys($parsedItems);

  function handleItemExpand(item: InventoryViewItem): void {
    // Relic cards open the reward breakdown, matching the Relics tab.
    const relicGroup = relicGroupForUniqueName($relicDb, item.internalName);
    if (relicGroup) {
      activeRelic.set(relicGroup);
      return;
    }
    const cardKey = item.internalName;
    const parsed =
      $parsedItems.find((entry) => entry.inventoryKey === cardKey) ??
      $parsedItems.find((entry) => entry.internalName === cardKey);
    // Base items predate hydration - carry the slug so the modal prices by it.
    if (parsed) activeItem.set({ ...parsed, marketSlug: item.marketSlug });
  }

  function closeOrderBookPanel(): void {
    selectedInternalName = null;
    orderBookPanelOpen = false;
  }

  /** Shift extends from the last click through the displayed order, which is
   *  `gridItems` - the same array both renderers were handed. */
  function handleItemToggle(item: InventoryViewItem, shiftKey: boolean): void {
    const key = item.internalName;
    if (!eligibleSelectionSet.has(key)) return;
    const anchor = selectionAnchor;
    if (shiftKey && anchor && anchor !== key) {
      const from = gridItems.findIndex((entry) => entry.internalName === anchor);
      const to = gridItems.findIndex((entry) => entry.internalName === key);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        selectKeys(
          gridItems
            .slice(start, end + 1)
            .map((entry) => entry.internalName)
            .filter((entry) => eligibleSelectionSet.has(entry)),
          "add",
        );
        selectionAnchor = key;
        return;
      }
    }
    toggleSelected(key);
    selectionAnchor = key;
  }

  function handleToggleSelectionMode(): void {
    selectionAnchor = null;
    toggleSelectionMode();
  }

  function handleSelectAll(): void {
    selectKeys(selectableVisibleKeys, "replace");
  }

  function openBulkSellModal(): void {
    bulkSellOpen.set(true);
  }

  function handleItemVisible(item: InventoryViewItem): void {
    // before the catalog loads, cards carry guessed slugs - don't fetch with those
    if (!wfmItemsLoaded) return;
    const visibleBaseItem = tabBaseItems.find((entry) => entry.internalName === item.internalName);
    if (!visibleBaseItem || !shouldHydrateMetrics(visibleBaseItem)) return;
    trackRankedHotset(visibleBaseItem);

    // Everything mixes ranked and unranked rows, so the item decides, not the tab.
    hydration.enqueue([visibleBaseItem], $wfmItems, {
      price: true,
      ducats: false,
      orders: isRankedGroup(visibleBaseItem.inventoryGroup),
      network: true,
    });
  }

  function clearHotsetRefreshTimer(): void {
    if (!hotsetRefreshTimer) return;
    clearTimeout(hotsetRefreshTimer);
    hotsetRefreshTimer = null;
  }

  function buildHotsetRefreshSignature(items: InventoryBaseItem[]): string {
    const topHotset = getRankedHotsetEntries()
      .slice(0, HOTSET_REFRESH_LIMIT)
      .map((entry) => `${entry.slug}:r${entry.maxRank}`)
      .join("|");
    return `${items.length}:${topHotset}`;
  }

  function maybeScheduleRankedHotsetRefresh(items: InventoryBaseItem[]): void {
    if (!$startupPriceCacheReady) return;
    if (!wfmItemsLoaded) return;

    const signature = buildHotsetRefreshSignature(items);
    if (signature === hotsetRefreshSignature || signature === hotsetRefreshCompletedSignature) {
      return;
    }

    hotsetRefreshSignature = signature;
    clearHotsetRefreshTimer();
    hotsetRefreshTimer = setTimeout(() => {
      hotsetRefreshTimer = null;
      const topHotset = getRankedHotsetEntries().slice(0, HOTSET_REFRESH_LIMIT);
      if (topHotset.length === 0) {
        hotsetRefreshCompletedSignature = signature;
        return;
      }

      const bySlug = new Map(topHotset.map((entry) => [entry.slug, entry]));
      const queue = items
        .filter((item) => item.marketSlug && bySlug.has(item.marketSlug))
        .sort((a, b) => getRankedHotsetSeenAt(b.marketSlug) - getRankedHotsetSeenAt(a.marketSlug))
        .slice(0, HOTSET_REFRESH_LIMIT);

      if (queue.length > 0) {
        hydration.enqueue(queue, $wfmItems, {
          price: true,
          ducats: false,
          orders: true,
          network: true,
        });
        log.info(`[Inventory] queued ranked hotset refresh (${queue.length} items)`);
      }

      hotsetRefreshCompletedSignature = signature;
    }, HOTSET_REFRESH_DELAY_MS);
  }

  /** Sets carry "Full Set" as their label, so bucket them by the root item instead. */
  function setCategoryFor(item: InventoryBaseItem, db: typeof $itemDb): string {
    const root = setRootOf(item.internalName);
    return classifyForFoundry(root, root, db);
  }

  function orderedSetCategories(items: InventoryBaseItem[], db: typeof $itemDb): string[] {
    const present = new Set(items.map((item) => setCategoryFor(item, db)));
    return EQUIPMENT_CATEGORY_ORDER.filter((category) => present.has(category));
  }

  function toggleSetCategory(category: string): void {
    hiddenSetCategories = toggleHidden(FULL_SETS_HIDDEN_KEY, hiddenSetCategories, category);
  }

  function limitToEnabledSources(
    items: InventoryBaseItem[],
    tab: InventoryFilterTab,
    enabled: ReadonlySet<string>,
  ): InventoryBaseItem[] {
    if (tab !== "everything") return items;
    return items.filter((item) => enabled.has(item.inventoryGroup));
  }

  function mergeKeywords(base: string[] | undefined, extra: string[]): string[] {
    const merged = Array.isArray(base) ? [...base] : [];
    for (const keyword of extra) {
      if (!merged.includes(keyword)) {
        merged.push(keyword);
      }
    }
    return merged;
  }

  onMount(() => {
    hydration.resume();
    // The "Order placed" badges read the orders store, which otherwise only the
    // Market tab fills; a straight-to-inventory session reads every item as unlisted.
    void ensureMarketOrdersLoaded();
  });

  onDestroy(() => {
    clearHotsetRefreshTimer();

    hydration.pause();
  });

  $: ({ orderedNames, orderedSlugs, orderedSubtypes } = buildOrderLookups($marketOrders));
  $: incompleteSetBaseItems =
    filter === "full_sets" && showIncompleteSets
      ? buildBaseInventoryItems(
          $parsedItems,
          "incomplete_sets",
          $wfmItems,
          orderedNames,
          orderedSlugs,
          $relicDb,
          orderedSubtypes,
        )
      : [];
  $: everythingSourceOptions = EVERYTHING_SOURCES.flatMap((source) => {
    const labelKey = FILTERS.find((entry) => entry.key === source)?.labelKey;
    return labelKey ? [{ key: source as string, label: $tr(labelKey) }] : [];
  });
  $: enabledEverythingSources = new Set<string>(
    EVERYTHING_SOURCES.filter((source) => !hiddenEverythingSources.includes(source)),
  );
  // Untranslated for the same reason as the foundry category tabs.
  $: fullSetCategoryOptions =
    filter === "full_sets"
      ? orderedSetCategories(tabBaseItems, $itemDb).map((key) => ({ key, label: key }))
      : [];
  $: enabledSetCategories = new Set<string>(
    fullSetCategoryOptions
      .map((option) => option.key)
      .filter((key) => !hiddenSetCategories.includes(key)),
  );
  $: showEverythingResources = filter === "everything" && enabledEverythingSources.has("resources");
  $: tabBaseItems = limitToEnabledSources(
    [
      ...buildBaseInventoryItems(
        $parsedItems,
        filter,
        $wfmItems,
        orderedNames,
        orderedSlugs,
        $relicDb,
        orderedSubtypes,
      ),
      ...incompleteSetBaseItems,
    ],
    filter,
    enabledEverythingSources,
  );
  $: allRankedBaseItems = [
    ...buildBaseInventoryItems(
      $parsedItems,
      "mods",
      $wfmItems,
      orderedNames,
      orderedSlugs,
      $relicDb,
      orderedSubtypes,
    ),
    ...buildBaseInventoryItems(
      $parsedItems,
      "arcanes",
      $wfmItems,
      orderedNames,
      orderedSlugs,
      $relicDb,
      orderedSubtypes,
    ),
  ];
  $: tabItems = buildInventoryViewItems(tabBaseItems, $hydrationMetrics);
  $: relicSearchKeywordIndex = buildRelicSearchKeywordIndex($relicDb);
  $: searchableTabItems =
    filter !== "relics" && filter !== "everything"
      ? tabItems
      : tabItems.map((item) => {
          const relicKeywords = relicSearchKeywordIndex[item.internalName] || [];
          if (relicKeywords.length === 0) return item;

          return {
            ...item,
            keywords: mergeKeywords(item.keywords, relicKeywords),
          };
        });
  $: selectedItem = selectedInternalName
    ? tabItems.find((entry) => entry.internalName === selectedInternalName) || null
    : null;
  $: partMastery = buildPartMasteryResolver($itemDb, $masteryData);
  $: masteredTabItems = attachPartMasteryFlags(searchableTabItems, partMastery);
  $: sortedTabItems = applySharedFiltersAndSort(masteredTabItems, $inventoryFilters);
  $: filtered =
    filter === "full_sets" && hiddenSetCategories.length > 0
      ? sortedTabItems.filter((item) => enabledSetCategories.has(setCategoryFor(item, $itemDb)))
      : sortedTabItems;
  $: visibleItems =
    $devMode && missingIconsOnly
      ? filtered.filter(
          (item) =>
            !item.displayImageUrl ||
            item.usesFallbackArt ||
            ARCANE_STAND_IN_ART.has(item.internalName) ||
            $degradedIcons.has(item.name),
        )
      : filtered;
  // Annotated so the reactive assignment keeps the literal union instead of string.
  let valueScope: InventoryValueScope;
  let valueSourceTab: InventoryFilterTab;
  $: valueScope = $inventoryValueAllTradables ? "tradable" : "prime";
  $: valueSourceTab = $inventoryValueAllTradables ? "everything" : "all_parts";
  // Gate the cheap base rows first so the priced rows are only built for what
  // the totals actually count.
  $: valueBaseItems = buildBaseInventoryItems(
    $parsedItems,
    valueSourceTab,
    $wfmItems,
    orderedNames,
    orderedSlugs,
    $relicDb,
    orderedSubtypes,
  ).filter((item) => isCountedForValue(item, valueScope));
  // Rebuilt on every metric flush, so the totals below re-walk with it.
  $: valueInventoryItems = buildInventoryViewItems(valueBaseItems, $hydrationMetrics);
  // The platinum floor belongs to the totals, not the prefilter above: base rows
  // carry no median yet, so gating there would drop everything on first paint.
  $: inventoryValueTotals = computeInventoryValueTotals(
    valueInventoryItems,
    valueScope,
    $inventoryValueMinPlatinum,
  );
  // visibleItems is the tab after its chips, the search and the advanced filters,
  // so this figure is the one the user can point at on screen.
  $: inViewValueTotals = computeInventoryValueTotals(
    visibleItems,
    valueScope,
    $inventoryValueMinPlatinum,
  );
  // Mount the grid a page at a time: a thousands-row tab (Everything) otherwise
  // creates every card synchronously and re-diffs them on each metric patch.
  const GRID_PAGE_SIZE = 120;
  let gridLimit = GRID_PAGE_SIZE;
  function resetGridLimit(_tab: InventoryFilterTab, _filters: SharedFiltersState): void {
    gridLimit = GRID_PAGE_SIZE;
  }
  // Listing the tab and filter state textually keeps this reactive to both.
  $: resetGridLimit(filter, $inventoryFilters);
  $: gridItems = gridLimit < visibleItems.length ? visibleItems.slice(0, gridLimit) : visibleItems;
  // Eligibility walks every parsed item, so it only runs while picking.
  $: selectionSafetyContext = $inventorySelectionMode
    ? buildSelectionSafetyContext({
        itemDb: $itemDb,
        settings: $inventorySafety,
        mastery: $masteryData,
        pins: $masteryPins,
      })
    : null;
  $: eligibleSelectionSet = selectionSafetyContext
    ? eligibleSelectionKeys($parsedItems, selectionSafetyContext, $wfmItems)
    : NO_SELECTION_KEYS;
  $: selectableVisibleKeys = $inventorySelectionMode
    ? visibleItems.map((item) => item.internalName).filter((key) => eligibleSelectionSet.has(key))
    : [];
  // The selection survives tab and filter changes, so the bar reports how much
  // of it the current tab actually shows rather than implying it is all here.
  $: selectedOnTabCount = $inventorySelectionMode
    ? visibleItems.filter((item) => $inventorySelection.has(item.internalName)).length
    : 0;
  $: bulkSellNeedsAttention =
    $workbenchState?.reviewRequired === true ||
    $workbenchState?.phase === "running" ||
    $workbenchState?.phase === "cancelling";
  $: resourceList =
    $inventoryData && Object.keys($itemDb).length > 0
      ? parseResources($inventoryData, $itemDb)
      : [];
  function filterAndSortResources(
    list: typeof resourceList,
    filters: typeof $inventoryFilters,
  ): typeof resourceList {
    // Skip on an empty query so a thousands-row account does not re-filter for nothing.
    const searched = filters.search.trim()
      ? list.filter((resource) => matchesSearch(resource, filters.search))
      : list;
    const gated =
      filters.minimumAmount > 0
        ? searched.filter((r) => r.count >= filters.minimumAmount)
        : searched;
    const dir = filters.sortDirection === "asc" ? 1 : -1;
    return [...gated].sort((a, b) =>
      filters.sortBy === "amount" ? (a.count - b.count) * dir : compareNames(a.name, b.name) * dir,
    );
  }

  $: filteredResources = filterAndSortResources(resourceList, $inventoryFilters);
  $: filteredTotalCount =
    filter === "resources"
      ? filteredResources.length
      : visibleItems.length + (showEverythingResources ? filteredResources.length : 0);
  function countActiveAdvancedFilters(state: SharedFiltersState): number {
    let active = 0;
    if (state.orderPlaced !== "all") active++;
    if (state.mastered !== "all") active++;
    if (state.spares !== "all") active++;
    if (state.vaulted !== "all") active++;
    if (state.partType !== "all") active++;
    if (state.favorite !== "all") active++;
    if (state.equipped !== "all") active++;
    if (state.leveledUp !== "all") active++;
    if (state.minimumPlatinum > 0) active++;
    if (state.minimumAmount > 0) active++;
    return active;
  }
  $: activeAdvancedCount = countActiveAdvancedFilters($inventoryFilters);
  $: tabSortOptions = SORT_OPTIONS_BY_TAB[filter] ?? PRICED_SORT_OPTIONS;
  // A column header only sorts by a key this tab can compute; anything else
  // would silently fall back to a name sort, exactly like the sort dropdown.
  $: tabSortKeys = new Set<string>(tabSortOptions.map(([key]) => key));
  $: showDucats = filter === "all_parts" || filter === "full_sets" || filter === "everything";
  $: metricNeeds = metricNeedsFromFilters($inventoryFilters, filter);
  $: wfmItemsLoaded = Object.keys($wfmItems).length > 0;
  $: if ($startupPriceCacheReady && wfmItemsLoaded) {
    prefetchVisibleMetrics(filtered, metricNeeds);
    maybeScheduleRankedHotsetRefresh(allRankedBaseItems);
  }

  // The header stack is conditional; an absent block must not leave an empty slot.
  $: availableHeaderSections = [
    ...(filter !== "resources" ? ["inventory.valueStrip"] : []),
    ...($inventorySelectionMode && filter !== "resources" ? ["inventory.selectionBar"] : []),
    ...(showFilterPanel && filter !== "resources" ? ["inventory.filters"] : []),
  ];
</script>

<section class="view active">
  <InventoryHeader
    totalCount={filteredTotalCount}
    filters={FILTERS}
    activeFilter={filter}
    {showFilterPanel}
    sortOptions={tabSortOptions}
    advancedCount={activeAdvancedCount}
    filtersEnabled={filter !== "resources"}
    viewMode={$inventoryViewMode}
    viewModeEnabled={filter !== "resources"}
    onSelectViewMode={setViewMode}
    selectionMode={$inventorySelectionMode}
    selectionEnabled={filter !== "resources"}
    onToggleSelectionMode={handleToggleSelectionMode}
    on:filter={handleFilterSelect}
    on:toggle={handleToggleFilterPanel}
  >
    <div class="mb-2 flex justify-end">
      <EditLayoutBar view="inventory" />
    </div>
    <LayoutGrid
      view="inventory"
      only={INVENTORY_HEADER_SECTIONS}
      available={availableHeaderSections}
      gapClass="gap-0"
      let:sectionId
    >
      {#if sectionId === "inventory.valueStrip"}
        <InventoryValueStrip
          inView={inViewValueTotals}
          inventory={inventoryValueTotals}
          allTradables={$inventoryValueAllTradables}
          onSelectScope={setValueScope}
          minPlatinum={$inventoryValueMinPlatinum}
          onSelectMinPlatinum={setValueMinPlatinum}
        />
      {:else if sectionId === "inventory.selectionBar"}
        <InventorySelectionBar
          count={$inventorySelection.size}
          onTabCount={selectedOnTabCount}
          eligibleCount={selectableVisibleKeys.length}
          saved={$savedSelections}
          onSelectAll={handleSelectAll}
          onClear={clearSelection}
          onSave={saveSelection}
          onLoad={loadSavedSelection}
          onDelete={deleteSavedSelection}
          onBulkSell={openBulkSellModal}
        />
      {:else if sectionId === "inventory.filters"}
        <div
          class="inventory-filter-popover mb-3.5 max-h-[67vh] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-2.5 shadow-[var(--ui-panel-shadow)] [backdrop-filter:var(--ui-backdrop-blur)]"
        >
          <SharedFilterBar scope="inventory" showBasic={false} showAdvanced={true} />
        </div>
      {/if}
    </LayoutGrid>
  </InventoryHeader>

  {#if bulkSellNeedsAttention}
    <!-- The queue used to live in a Market sub-tab; this keeps the journal
         review reachable now that Bulk Sell is only a modal. -->
    <div
      class="mb-3 flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] border border-warning/50 bg-warning/10 px-3 py-2 text-sm"
      data-bulk-sell-banner
    >
      <span class="text-text-primary">
        {$workbenchState?.reviewRequired
          ? $tr("inventory.bulkSellReviewRequired")
          : $tr("inventory.bulkSellRunActive")}
      </span>
      <button
        type="button"
        class="btn-secondary btn-sm ml-auto"
        data-bulk-sell-banner-open
        on:click={openBulkSellModal}
      >
        {$tr("inventory.openBulkSell")}
      </button>
    </div>
  {/if}

  <LayoutGrid view="inventory" only={INVENTORY_GRID_SECTIONS} gapClass="gap-0" let:sectionId>
    {#if sectionId === "inventory.grid"}
      {#if filter === "resources"}
        <ResourcesView resources={filteredResources} />
      {:else}
        <div
          class="grid grid-cols-1 items-start gap-3 {orderBookPanelOpen
            ? 'min-[1101px]:grid-cols-[minmax(0,1fr)_360px]'
            : ''}"
        >
          <div class="min-w-0" data-tour="inventory-grid">
            {#if filter === "everything"}
              <ChipToggleRow
                rowName="everything-sources"
                label={$tr("inventory.everythingInclude")}
                options={everythingSourceOptions}
                enabled={enabledEverythingSources}
                onToggle={toggleEverythingSource}
              />
            {/if}
            {#if filter === "full_sets"}
              <ChipToggleRow
                rowName="full-set-categories"
                label={$tr("common.category")}
                options={fullSetCategoryOptions}
                enabled={enabledSetCategories}
                onToggle={toggleSetCategory}
              />
            {/if}
            {#if filter === "full_sets"}
              <label
                class="mb-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-text-secondary"
              >
                <input
                  type="checkbox"
                  class="accent-[color:var(--accent)]"
                  checked={showIncompleteSets}
                  on:change={toggleIncompleteSets}
                />
                {$tr("inventory.showIncompleteSets")}
              </label>
            {/if}
            {#if $devMode}
              <label
                class="mb-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-text-secondary"
              >
                <input
                  type="checkbox"
                  class="accent-[color:var(--accent)]"
                  bind:checked={missingIconsOnly}
                />
                {$tr("inventory.missingIconsDev")}
              </label>
            {/if}
            <!-- Both renderers take the same paged view-model, so search, filters,
             hydration and the totals strip do not know which one is mounted. -->
            {#if $inventoryViewMode === "list"}
              <InventoryList
                items={gridItems}
                totalCount={visibleItems.length}
                {showDucats}
                {detailKeys}
                sortBy={$inventoryFilters.sortBy}
                sortDirection={$inventoryFilters.sortDirection}
                sortableKeys={tabSortKeys}
                onSort={applyListSort}
                onSelect={handleItemSelect}
                onVisible={handleItemVisible}
                onExpand={handleItemExpand}
                onMore={() => (gridLimit += GRID_PAGE_SIZE)}
                selectionMode={$inventorySelectionMode}
                selectedKeys={$inventorySelection}
                eligibleKeys={eligibleSelectionSet}
                onToggleSelect={handleItemToggle}
              />
            {:else}
              <InventoryGrid
                items={gridItems}
                totalCount={visibleItems.length}
                {showDucats}
                {detailKeys}
                selectionMode={$inventorySelectionMode}
                selectedKeys={$inventorySelection}
                eligibleKeys={eligibleSelectionSet}
                on:select={(event) => handleItemSelect(event.detail)}
                on:visible={(event) => handleItemVisible(event.detail)}
                on:expand={(event) => handleItemExpand(event.detail)}
                on:toggle={(event) => handleItemToggle(event.detail.item, event.detail.shiftKey)}
                on:more={() => (gridLimit += GRID_PAGE_SIZE)}
              />
            {/if}

            {#if showEverythingResources && filteredResources.length > 0}
              <!-- Resources have their own row shape, so Everything appends the real list. -->
              <h3
                class="mb-2 mt-4 font-display text-sm uppercase tracking-[0.05em] text-text-muted"
              >
                {$tr("nav.resources")}
              </h3>
              <ResourcesView resources={filteredResources} />
            {/if}
          </div>

          {#if orderBookPanelOpen}
            <InventoryOrderBookPanel item={selectedItem} onClose={closeOrderBookPanel} />
          {/if}
        </div>
      {/if}
    {/if}
  </LayoutGrid>
</section>

<style>
  .inventory-filter-popover :global(.shared-filter-bar) {
    margin-bottom: 0;
  }
  .inventory-filter-popover :global(.shared-filter-controls) {
    align-items: flex-start;
    gap: 0.5rem;
  }
  .inventory-filter-popover :global(.shared-chip-group) {
    flex-direction: column;
    align-items: stretch;
    gap: 0.3rem;
  }
  .inventory-filter-popover :global(.shared-chip-group .filter-tabs) {
    width: 100%;
    justify-content: flex-start;
    flex-wrap: wrap;
  }
</style>
