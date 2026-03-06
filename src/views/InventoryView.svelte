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
  import { getCachedPriceState } from "../lib/wfm/priceCache.js";
  import { startupPriceCacheReady } from "../lib/startupLoader.js";
  import { getInventoryHydrationController } from "../stores/inventoryHydration.js";
  import { sharedFilters } from "../stores/filters.js";

  const METRIC_VISIBLE_PREFETCH_LIMIT = 42;
  const METRIC_BACKGROUND_PREFETCH_LIMIT = 210;
  const DEBUG_REFRESH_MS = 900;
  const MISSING_PRICE_SWEEP_STORAGE_KEY = "inventory:missing-price-sweep:v1";
  const MISSING_PRICE_SWEEP_BATCH_SIZE = 36;
  const MISSING_PRICE_SWEEP_INTERVAL_MS = 1_500;
  const MISSING_PRICE_SWEEP_MAX_RUNTIME_MS = 120_000;

  let filter: InventoryFilterTab = "all_parts";
  let showFilterPanel = false;
  let selectedInternalName: string | null = null;
  const FILTERS = INVENTORY_FILTERS;
  const inventoryFilters = sharedFilters("inventory");

  const hydration = getInventoryHydrationController();
  const hydrationMetrics = hydration.metricsByKey;
  const hydrationDebug = hydration.debugState;
  let debugStatsTimer: ReturnType<typeof setInterval> | null = null;
  let missingPriceSweepTimer: ReturnType<typeof setTimeout> | null = null;
  let missingPriceSweepQueue: InventoryBaseItem[] = [];
  let missingPriceSweepCursor = 0;
  let missingPriceSweepActive = false;
  let missingPriceSweepDone = false;
  let missingPriceSweepDeadline = 0;

  function prefetchVisibleMetrics(items: InventoryBaseItem[], needs: MetricNeeds): void {
    const hydrationCandidates = items.filter((item) => shouldHydrateMetrics(item));
    const rankedTab = filter === "mods" || filter === "arcanes";
    const visibleLimit = rankedTab ? 12 : METRIC_VISIBLE_PREFETCH_LIMIT;
    const backgroundLimit = rankedTab ? 0 : METRIC_BACKGROUND_PREFETCH_LIMIT;

    const visible = hydrationCandidates.slice(0, visibleLimit);
    const background = hydrationCandidates.slice(
      visibleLimit,
      visibleLimit + backgroundLimit,
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
      hydration.enqueue([selectedBaseItem], $wfmItems, { price: true, ducats: false, orders: true });
    }
  }

  function hasResolvedPlatinum(item: InventoryBaseItem): boolean {
    const metric = $hydrationMetrics[item.internalName];
    const hasMetricPlatinum = Boolean(
      (typeof metric?.platinum === "number" && Number.isFinite(metric.platinum)) ||
        (typeof metric?.platinumR0 === "number" && Number.isFinite(metric.platinumR0)) ||
        (typeof metric?.platinumRmax === "number" && Number.isFinite(metric.platinumRmax)),
    );
    if (hasMetricPlatinum) return true;

    if (!item.marketSlug) return false;

    if (item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes") {
      const fallbackMaxRank = item.inventoryGroup === "mods" ? 10 : 5;
      const parsedMaxRank = Number(item.maxRank);
      const maxRank =
        Number.isFinite(parsedMaxRank) && parsedMaxRank > 0 ? Math.floor(parsedMaxRank) : fallbackMaxRank;
      const cachedR0 = getCachedPriceState(`${item.marketSlug}:rank-v3:r0`);
      const cachedRmax = getCachedPriceState(`${item.marketSlug}:rank-v3:r${maxRank}`);
      return cachedR0?.status === "ok" && cachedRmax?.status === "ok";
    }

    const cached = getCachedPriceState(item.marketSlug);
    return cached?.status === "ok";
  }

  function shouldSweepMissingPrice(item: InventoryBaseItem): boolean {
    if (item.tradable !== true) return false;
    if (item.inventoryGroup !== "mods" && item.inventoryGroup !== "arcanes") return false;
    return !hasResolvedPlatinum(item);
  }

  function readMissingPriceSweepFlag(): boolean {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(MISSING_PRICE_SWEEP_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function writeMissingPriceSweepFlag(): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(MISSING_PRICE_SWEEP_STORAGE_KEY, "1");
    } catch {
      return;
    }
  }

  function clearMissingPriceSweepTimer(): void {
    if (!missingPriceSweepTimer) return;
    clearTimeout(missingPriceSweepTimer);
    missingPriceSweepTimer = null;
  }

  function stopMissingPriceSweep(markDone: boolean): void {
    clearMissingPriceSweepTimer();
    missingPriceSweepActive = false;
    missingPriceSweepQueue = [];
    missingPriceSweepCursor = 0;
    missingPriceSweepDeadline = 0;

    if (!markDone) return;
    missingPriceSweepDone = true;
    writeMissingPriceSweepFlag();
  }

  function buildMissingPriceSweepQueue(): InventoryBaseItem[] {
    const modItems = buildBaseInventoryItems($parsedItems, "mods", $wfmItems, orderedNames, orderedSlugs);
    const arcaneItems = buildBaseInventoryItems(
      $parsedItems,
      "arcanes",
      $wfmItems,
      orderedNames,
      orderedSlugs,
    );

    const uniqueByInternalName = Object.create(null) as Record<string, InventoryBaseItem>;
    for (const item of [...modItems, ...arcaneItems]) {
      if (!Object.prototype.hasOwnProperty.call(uniqueByInternalName, item.internalName)) {
        uniqueByInternalName[item.internalName] = item;
      }
    }

    return Object.values(uniqueByInternalName).filter((item) => shouldSweepMissingPrice(item));
  }

  function scheduleMissingPriceSweepTick(): void {
    clearMissingPriceSweepTimer();
    missingPriceSweepTimer = setTimeout(() => {
      runMissingPriceSweepTick();
    }, MISSING_PRICE_SWEEP_INTERVAL_MS);
  }

  function runMissingPriceSweepTick(): void {
    if (!missingPriceSweepActive) return;
    if (Date.now() >= missingPriceSweepDeadline) {
      stopMissingPriceSweep(false);
      return;
    }

    const batch: InventoryBaseItem[] = [];
    while (
      missingPriceSweepCursor < missingPriceSweepQueue.length &&
      batch.length < MISSING_PRICE_SWEEP_BATCH_SIZE
    ) {
      const candidate = missingPriceSweepQueue[missingPriceSweepCursor];
      missingPriceSweepCursor += 1;
      if (!shouldSweepMissingPrice(candidate)) continue;
      batch.push(candidate);
    }

    if (batch.length > 0) {
      hydration.enqueue(batch, $wfmItems, { price: true, ducats: false, orders: false });
    }

    if (missingPriceSweepCursor >= missingPriceSweepQueue.length) {
      stopMissingPriceSweep(true);
      return;
    }

    scheduleMissingPriceSweepTick();
  }

  function maybeStartMissingPriceSweep(): void {
    if (!$startupPriceCacheReady) return;
    if (missingPriceSweepDone || missingPriceSweepActive) return;
    if (!Array.isArray($parsedItems) || $parsedItems.length === 0) return;
    if (!$wfmItems || Object.keys($wfmItems).length === 0) return;

    const queue = buildMissingPriceSweepQueue();
    if (queue.length === 0) {
      stopMissingPriceSweep(true);
      return;
    }

    missingPriceSweepQueue = queue;
    missingPriceSweepCursor = 0;
    missingPriceSweepDeadline = Date.now() + MISSING_PRICE_SWEEP_MAX_RUNTIME_MS;
    missingPriceSweepActive = true;
    runMissingPriceSweepTick();
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
    missingPriceSweepDone = readMissingPriceSweepFlag();
    hydration.resume();
    hydration.refreshDebugStats();

    if (debugStatsTimer) clearInterval(debugStatsTimer);
    debugStatsTimer = setInterval(() => {
      if (!$debugMode) return;
      hydration.refreshDebugStats();
    }, DEBUG_REFRESH_MS);
  });

  onDestroy(() => {
    clearMissingPriceSweepTimer();
    missingPriceSweepActive = false;

    hydration.pause();
    if (debugStatsTimer) {
      clearInterval(debugStatsTimer);
      debugStatsTimer = null;
    }
  });

  $: ({ orderedNames, orderedSlugs } = buildOrderLookups($marketOrders));
  $: tabBaseItems = buildBaseInventoryItems($parsedItems, filter, $wfmItems, orderedNames, orderedSlugs);
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
    maybeStartMissingPriceSweep();
  }
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

  <div class="inventory-split-layout">
    <div class="inventory-split-main">
      <InventoryGrid items={filtered} showDebug={$debugMode} {showDucats} on:select={handleItemSelect} />
    </div>

    <InventoryOrderBookPanel item={selectedItem} />
  </div>
</section>
