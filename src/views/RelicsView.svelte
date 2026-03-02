<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import {
    relicDb,
    relicEvRevision,
    relicOwnedCounts,
    relicQualityMode,
    relicSearch,
    relicSortMode,
    relicSquadSize,
    relicTierFilter,
  } from "../stores/relics.js";
  import { inventoryData } from "../stores/data.js";
  import { activeRelic } from "../stores/modals.js";
  import { priceCacheRevision } from "../stores/pricing.js";
  import {
    configureRelicRuntimeCacheFingerprint,
    RELIC_ICON_PATHS,
    RELIC_TIER_ORDER,
    cancelWarmup,
    evHasFreshNoData,
    fissureTierClass,
    getCachedEv,
    getCachedRelicCardPrice,
    parseOwnedRelics,
    warmupRelicCardPrices,
    warmupRelicEvs,
  } from "../lib/relic.js";
  import { ipc } from "../lib/ipc.js";
  import type { RelicGroup } from "../types/relics.js";

  const TIER_OPTIONS: Array<[string, string]> = [
    ["all", "All"],
    ["Lith", "Lith"],
    ["Meso", "Meso"],
    ["Neo", "Neo"],
    ["Axi", "Axi"],
    ["Requiem", "Requiem"],
  ];

  const SORT_OPTIONS: Array<["tier" | "ev_desc" | "ev_asc", string]> = [
    ["tier", "Default"],
    ["ev_desc", "Plat desc"],
    ["ev_asc", "Plat asc"],
  ];

  const QUALITY_OPTIONS: Array<
    ["best" | "intact" | "exceptional" | "flawless" | "radiant", string]
  > = [
    ["best", "Best"],
    ["intact", "Intact"],
    ["exceptional", "Exceptional"],
    ["flawless", "Flawless"],
    ["radiant", "Radiant"],
  ];

  const SQUAD_OPTIONS: Array<[number, string]> = [
    [1, "Solo"],
    [2, "2P"],
    [3, "3P"],
    [4, "4P"],
  ];

  const EV_WARMUP_UI_DEBOUNCE_MS = 800;
  const CARD_WARMUP_UI_DEBOUNCE_MS = 450;
  const EV_WARMUP_START_DELAY_MS = 2000;
  const PRICE_UPDATE_EV_REFRESH_DEBOUNCE_MS = 400;

  let loading = false;
  let error = "";
  let groups: RelicGroup[] = [];
  let evWarmupStartTimer: ReturnType<typeof setTimeout> | null = null;
  let evUiDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let cardUiDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let priceUpdateEvRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  const onEvBatchDone = () => {
    if (evUiDebounceTimer) clearTimeout(evUiDebounceTimer);
    evUiDebounceTimer = setTimeout(
      () => relicEvRevision.update((value) => value + 1),
      EV_WARMUP_UI_DEBOUNCE_MS,
    );
  };

  const onCardBatchDone = () => {
    if (cardUiDebounceTimer) clearTimeout(cardUiDebounceTimer);
    cardUiDebounceTimer = setTimeout(
      () => relicEvRevision.update((value) => value + 1),
      CARD_WARMUP_UI_DEBOUNCE_MS,
    );
  };

  onMount(async () => {
    if (!$relicDb) {
      loading = true;
      try {
        const db = await ipc.getRelicDatabase();
        relicDb.set(db);
        if ($inventoryData) {
          relicOwnedCounts.set(parseOwnedRelics($inventoryData, db));
        }
      } catch (e) {
        error = "Failed to load relic database.";
        console.error("[Relics] getRelicDatabase failed:", e);
      } finally {
        loading = false;
      }
    }

    if ($relicDb) {
      startWarmup();
    }
  });

  // Stop this view's background warmups after navigation.
  onDestroy(() => {
    cancelWarmup();
    if (evWarmupStartTimer) clearTimeout(evWarmupStartTimer);
    if (evUiDebounceTimer) clearTimeout(evUiDebounceTimer);
    if (cardUiDebounceTimer) clearTimeout(cardUiDebounceTimer);
    if (priceUpdateEvRefreshTimer) clearTimeout(priceUpdateEvRefreshTimer);
  });

  // Keep owned relic counts in sync regardless of whether relic DB was loaded
  // from this view or preloaded elsewhere (App startup warmup).
  $: if ($relicDb && $inventoryData) {
    relicOwnedCounts.set(parseOwnedRelics($inventoryData, $relicDb));
  }

  $: if ($relicDb) {
    configureRelicRuntimeCacheFingerprint($relicDb);
  }

  $: if (!$inventoryData) {
    relicOwnedCounts.set({});
  }

  // Re-run EV warmup for the currently selected squad/quality.
  $: if ($relicSquadSize || $relicQualityMode) {
    if ($relicDb) startWarmup();
  }

  // When any background or modal fetch writes fresh prices into cache,
  // rebuild EV snapshots from the updated reward prices.
  $: if ($priceCacheRevision && $relicDb) {
    scheduleEvRefreshFromPriceUpdate();
  }

  function isOwnedRelicGroup(groupKey: string): boolean {
    const owned = $relicOwnedCounts[groupKey];
    return Boolean(owned && Object.values(owned).some((count) => count > 0));
  }

  function splitWarmupGroups(allGroups: RelicGroup[]): {
    ownedGroups: RelicGroup[];
    unownedGroups: RelicGroup[];
  } {
    const ownedGroups: RelicGroup[] = [];
    const unownedGroups: RelicGroup[] = [];

    for (const group of allGroups) {
      if (isOwnedRelicGroup(group.key)) {
        ownedGroups.push(group);
      } else {
        unownedGroups.push(group);
      }
    }

    return { ownedGroups, unownedGroups };
  }

  function scheduleEvRefreshFromPriceUpdate(): void {
    if (priceUpdateEvRefreshTimer) return;

    priceUpdateEvRefreshTimer = setTimeout(() => {
      priceUpdateEvRefreshTimer = null;
      if (!$relicDb || !groups.length) return;
      void warmupRelicEvs(groups, onEvBatchDone);
    }, PRICE_UPDATE_EV_REFRESH_DEBOUNCE_MS);
  }

  function startWarmup(): void {
    const allGroups = Object.values($relicDb?.groups || {});
    if (!allGroups.length) return;

    const { ownedGroups, unownedGroups } = splitWarmupGroups(allGroups);

    void (async () => {
      await warmupRelicCardPrices(ownedGroups, onCardBatchDone);
      await warmupRelicCardPrices(unownedGroups, onCardBatchDone, "low");
    })();

    if (evWarmupStartTimer) return;

    evWarmupStartTimer = setTimeout(() => {
      evWarmupStartTimer = null;
      void (async () => {
        await warmupRelicEvs(ownedGroups, onEvBatchDone);
        await warmupRelicEvs(unownedGroups, onEvBatchDone, "low");
      })();
    }, EV_WARMUP_START_DELAY_MS);
  }

  $: groups = (() => {
    void $relicEvRevision;
    void $priceCacheRevision;
    if (!$relicDb) return [];

    let relicGroups = Object.values($relicDb.groups);

    if ($inventoryData) {
      const hasOwnedRelics = Object.values($relicOwnedCounts).some((counts) =>
        Object.values(counts || {}).some((count) => count > 0),
      );

      if (hasOwnedRelics) {
        relicGroups = relicGroups.filter((group) => {
          const owned = $relicOwnedCounts[group.key];
          return owned && Object.values(owned).some((count) => count > 0);
        });
      }
    }

    if ($relicTierFilter !== "all") {
      relicGroups = relicGroups.filter((group) => group.tier === $relicTierFilter);
    }

    if ($relicSearch) {
      const query = $relicSearch.toLowerCase();
      relicGroups = relicGroups.filter((group) =>
        group.name.toLowerCase().includes(query),
      );
    }

    if ($relicSortMode === "ev_desc" || $relicSortMode === "ev_asc") {
      const direction = $relicSortMode === "ev_desc" ? -1 : 1;
      relicGroups = [...relicGroups].sort((a, b) => {
        const aEv = getCachedEv(a.key, $relicSquadSize, $relicQualityMode);
        const bEv = getCachedEv(b.key, $relicSquadSize, $relicQualityMode);

        if ((aEv == null) !== (bEv == null)) return aEv == null ? 1 : -1;
        if (aEv != null && bEv != null && aEv !== bEv) {
          return direction * (aEv - bEv);
        }

        const tierA = RELIC_TIER_ORDER[a.tier] ?? 99;
        const tierB = RELIC_TIER_ORDER[b.tier] ?? 99;
        return tierA !== tierB ? tierA - tierB : a.name.localeCompare(b.name);
      });
    } else {
      relicGroups = [...relicGroups].sort((a, b) => {
        const tierA = RELIC_TIER_ORDER[a.tier] ?? 99;
        const tierB = RELIC_TIER_ORDER[b.tier] ?? 99;
        return tierA !== tierB ? tierA - tierB : a.name.localeCompare(b.name);
      });
    }

    return relicGroups;
  })();

  function evLabel(groupKey: string): { text: string; cls: string } {
    const ev = getCachedEv(groupKey, $relicSquadSize, $relicQualityMode);
    const noData = evHasFreshNoData(groupKey, $relicSquadSize, $relicQualityMode);
    const relicPrice = getCachedRelicCardPrice(groupKey);
    const qualityLabel =
      $relicQualityMode === "best"
        ? "Best"
        : $relicQualityMode === "exceptional"
          ? "Ex"
          : $relicQualityMode.charAt(0).toUpperCase() + $relicQualityMode.slice(1, 3);

    if (ev != null) {
      return { text: `${qualityLabel} ~${ev.toFixed(1)}p`, cls: "has-value" };
    }

    if (relicPrice != null) {
      return { text: `Relic ${relicPrice}p`, cls: "has-value" };
    }

    return {
      text: `${qualityLabel} ${noData ? "N/A" : "..."}`,
      cls: noData ? "no-data" : "loading",
    };
  }

  function fallbackIconForTier(tierClass: string): string {
    return RELIC_ICON_PATHS[tierClass] || RELIC_ICON_PATHS.default;
  }

  function onRelicIconError(event: Event, tierClass: string): void {
    const img = event.currentTarget as HTMLImageElement | null;
    if (!img) return;
    const fallback = fallbackIconForTier(tierClass);
    if (!img.src.endsWith(fallback)) {
      img.src = fallback;
    }
  }
</script>

<section class="view active">
  <div class="view-header">
    <h2>Relic Planner ({groups.length})</h2>
    <div class="view-controls">
      <div class="search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input type="text" bind:value={$relicSearch} placeholder="Search relics..." />
      </div>

      <div class="filter-tabs">
        {#each TIER_OPTIONS as [key, label]}
          <button
            class="filter-tab"
            class:active={$relicTierFilter === key}
            on:click={() => relicTierFilter.set(key)}
          >
            {label}
          </button>
        {/each}
      </div>

      <div class="filter-tabs" title="Sort relics">
        {#each SORT_OPTIONS as [key, label]}
          <button
            class="filter-tab"
            class:active={$relicSortMode === key}
            on:click={() => relicSortMode.set(key)}
          >
            {label}
          </button>
        {/each}
      </div>

      <div class="filter-tabs" title="Relic quality for EV">
        {#each QUALITY_OPTIONS as [key, label]}
          <button
            class="filter-tab"
            class:active={$relicQualityMode === key}
            on:click={() => relicQualityMode.set(key)}
          >
            {label}
          </button>
        {/each}
      </div>

      <div class="filter-tabs" title="Squad size for EV">
        {#each SQUAD_OPTIONS as [size, label]}
          <button
            class="filter-tab"
            class:active={$relicSquadSize === size}
            on:click={() => relicSquadSize.set(size)}
          >
            {label}
          </button>
        {/each}
      </div>
    </div>
  </div>

  {#if loading}
    <div class="empty-state"><p>Loading relic database...</p></div>
  {:else if error}
    <div class="empty-state"><p>{error}</p></div>
  {:else if groups.length === 0}
    <div class="empty-state"><p>No relics found</p></div>
  {:else}
    <div id="relic-grid">
      {#each groups as group (group.key)}
        {@const tierClass = fissureTierClass(group.tier)}
        {@const iconSrc =
          group.imageUrl || RELIC_ICON_PATHS[tierClass] || RELIC_ICON_PATHS.default}
        {@const owned = $relicOwnedCounts[group.key]}
        {@const totalOwned = owned ? Object.values(owned).reduce((sum, count) => sum + count, 0) : 0}
        {@const ev = evLabel(group.key)}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="relic-card" on:click={() => activeRelic.set(group)}>
          <div class="relic-card-icon">
            <span class="relic-icon {tierClass}">
              <img
                class="relic-icon-img"
                src={iconSrc}
                alt={group.name}
                loading="lazy"
                on:error={(event) => onRelicIconError(event, tierClass)}
              />
            </span>
          </div>

          <div class="relic-card-body">
            <span class="relic-card-name">{group.name}</span>
            <span class="relic-card-tier tier-{tierClass}">{group.tier}</span>
          </div>

          <span class="relic-ev-badge {ev.cls}">{ev.text}</span>

          {#if totalOwned > 0}
            <span class="relic-owned-badge">x{totalOwned}</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>
