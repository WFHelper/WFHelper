<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { parsedItems, wfmItems } from "../stores/data.js";
  import { marketOrders } from "../stores/market.js";
  import { relicDb } from "../stores/relics.js";
  import { debugMode } from "../stores/app.js";
  import InventoryHeader from "../components/inventory/InventoryHeader.svelte";
  import InventoryDebugPanel from "../components/inventory/InventoryDebugPanel.svelte";
  import InventoryGrid from "../components/inventory/InventoryGrid.svelte";
  import InventoryOrderBookPanel from "../components/inventory/InventoryOrderBookPanel.svelte";
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
  import { buildRelicSearchKeywordIndex } from "../lib/relic.js";
  import { startupPriceCacheReady } from "../lib/startupLoader.js";
  import { log } from "../lib/log.js";
  import { getOrderSummaryCircuitState } from "../lib/wfm/orderSummaryRemote.js";
  import {
    getRankedHotsetEntries,
    getRankedHotsetSeenAt,
    recordRankedHotsetEntry,
  } from "../lib/wfm/rankedHotset.js";
  import { getInventoryHydrationController } from "../stores/inventoryHydration.js";
  import { sharedFilters } from "../stores/filters.js";
  import sharedNumeric from "../../config/shared/numeric.cjs";

  const { isRankedGroup } = sharedNumeric as {
    isRankedGroup: (group: string | null | undefined) => boolean;
  };

  const METRIC_VISIBLE_PREFETCH_LIMIT = 42;
  const METRIC_BACKGROUND_PREFETCH_LIMIT = 210;
  const DEBUG_REFRESH_MS = 900;
  const HOTSET_REFRESH_DELAY_MS = 4_000;
  const HOTSET_REFRESH_LIMIT = 12;
  const RANKED_CARD_SWEEP_ENABLED = false;
  const RANKED_CARD_SWEEP_MAX_ITEMS = 24;
  const RANKED_CARD_SWEEP_BATCH_SIZE = 4;
  const RANKED_CARD_SWEEP_INTERVAL_MS = 2_500;
  const RANKED_CARD_SWEEP_START_DELAY_MS = 12_000;
  const RANKED_CARD_SWEEP_MAX_RUNTIME_MS = 2 * 60 * 1000;

  let filter: InventoryFilterTab = "all_parts";
  let showFilterPanel = false;
  let selectedInternalName: string | null = null;
  const FILTERS = INVENTORY_FILTERS;
  const inventoryFilters = sharedFilters("inventory");

  const hydration = getInventoryHydrationController();
  const hydrationMetrics = hydration.metricsByKey;
  const hydrationDebug = hydration.debugState;
  let debugStatsTimer: ReturnType<typeof setInterval> | null = null;
  let rankedCardSweepTimer: ReturnType<typeof setTimeout> | null = null;
  let rankedCardSweepStartTimer: ReturnType<typeof setTimeout> | null = null;
  let hotsetRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let rankedCardSweepQueue: InventoryBaseItem[] = [];
  let rankedCardSweepCursor = 0;
  let rankedCardSweepActive = false;
  let rankedCardSweepDeadline = 0;
  let rankedCardSweepSignature = "";
  let rankedCardSweepCompletedSignature = "";
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

    hydration.enqueue(visible, $wfmItems, needs);
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

    const selectedBaseItem = tabBaseItems.find((entry) => entry.internalName === event.detail.internalName);
    if (selectedBaseItem && shouldHydrateMetrics(selectedBaseItem)) {
      trackRankedHotset(selectedBaseItem);
      hydration.enqueue([selectedBaseItem], $wfmItems, { price: true, ducats: false, orders: true });
    }
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
    });
  }

  function clearRankedCardSweepTimer(): void {
    if (!rankedCardSweepTimer) return;
    clearTimeout(rankedCardSweepTimer);
    rankedCardSweepTimer = null;
  }

  function clearRankedCardSweepStartTimer(): void {
    if (!rankedCardSweepStartTimer) return;
    clearTimeout(rankedCardSweepStartTimer);
    rankedCardSweepStartTimer = null;
  }

  function clearHotsetRefreshTimer(): void {
    if (!hotsetRefreshTimer) return;
    clearTimeout(hotsetRefreshTimer);
    hotsetRefreshTimer = null;
  }

  function stopRankedCardSweep(markCompleted: boolean): void {
    clearRankedCardSweepTimer();
    clearRankedCardSweepStartTimer();
    rankedCardSweepActive = false;
    rankedCardSweepQueue = [];
    rankedCardSweepCursor = 0;
    rankedCardSweepDeadline = 0;

    if (markCompleted && rankedCardSweepSignature) {
      rankedCardSweepCompletedSignature = rankedCardSweepSignature;
    }
  }

  function buildRankedCardSweepSignature(items: InventoryViewItem[]): string {
    const keys = items.map((item) => item.internalName).sort();
    return `${filter}:${keys.join("|")}`;
  }

  function buildRankedCardSweepQueue(items: InventoryViewItem[]): InventoryBaseItem[] {
    const baseByKey = Object.create(null) as Record<string, InventoryBaseItem>;
    for (const item of tabBaseItems) {
      baseByKey[item.internalName] = item;
    }

    const uniqueByInternalName = Object.create(null) as Record<string, InventoryBaseItem>;
    for (const viewItem of items) {
      const base = baseByKey[viewItem.internalName];
      if (!base) continue;
      if (!shouldHydrateMetrics(base)) continue;
      if (!isRankedGroup(base.inventoryGroup)) continue;
      if (base.tradable !== true) continue;
      uniqueByInternalName[base.internalName] = base;
    }

    return Object.values(uniqueByInternalName).sort((a, b) => {
      const seenDiff = getRankedHotsetSeenAt(b.marketSlug) - getRankedHotsetSeenAt(a.marketSlug);
      if (seenDiff !== 0) return seenDiff;
      return a.name.localeCompare(b.name);
    }).slice(0, RANKED_CARD_SWEEP_MAX_ITEMS);
  }

  function scheduleRankedCardSweepTick(delayMs = RANKED_CARD_SWEEP_INTERVAL_MS): void {
    clearRankedCardSweepTimer();
    rankedCardSweepTimer = setTimeout(() => {
      runRankedCardSweepTick();
    }, delayMs);
  }

  function scheduleRankedCardSweepStart(): void {
    clearRankedCardSweepStartTimer();
    rankedCardSweepStartTimer = setTimeout(() => {
      rankedCardSweepStartTimer = null;
      runRankedCardSweepTick();
    }, RANKED_CARD_SWEEP_START_DELAY_MS);
  }

  function runRankedCardSweepTick(): void {
    if (!rankedCardSweepActive) return;
    const circuit = getOrderSummaryCircuitState();
    if (circuit.open) {
      scheduleRankedCardSweepTick(Math.max(circuit.retryAfterMs, RANKED_CARD_SWEEP_INTERVAL_MS));
      return;
    }
    if (Date.now() >= rankedCardSweepDeadline) {
      log.warn("[Inventory] ranked card sweep timed out before completion");
      stopRankedCardSweep(false);
      return;
    }

    const batch: InventoryBaseItem[] = [];
    while (
      rankedCardSweepCursor < rankedCardSweepQueue.length &&
      batch.length < RANKED_CARD_SWEEP_BATCH_SIZE
    ) {
      const candidate = rankedCardSweepQueue[rankedCardSweepCursor];
      rankedCardSweepCursor += 1;
      batch.push(candidate);
    }

    if (batch.length > 0) {
      hydration.enqueue(batch, $wfmItems, { price: true, ducats: false, orders: true });
    }

    if (rankedCardSweepCursor >= rankedCardSweepQueue.length) {
      log.info(`[Inventory] ranked card sweep completed (${rankedCardSweepQueue.length} items)`);
      stopRankedCardSweep(true);
      return;
    }

    scheduleRankedCardSweepTick();
  }

  function maybeStartRankedCardSweep(items: InventoryViewItem[]): void {
    if (!RANKED_CARD_SWEEP_ENABLED) {
      stopRankedCardSweep(false);
      rankedCardSweepSignature = "";
      rankedCardSweepCompletedSignature = "";
      return;
    }

    if (!$startupPriceCacheReady) return;
    if (!isRankedGroup(filter)) {
      stopRankedCardSweep(false);
      rankedCardSweepSignature = "";
      rankedCardSweepCompletedSignature = "";
      return;
    }
    if (!Array.isArray($parsedItems) || $parsedItems.length === 0) return;
    if (!$wfmItems || Object.keys($wfmItems).length === 0) return;

    const signature = buildRankedCardSweepSignature(items);
    if (rankedCardSweepActive && signature === rankedCardSweepSignature) {
      return;
    }
    if (!rankedCardSweepActive && signature === rankedCardSweepCompletedSignature) {
      return;
    }

    const queue = buildRankedCardSweepQueue(items);
    if (queue.length === 0) {
      stopRankedCardSweep(true);
      rankedCardSweepSignature = signature;
      rankedCardSweepCompletedSignature = signature;
      return;
    }

    if (rankedCardSweepActive) {
      clearRankedCardSweepTimer();
    }

    rankedCardSweepSignature = signature;
    rankedCardSweepQueue = queue;
    rankedCardSweepCursor = 0;
    rankedCardSweepDeadline = Date.now() + RANKED_CARD_SWEEP_MAX_RUNTIME_MS;
    rankedCardSweepActive = true;

    log.info(
      `[Inventory] starting ranked card sweep (${queue.length} items max, batch=${RANKED_CARD_SWEEP_BATCH_SIZE}, interval=${RANKED_CARD_SWEEP_INTERVAL_MS}ms)`,
    );

    scheduleRankedCardSweepStart();
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
        hydration.enqueue(queue, $wfmItems, { price: true, ducats: false, orders: true });
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
    hydration.refreshDebugStats();

    if (debugStatsTimer) clearInterval(debugStatsTimer);
    debugStatsTimer = setInterval(() => {
      if (!$debugMode) return;
      hydration.refreshDebugStats();
    }, DEBUG_REFRESH_MS);
  });

  onDestroy(() => {
    clearRankedCardSweepTimer();
    clearRankedCardSweepStartTimer();
    clearHotsetRefreshTimer();
    rankedCardSweepActive = false;

    hydration.pause();
    if (debugStatsTimer) {
      clearInterval(debugStatsTimer);
      debugStatsTimer = null;
    }
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
  $: filteredTotalCount = computeFilteredTotalCount(filtered);
  $: showDucats = filter === "all_parts" || filter === "full_sets";
  $: metricNeeds = metricNeedsFromFilters($inventoryFilters, filter);
  $: if ($startupPriceCacheReady && Object.keys($wfmItems).length > 0) {
    prefetchVisibleMetrics(filtered, metricNeeds);
    maybeScheduleRankedHotsetRefresh(allRankedBaseItems);
    maybeStartRankedCardSweep(filtered);
  }
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
      backendHitOk={$hydrationDebug.priceDebugCounters.backendHitOk}
      backendHitNoData={$hydrationDebug.priceDebugCounters.backendHitNoData}
      backendError={$hydrationDebug.priceDebugCounters.backendError}
    />
  {/if}

  {#if showFilterPanel}
    <div class="inventory-filter-popover">
      <SharedFilterBar scope="inventory" showBasic={false} showAdvanced={true} />
    </div>
  {/if}

  <div class="inventory-split-layout">
    <div class="inventory-split-main">
      <InventoryGrid
        items={filtered}
        showDebug={$debugMode}
        {showDucats}
        on:select={handleItemSelect}
        on:visible={handleItemVisible}
      />
    </div>

    <InventoryOrderBookPanel item={selectedItem} />
  </div>
</section>
