<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { parsedItems, wfmItems } from "../stores/data.js";
  import { marketOrders } from "../stores/market.js";
  import { debugMode } from "../stores/app.js";
  import { activeItem } from "../stores/modals.js";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import { applySharedFiltersAndSort } from "../lib/filters.js";
  import {
    fetchPriceByName,
    getPriceDebugCounters,
    getPriceQueueStats,
    type PriceDebugCounters,
    type PriceQueueStats,
  } from "../lib/wfmPrice.js";
  import { fetchWfmItemMetaBySlug } from "../lib/wfmItemMeta.js";
  import { sharedFilters } from "../stores/filters.js";
  import ItemImage from "../components/ItemImage.svelte";
  import type { SharedFiltersState } from "../types/filters.js";
  import type { ParsedItem } from "../types/inventory.js";
  import type { WfmItemsLookup } from "../types/ipc.js";

  type InventoryFilterTab =
    | "all_parts"
    | "relics"
    | "mods"
    | "arcanes"
    | "full_sets"
    | "misc";

  interface InventoryBaseItem extends ParsedItem {
    inventoryGroup: InventoryFilterTab;
    partType: "normal" | "prime";
    amount: number;
    favorite: boolean;
    equipped: boolean;
    orderPlaced: boolean;
    completeSets: number | boolean | null;
    marketSlug: string | null;
    marketThumb: string | null;
  }

  interface InventoryViewItem extends InventoryBaseItem {
    platinum: number | null;
    ducats: number | null;
    ducatonator: number | null;
    displayImageUrl: string | null;
    equippedSummary: string | null;
    debugLabel: string;
  }

  interface ItemMetrics {
    platinum: number | null;
    ducats: number | null;
    slug: string | null;
    thumb: string | null;
    icon: string | null;
    hasPrice: boolean;
    hasDucats: boolean;
    hasMeta: boolean;
  }

  interface MetricNeeds {
    price: boolean;
    ducats: boolean;
  }

  interface HydrationTask {
    key: string;
    item: InventoryBaseItem;
    lookup: WfmItemsLookup;
    needs: MetricNeeds;
  }

  const FILTERS: Array<{ key: InventoryFilterTab; label: string }> = [
    { key: "all_parts", label: "All Parts" },
    { key: "relics", label: "Relics" },
    { key: "mods", label: "Mods" },
    { key: "arcanes", label: "Arcanes" },
    { key: "full_sets", label: "Full Sets" },
    { key: "misc", label: "Misc" },
  ];

  const METRIC_VISIBLE_PREFETCH_LIMIT = 42;
  const METRIC_BACKGROUND_PREFETCH_LIMIT = 210;
  const HYDRATION_BATCH_SIZE = 6;
  const HYDRATION_TICK_MS = 120;
  const METRIC_FLUSH_MS = 140;
  const DEBUG_REFRESH_MS = 900;

  let filter: InventoryFilterTab = "all_parts";
  let showFilterPanel = false;
  const inventoryFilters = sharedFilters("inventory");

  let metricsByKey: Record<string, ItemMetrics> = {};
  let pendingMetricPatches: Record<string, ItemMetrics> = {};
  let metricFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingMetricKeys: Record<string, true> = {};
  let queuedMetricKeys: Record<string, true> = {};
  let hydrationQueue: HydrationTask[] = [];
  let hydrationRunning = false;
  let isInventoryMounted = true;

  let priceQueueStats: PriceQueueStats = getPriceQueueStats();
  let priceDebugCounters: PriceDebugCounters = getPriceDebugCounters();
  let localHydrationStats = { queued: 0, pending: 0 };
  let debugStatsTimer: ReturnType<typeof setInterval> | null = null;

  function normalizeName(value: string): string {
    return value.trim().toLowerCase();
  }

  function normalizeLooseName(value: string): string {
    return normalizeName(value).replace(/[^a-z0-9]+/g, "");
  }

  function toMarketSlug(name: string): string {
    return normalizeName(name)
      .replace(/['']/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function itemGroupFallback(item: ParsedItem): InventoryFilterTab {
    const label = item.categoryLabel.toLowerCase();
    if (label.includes("relic")) return "relics";
    if (label.includes("mod")) return "mods";
    if (label.includes("arcane")) return "arcanes";
    if (item.tradable) return "all_parts";
    return "misc";
  }

  function matchesFilterTab(item: ParsedItem, tab: InventoryFilterTab): boolean {
    const group = item.inventoryGroup || itemGroupFallback(item);
    return group === tab;
  }

  function getLookupByName(itemName: string, lookup: WfmItemsLookup): WfmItemsLookup[string] | null {
    const key = normalizeName(itemName);
    const direct = lookup[key] || null;
    if (!direct) return null;

    const directRecord = direct as Record<string, unknown>;
    const mappedName =
      typeof directRecord.item_name === "string" ? directRecord.item_name : null;
    if (mappedName && normalizeLooseName(mappedName) !== normalizeLooseName(itemName)) {
      return null;
    }

    return direct;
  }

  function resolveSlug(item: ParsedItem, lookup: WfmItemsLookup): string | null {
    const lookupByName = getLookupByName(item.name, lookup);
    if (lookupByName?.url_name) return lookupByName.url_name;

    const generated = toMarketSlug(item.name);
    if (!generated) return null;

    if (item.inventoryGroup === "full_sets" || /\bset$/i.test(item.name)) {
      return generated.endsWith("_set") ? generated : `${generated}_set`;
    }

    return generated;
  }

  function shouldHydrateMetrics(item: ParsedItem): boolean {
    const group = item.inventoryGroup || itemGroupFallback(item);
    return (
      item.tradable ||
      group === "full_sets" ||
      group === "all_parts" ||
      group === "relics" ||
      group === "mods" ||
      group === "arcanes"
    );
  }

  function metricNeedsFromFilters(filters: SharedFiltersState): MetricNeeds {
    return {
      price: true,
      ducats: filters.sortBy === "ducats" || filters.sortBy === "ducatonator",
    };
  }

  async function hydrateItemMetrics(
    item: InventoryBaseItem,
    lookup: WfmItemsLookup,
    needs: MetricNeeds,
  ): Promise<void> {
    const key = item.internalName;
    const existing = metricsByKey[key];
    const needsIcon = item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes";
    const lookupEntry = getLookupByName(item.name, lookup);
    const lookupRecord = lookupEntry as Record<string, unknown> | null;
    const lookupHasIcon = Boolean(
      (lookupRecord && typeof lookupRecord.thumb === "string" && lookupRecord.thumb) ||
        (lookupRecord && typeof lookupRecord.icon === "string" && lookupRecord.icon) ||
        item.marketThumb,
    );
    const iconReady = !needsIcon || lookupHasIcon || existing?.hasMeta === true;

    if (
      existing &&
      (!needs.price || existing.hasPrice) &&
      (!needs.ducats || existing.hasDucats) &&
      iconReady
    ) {
      return;
    }

    if (pendingMetricKeys[key]) return;
    pendingMetricKeys = { ...pendingMetricKeys, [key]: true };

    try {
      let platinum = existing?.platinum ?? null;
      let ducats = existing?.ducats ?? null;
      let slug = existing?.slug || item.marketSlug || resolveSlug(item, lookup);
      let thumb = existing?.thumb || null;
      let icon = existing?.icon || null;
      let hasPrice = existing?.hasPrice || false;
      let hasDucats = existing?.hasDucats || false;
      let hasMeta = existing?.hasMeta || false;

      if (needs.price && !hasPrice) {
        const priceResult = await fetchPriceByName(item.name, lookup, {
          priority: "low",
        });
        if (priceResult?.median != null) {
          platinum = priceResult.median;
        }
        if (priceResult?.slug) {
          slug = priceResult.slug;
        }
        hasPrice = true;
      }

      const shouldFetchMeta =
        slug &&
        (needs.ducats || (needsIcon && !lookupHasIcon && !thumb && !icon && !hasMeta));

      if (shouldFetchMeta) {
        const meta = await fetchWfmItemMetaBySlug(slug);
        hasMeta = true;
        if (meta) {
          const metaRecord = meta as unknown as Record<string, unknown>;
          if (needs.ducats) {
            ducats = typeof metaRecord.ducats === "number" ? metaRecord.ducats : null;
            hasDucats = true;
          }
          if (needsIcon) {
            thumb =
              typeof metaRecord.thumb === "string" && metaRecord.thumb ? metaRecord.thumb : thumb;
            icon =
              typeof metaRecord.icon === "string" && metaRecord.icon ? metaRecord.icon : icon;
          }
        } else if (needs.ducats) {
          hasDucats = true;
        }
      }

      queueMetricPatch(key, {
        platinum,
        ducats,
        slug,
        thumb,
        icon,
        hasPrice,
        hasDucats,
        hasMeta,
      });
    } catch (error) {
      console.warn("[Inventory] metric hydration failed:", error);
    } finally {
      const rest = { ...pendingMetricKeys };
      delete rest[key];
      pendingMetricKeys = rest;
    }
  }

  function refreshDebugStats(): void {
    priceQueueStats = getPriceQueueStats();
    priceDebugCounters = getPriceDebugCounters();
    localHydrationStats = {
      queued: Object.keys(queuedMetricKeys).length,
      pending: Object.keys(pendingMetricKeys).length,
    };
  }

  function queueMetricPatch(key: string, metric: ItemMetrics): void {
    pendingMetricPatches = {
      ...pendingMetricPatches,
      [key]: metric,
    };

    if (metricFlushTimer) return;

    metricFlushTimer = setTimeout(() => {
      metricFlushTimer = null;
      if (Object.keys(pendingMetricPatches).length === 0) return;
      metricsByKey = {
        ...metricsByKey,
        ...pendingMetricPatches,
      };
      pendingMetricPatches = {};
    }, METRIC_FLUSH_MS);
  }

  async function runHydrationPump(): Promise<void> {
    if (hydrationRunning) return;
    hydrationRunning = true;

    try {
      while (isInventoryMounted && hydrationQueue.length > 0) {
        const batch = hydrationQueue.splice(0, HYDRATION_BATCH_SIZE);

        for (const task of batch) {
          const nextQueued = { ...queuedMetricKeys };
          delete nextQueued[task.key];
          queuedMetricKeys = nextQueued;

          if (!isInventoryMounted) break;
          await hydrateItemMetrics(task.item, task.lookup, task.needs);
        }

        refreshDebugStats();
        await new Promise((resolve) => setTimeout(resolve, HYDRATION_TICK_MS));
      }
    } finally {
      hydrationRunning = false;
      refreshDebugStats();
      if (isInventoryMounted && hydrationQueue.length > 0) {
        void runHydrationPump();
      }
    }
  }

  function queueHydrationTasks(
    items: InventoryBaseItem[],
    lookup: WfmItemsLookup,
    needs: MetricNeeds,
  ): void {
    let appended = false;

    for (const item of items) {
      if (!shouldHydrateMetrics(item)) continue;
      const key = item.internalName;
      if (pendingMetricKeys[key] || queuedMetricKeys[key]) continue;

      const existing = metricsByKey[key];
      const needsIcon = item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes";
      const iconReady = Boolean(item.marketThumb) || existing?.hasMeta === true;

      if (
        existing &&
        (!needs.price || existing.hasPrice) &&
        (!needs.ducats || existing.hasDucats) &&
        (!needsIcon || iconReady)
      ) {
        continue;
      }

      queuedMetricKeys = { ...queuedMetricKeys, [key]: true };
      hydrationQueue = [...hydrationQueue, { key, item, lookup, needs }];
      appended = true;
    }

    if (appended) {
      refreshDebugStats();
      void runHydrationPump();
    }
  }

  function prefetchVisibleMetrics(
    items: InventoryBaseItem[],
    lookup: WfmItemsLookup,
    needs: MetricNeeds,
  ): void {
    const visible = items.slice(0, METRIC_VISIBLE_PREFETCH_LIMIT);
    const background = items.slice(
      METRIC_VISIBLE_PREFETCH_LIMIT,
      METRIC_VISIBLE_PREFETCH_LIMIT + METRIC_BACKGROUND_PREFETCH_LIMIT,
    );

    queueHydrationTasks(visible, lookup, needs);
    queueHydrationTasks(background, lookup, { ...needs, ducats: false });
  }

  onMount(() => {
    isInventoryMounted = true;
    refreshDebugStats();

    if (debugStatsTimer) clearInterval(debugStatsTimer);
    debugStatsTimer = setInterval(() => {
      if (!$debugMode) return;
      refreshDebugStats();
    }, DEBUG_REFRESH_MS);
  });

  onDestroy(() => {
    isInventoryMounted = false;
    hydrationQueue = [];
    queuedMetricKeys = {};
    if (metricFlushTimer) {
      clearTimeout(metricFlushTimer);
      metricFlushTimer = null;
    }
    if (debugStatsTimer) {
      clearInterval(debugStatsTimer);
      debugStatsTimer = null;
    }
  });

  $: orderedNames = Object.fromEntries(
    [...$marketOrders.sell, ...$marketOrders.buy]
      .map((order) => normalizeName(order.itemName || ""))
      .filter(Boolean)
      .map((name) => [name, true]),
  ) as Record<string, true>;
  $: orderedSlugs = Object.fromEntries(
    [...$marketOrders.sell, ...$marketOrders.buy]
      .map((order) => (order.itemUrlName || "").trim().toLowerCase())
      .filter(Boolean)
      .map((slug) => [slug, true]),
  ) as Record<string, true>;

  $: tabBaseItems = $parsedItems
    .filter((item) => matchesFilterTab(item, filter))
    .map<InventoryBaseItem>((item) => {
      const group = (item.inventoryGroup || itemGroupFallback(item)) as InventoryFilterTab;
      const lookupByName = getLookupByName(item.name, $wfmItems);
      const marketSlug = lookupByName?.url_name || resolveSlug(item, $wfmItems);
      const lookupRecord = lookupByName as Record<string, unknown> | null;
      const marketThumb =
        (lookupRecord && typeof lookupRecord.thumb === "string" && lookupRecord.thumb) ||
        (lookupRecord && typeof lookupRecord.icon === "string" && lookupRecord.icon) ||
        null;

      const orderPlaced =
        Boolean(orderedNames[normalizeName(item.name)]) ||
        (marketSlug ? Boolean(orderedSlugs[marketSlug]) : false);

      return {
        ...item,
        inventoryGroup: group,
        partType: (item.partType || (item.isPrime ? "prime" : "normal")) as "normal" | "prime",
        amount: typeof item.amount === "number" ? item.amount : 1,
        favorite: Boolean(item.favorite),
        equipped: Boolean(item.equipped),
        orderPlaced,
        completeSets:
          typeof item.completeSets === "number" || typeof item.completeSets === "boolean"
            ? item.completeSets
            : null,
        marketSlug,
        marketThumb,
      };
    });

  $: tabItems = tabBaseItems.map<InventoryViewItem>((item) => {
    const metric = metricsByKey[item.internalName] || null;
    const platinum = metric?.platinum ?? null;
    const ducats = metric?.ducats ?? null;
    const ducatonator =
      ducats != null && platinum != null && platinum > 0 ? Number((ducats / platinum).toFixed(2)) : null;

    const iconFromMeta = metric?.thumb || metric?.icon || null;
    const displayImageUrl =
      item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes"
        ? iconFromMeta || item.marketThumb || item.imageUrl || null
        : item.imageUrl || item.marketThumb || iconFromMeta || null;

    const equippedInList = Array.isArray(item.equippedIn) ? item.equippedIn : [];
    const equippedSummary =
      equippedInList.length > 0
        ? `Equipped in ${equippedInList.slice(0, 2).join(", ")}${equippedInList.length > 2 ? " +" : ""}`
        : null;

    return {
      ...item,
      platinum,
      ducats,
      ducatonator,
      displayImageUrl,
      equippedSummary,
      debugLabel: item.debugReason || `show:inventory:${filter}:${item.inventoryGroup}`,
    };
  });

  $: filtered = applySharedFiltersAndSort<InventoryViewItem>(tabItems, $inventoryFilters);
  $: filteredTotalCount = filtered.reduce((sum, item) => sum + Math.max(1, item.amount || 1), 0);
  $: metricNeeds = metricNeedsFromFilters($inventoryFilters);
  $: prefetchVisibleMetrics(filtered, $wfmItems, metricNeeds);
  $: if ($debugMode) {
    refreshDebugStats();
  }
</script>

<section class="view active">
  <div class="view-header">
    <h2>Inventory ({filteredTotalCount})</h2>
    <div class="view-controls inventory-controls">
      <div class="filter-tabs">
        {#each FILTERS as f}
          <button
            class="filter-tab"
            class:active={filter === f.key}
            on:click={() => (filter = f.key)}
          >{f.label}</button>
        {/each}
      </div>

      <SharedFilterBar
        scope="inventory"
        singleLine={true}
        showBasic={true}
        showAdvanced={false}
        basicVariant="quick"
      />

      <button
        class="filter-tab inventory-filter-toggle"
        class:active={showFilterPanel}
        on:click={() => {
          showFilterPanel = !showFilterPanel;
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 5h18" />
          <path d="M6 12h12" />
          <path d="M10 19h4" />
        </svg>
        Filters
      </button>
    </div>
  </div>

  {#if $debugMode}
    <div class="inventory-debug-panel">
      <span>tab={filter}</span>
      <span>queue={priceQueueStats.high}/{priceQueueStats.normal}/{priceQueueStats.low}</span>
      <span>pending={localHydrationStats.pending}</span>
      <span>queued={localHydrationStats.queued}</span>
      <span>http={priceDebugCounters.httpCalls}</span>
      <span>cacheOk={priceDebugCounters.cacheHitOk}</span>
      <span>429={priceDebugCounters.rateLimited}</span>
    </div>
  {/if}

  {#if showFilterPanel}
    <div class="inventory-filter-popover">
      <SharedFilterBar scope="inventory" showBasic={false} showAdvanced={true} />
    </div>
  {/if}

  <div class="item-grid">
    {#if filtered.length === 0}
      <div class="empty-state col-span-full">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <p>No items found</p>
      </div>
    {:else}
      {#each filtered as item}
        {@const mastered = item.rank >= item.maxRank && item.maxRank > 1}
        {@const canShowRank = item.maxRank > 1 && (item.inventoryGroup === "mods" || item.inventoryGroup === "arcanes")}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div
          class="item-card"
          class:mastered
          class:prime={item.isPrime}
          on:click={() => activeItem.set(item)}
        >
          <div class="item-img-wrap">
            <ItemImage src={item.displayImageUrl} alt={item.name} />
            {#if item.isPrime}<span class="prime-badge">PRIME</span>{/if}
            {#if item.vaulted}<span class="vault-badge">V</span>{/if}
            <span class="inventory-count-badge">x{item.amount}</span>
          </div>
          <div class="item-body">
            <span class="item-name">{item.name}</span>
            <span class="item-type">
              {item.categoryLabel}
              {#if item.inventoryGroup === "full_sets"}
                {` · Complete ${typeof item.completeSets === "number" ? item.completeSets : 0}`}
              {/if}
            </span>

            <div class="inventory-value-row">
              {#if item.platinum != null}
                <span class="inventory-value-pill inventory-value-pill-plat">~{item.platinum}p</span>
              {/if}
              {#if item.ducats != null}
                <span class="inventory-value-pill">{item.ducats}d</span>
              {/if}
              {#if item.ducatonator != null}
                <span class="inventory-value-pill">{item.ducatonator} d/p</span>
              {/if}
            </div>

            {#if canShowRank}
              <div class="item-rank-bar">
                <div
                  class="rank-fill"
                  class:max={mastered}
                  class:partial={!mastered}
                  style="width:{(item.rank / item.maxRank) * 100}%"
                ></div>
              </div>
              <span class="item-rank-text">{item.rank}/{item.maxRank}</span>
            {/if}

            {#if item.equippedSummary}
              <span class="inventory-equipped-note">{item.equippedSummary}</span>
            {/if}

            {#if $debugMode}
              <span class="debug-reason">{item.debugLabel}</span>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</section>
