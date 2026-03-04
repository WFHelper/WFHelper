<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { parsedItems, wfmItems } from "../stores/data.js";
  import { marketOrders } from "../stores/market.js";
  import { debugMode } from "../stores/app.js";
  import { activeItem } from "../stores/modals.js";
  import InventoryHeader from "../components/inventory/InventoryHeader.svelte";
  import InventoryDebugPanel from "../components/inventory/InventoryDebugPanel.svelte";
  import InventoryGrid from "../components/inventory/InventoryGrid.svelte";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import { applySharedFiltersAndSort } from "../lib/filters.js";
  import {
    INVENTORY_FILTERS,
    buildBaseInventoryItems,
    buildInventoryViewItems,
    buildOrderLookups,
    computeFilteredTotalCount,
    metricNeedsFromFilters,
    shouldHydrateMetrics,
    type InventoryBaseItem,
    type InventoryFilterTab,
    type InventoryViewItem,
    type MetricNeeds,
  } from "../lib/inventoryMarket.js";
  import { createInventoryHydrationController } from "../stores/inventoryHydration.js";
  import { sharedFilters } from "../stores/filters.js";

  const METRIC_VISIBLE_PREFETCH_LIMIT = 42;
  const METRIC_BACKGROUND_PREFETCH_LIMIT = 210;
  const DEBUG_REFRESH_MS = 900;

  let filter: InventoryFilterTab = "all_parts";
  let showFilterPanel = false;
  const FILTERS = INVENTORY_FILTERS;
  const inventoryFilters = sharedFilters("inventory");

  const hydration = createInventoryHydrationController();
  const hydrationMetrics = hydration.metricsByKey;
  const hydrationDebug = hydration.debugState;
  let debugStatsTimer: ReturnType<typeof setInterval> | null = null;

  function prefetchVisibleMetrics(items: InventoryBaseItem[], needs: MetricNeeds): void {
    const hydrationCandidates = items.filter((item) => shouldHydrateMetrics(item));
    const visible = hydrationCandidates.slice(0, METRIC_VISIBLE_PREFETCH_LIMIT);
    const background = hydrationCandidates.slice(
      METRIC_VISIBLE_PREFETCH_LIMIT,
      METRIC_VISIBLE_PREFETCH_LIMIT + METRIC_BACKGROUND_PREFETCH_LIMIT,
    );

    hydration.enqueue(visible, $wfmItems, needs);
    hydration.enqueue(background, $wfmItems, { ...needs, ducats: false });
  }

  function handleFilterSelect(event: CustomEvent<InventoryFilterTab>): void {
    filter = event.detail;
  }

  function handleToggleFilterPanel(): void {
    showFilterPanel = !showFilterPanel;
  }

  function handleItemSelect(event: CustomEvent<InventoryViewItem>): void {
    activeItem.set(event.detail);
  }

  onMount(() => {
    hydration.refreshDebugStats();

    if (debugStatsTimer) clearInterval(debugStatsTimer);
    debugStatsTimer = setInterval(() => {
      if (!$debugMode) return;
      hydration.refreshDebugStats();
    }, DEBUG_REFRESH_MS);
  });

  onDestroy(() => {
    hydration.destroy();
    if (debugStatsTimer) {
      clearInterval(debugStatsTimer);
      debugStatsTimer = null;
    }
  });

  $: ({ orderedNames, orderedSlugs } = buildOrderLookups($marketOrders));
  $: tabBaseItems = buildBaseInventoryItems($parsedItems, filter, $wfmItems, orderedNames, orderedSlugs);
  $: tabItems = buildInventoryViewItems(tabBaseItems, $hydrationMetrics, filter);
  $: filtered = applySharedFiltersAndSort(tabItems, $inventoryFilters);
  $: filteredTotalCount = computeFilteredTotalCount(filtered);
  $: metricNeeds = metricNeedsFromFilters($inventoryFilters, filter);
  $: prefetchVisibleMetrics(filtered, metricNeeds);
  $: backendDebugCounters = $hydrationDebug.priceDebugCounters as unknown as Record<string, number>;
  $: if ($debugMode) {
    hydration.refreshDebugStats();
  }
</script>

<section class="view active">
  <InventoryHeader
    totalCount={filteredTotalCount}
    filters={FILTERS}
    activeFilter={filter}
    {showFilterPanel}
    on:filter={handleFilterSelect}
    on:toggle={handleToggleFilterPanel}
  />

  {#if $debugMode}
    <InventoryDebugPanel
      activeTab={filter}
      debug={$hydrationDebug}
      backendHitOk={backendDebugCounters.backendHitOk ?? 0}
      backendHitNoData={backendDebugCounters.backendHitNoData ?? 0}
      backendError={backendDebugCounters.backendError ?? 0}
    />
  {/if}

  {#if showFilterPanel}
    <div class="inventory-filter-popover">
      <SharedFilterBar scope="inventory" showBasic={false} showAdvanced={true} />
    </div>
  {/if}

  <InventoryGrid items={filtered} showDebug={$debugMode} on:select={handleItemSelect} />
</section>
