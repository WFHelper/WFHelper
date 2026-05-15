<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { parsedItems, wfmItems, inventoryData, itemDb } from "../stores/data.js";
  import { marketOrders } from "../stores/market.js";
  import { relicDb } from "../stores/relics.js";
  import InventoryHeader from "../components/inventory/InventoryHeader.svelte";
  import InventoryGrid from "../components/inventory/InventoryGrid.svelte";
  import InventoryOrderBookPanel from "../components/inventory/InventoryOrderBookPanel.svelte";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import ResourcesView from "./ResourcesView.svelte";
  import { parseResources } from "../lib/inventory.js";
  import { applySharedFiltersAndSort } from "../lib/filters.js";
  import {
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
  import { buildRelicSearchKeywordIndex } from "../lib/relic.js";
  import { startupPriceCacheReady } from "../lib/startupLoader.js";
  import { log } from "../lib/log.js";
  import {
    getRankedHotsetEntries,
    getRankedHotsetSeenAt,
    recordRankedHotsetEntry,
  } from "../lib/wfm/rankedHotset.js";
  import { getInventoryHydrationController } from "../stores/inventoryHydration.js";
  import { sharedFilters } from "../stores/filters.js";
  import { isRankedGroup } from "../../config/shared/numeric.js";

  const METRIC_VISIBLE_PREFETCH_LIMIT = 42;
  const METRIC_BACKGROUND_PREFETCH_LIMIT = 210;
  const HOTSET_REFRESH_DELAY_MS = 4_000;
  const HOTSET_REFRESH_LIMIT = 12;

  let filter: InventoryFilterTab = "all_parts";
  let showFilterPanel = false;
  let selectedInternalName: string | null = null;
  let orderBookPanelOpen = true;
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

    hydration.enqueue(visible, $wfmItems, needs.orders ? { ...needs, network: true } : needs);
    hydration.enqueue(background, $wfmItems, { ...needs, ducats: false, orders: false });
  }

  function handleFilterSelect(event: CustomEvent<InventoryFilterTab>): void {
    filter = event.detail;
  }

  function handleToggleFilterPanel(): void {
    showFilterPanel = !showFilterPanel;
  }

  function handleItemSelect(event: CustomEvent<InventoryViewItem>): void {
    selectedInternalName = event.detail.internalName;
    orderBookPanelOpen = true;

    const selectedBaseItem = tabBaseItems.find((entry) => entry.internalName === event.detail.internalName);
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

  function closeOrderBookPanel(): void {
    selectedInternalName = null;
    orderBookPanelOpen = false;
  }

  function handleItemVisible(event: CustomEvent<InventoryViewItem>): void {
    const visibleBaseItem = tabBaseItems.find((entry) => entry.internalName === event.detail.internalName);
    if (!visibleBaseItem || !shouldHydrateMetrics(visibleBaseItem)) return;
    trackRankedHotset(visibleBaseItem);

    const isRankedTab = isRankedGroup(filter);
    hydration.enqueue([visibleBaseItem], $wfmItems, {
      price: true,
      ducats: false,
      orders: isRankedTab,
      network: isRankedTab,
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
    if (!$wfmItems || Object.keys($wfmItems).length === 0) return;

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
  });

  onDestroy(() => {
    clearHotsetRefreshTimer();

    hydration.pause();
  });

  $: ({ orderedNames, orderedSlugs } = buildOrderLookups($marketOrders));
  $: tabBaseItems = buildBaseInventoryItems(
    $parsedItems,
    filter,
    $wfmItems,
    orderedNames,
    orderedSlugs,
    $relicDb,
  );
  $: allRankedBaseItems = [
    ...buildBaseInventoryItems($parsedItems, "mods", $wfmItems, orderedNames, orderedSlugs, $relicDb),
    ...buildBaseInventoryItems($parsedItems, "arcanes", $wfmItems, orderedNames, orderedSlugs, $relicDb),
  ];
  $: tabItems = buildInventoryViewItems(tabBaseItems, $hydrationMetrics, filter);
  $: relicSearchKeywordIndex = buildRelicSearchKeywordIndex($relicDb);
  $: searchableTabItems =
    filter !== "relics"
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
  $: filtered = applySharedFiltersAndSort(searchableTabItems, $inventoryFilters);
  $: resourceList = ($inventoryData && Object.keys($itemDb).length > 0)
    ? parseResources($inventoryData, $itemDb)
    : [];
  function filterAndSortResources(
    list: typeof resourceList,
    filters: typeof $inventoryFilters,
  ): typeof resourceList {
    const search = filters.search.trim().toLowerCase();
    const searched = search
      ? list.filter(r =>
          r.name.toLowerCase().includes(search) ||
          r.internalName.toLowerCase().includes(search)
        )
      : list;
    const dir = filters.sortDirection === "asc" ? 1 : -1;
    return [...searched].sort((a, b) =>
      filters.sortBy === "amount"
        ? (a.count - b.count) * dir
        : a.name.localeCompare(b.name) * dir
    );
  }

  $: filteredResources = filterAndSortResources(resourceList, $inventoryFilters);
  $: filteredTotalCount = filter === "resources" ? filteredResources.length : filtered.length;
  $: showDucats = filter === "all_parts" || filter === "full_sets";
  $: metricNeeds = metricNeedsFromFilters($inventoryFilters, filter);
  $: if ($startupPriceCacheReady && Object.keys($wfmItems).length > 0) {
    prefetchVisibleMetrics(filtered, metricNeeds);
    maybeScheduleRankedHotsetRefresh(allRankedBaseItems);
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

  {#if filter === "resources"}
    <ResourcesView resources={filteredResources} />
  {:else}
    {#if showFilterPanel}
      <div class="inventory-filter-popover mb-3.5 max-h-[67vh] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-2.5 shadow-[var(--ui-panel-shadow)] [backdrop-filter:var(--ui-backdrop-blur)]">
        <SharedFilterBar scope="inventory" showBasic={false} showAdvanced={true} />
      </div>
    {/if}

    <div class="grid grid-cols-1 items-start gap-3 {orderBookPanelOpen ? 'min-[1101px]:grid-cols-[minmax(0,1fr)_360px]' : ''}">
      <div class="min-w-0">
        <InventoryGrid
          items={filtered}
          {showDucats}
          on:select={handleItemSelect}
          on:visible={handleItemVisible}
        />
      </div>

      {#if orderBookPanelOpen}
        <InventoryOrderBookPanel item={selectedItem} onClose={closeOrderBookPanel} />
      {/if}
    </div>
  {/if}
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
