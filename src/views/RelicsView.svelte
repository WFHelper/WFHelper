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
  import { inventoryData, parsedItems, wfmItems } from "../stores/data.js";
  import { activeRelic } from "../stores/modals.js";
  import { priceCacheRevision } from "../stores/pricing.js";
  import {
    computeGroupDucatonator,
    computeGroupDucatEv,
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
    warmupRewardDucats,
    warmupRelicEvs,
    relicGroupMatchesSearch,
  } from "../lib/relic.js";
  import { ipc } from "../lib/ipc.js";
  import {
    markRelicWarmupComplete,
    markRelicWarmupFirstUseful,
    perfSnapshot,
  } from "../lib/perf.js";
  import { debugMode } from "../stores/app.js";
  import ItemImage from "../components/ItemImage.svelte";
  import type { ParsedItem } from "../types/inventory.js";
  import type { RelicGroup, RelicQuality, RelicReward } from "../types/relics.js";

  const TIER_OPTIONS: Array<[string, string]> = [
    ["all", "All"],
    ["Lith", "Lith"],
    ["Meso", "Meso"],
    ["Neo", "Neo"],
    ["Axi", "Axi"],
    ["Requiem", "Requiem"],
  ];

  const SORT_OPTIONS: Array<[
    "tier" | "ev_desc" | "ev_asc" | "ducat_desc" | "ducat_asc" | "ducatonator_desc" | "ducatonator_asc",
    string,
  ]> = [
    ["tier", "Default"],
    ["ev_desc", "Plat desc"],
    ["ev_asc", "Plat asc"],
    ["ducat_desc", "Ducat desc"],
    ["ducat_asc", "Ducat asc"],
    ["ducatonator_desc", "d/p desc"],
    ["ducatonator_asc", "d/p asc"],
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

  const RELIC_QUALITY_COLUMNS: RelicQuality[] = ["intact", "exceptional", "flawless", "radiant"];
  const RELIC_QUALITY_SHORT: Record<RelicQuality, string> = {
    intact: "Int",
    exceptional: "Ex",
    flawless: "Fl",
    radiant: "Rad",
  };
  const RELIC_PREVIEW_REWARD_LIMIT = 6;

  function normalizeOwnedRewardName(value: string): string {
    return value
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/ blueprint$/i, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  const EV_WARMUP_UI_DEBOUNCE_MS = 800;
  const CARD_WARMUP_UI_DEBOUNCE_MS = 450;
  const EV_WARMUP_START_DELAY_MS = 2000;
  const PRICE_UPDATE_EV_REFRESH_DEBOUNCE_MS = 400;
  const RELIC_CARD_VISIBLE_WARMUP_LIMIT = 120;

  let loading = false;
  let error = "";
  let groups: RelicGroup[] = [];
  let evWarmupStartTimer: ReturnType<typeof setTimeout> | null = null;
  let evUiDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let cardUiDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let ducatUiDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let priceUpdateEvRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let relicViewMounted = true;
  let ownedRewardInternalNames: Record<string, true> = {};
  let ownedRewardNames: Record<string, true> = {};
  let rewardIconBySlug: Record<string, string> = {};
  let rewardIconByName: Record<string, string> = {};

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

  const onDucatBatchDone = () => {
    if (ducatUiDebounceTimer) clearTimeout(ducatUiDebounceTimer);
    ducatUiDebounceTimer = setTimeout(
      () => relicEvRevision.update((value) => value + 1),
      CARD_WARMUP_UI_DEBOUNCE_MS,
    );
  };

  onMount(async () => {
    relicViewMounted = true;
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
    relicViewMounted = false;
    cancelWarmup();
    if (evWarmupStartTimer) clearTimeout(evWarmupStartTimer);
    if (evUiDebounceTimer) clearTimeout(evUiDebounceTimer);
    if (cardUiDebounceTimer) clearTimeout(cardUiDebounceTimer);
    if (ducatUiDebounceTimer) clearTimeout(ducatUiDebounceTimer);
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

  function buildCardWarmupPriority(
    allGroups: RelicGroup[],
    ownedGroups: RelicGroup[],
  ): RelicGroup[] {
    if (ownedGroups.length > 0) {
      return ownedGroups;
    }

    const visible = groups.slice(0, RELIC_CARD_VISIBLE_WARMUP_LIMIT);
    if (visible.length > 0) {
      return visible;
    }

    return allGroups.slice(0, RELIC_CARD_VISIBLE_WARMUP_LIMIT);
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
    const cardPriorityGroups = buildCardWarmupPriority(allGroups, ownedGroups);

    // Card-price warmup is intentionally constrained to owned/visible relics.
    // The relic endpoint returns many 404s for untradable relics; EV warmup still
    // covers full value computation via reward prices in the background.
      void warmupRelicCardPrices(cardPriorityGroups, onCardBatchDone);

      const ducatPriorityGroups = [...ownedGroups, ...unownedGroups];
      void warmupRewardDucats(
        ducatPriorityGroups,
        onDucatBatchDone,
        ownedGroups.length > 0 ? "high" : "low",
      );

    if (evWarmupStartTimer) return;

    evWarmupStartTimer = setTimeout(() => {
      evWarmupStartTimer = null;
      void (async () => {
        await warmupRelicEvs(ownedGroups, onEvBatchDone, "high");
        await warmupRelicEvs(unownedGroups, onEvBatchDone, "low");

        if (
          relicViewMounted &&
          $perfSnapshot.relicWarmupCompleteMs == null
        ) {
          markRelicWarmupComplete();
        }
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
      relicGroups = relicGroups.filter((group) => relicGroupMatchesSearch(group, $relicSearch));
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
    } else if ($relicSortMode === "ducat_desc" || $relicSortMode === "ducat_asc") {
      const direction = $relicSortMode === "ducat_desc" ? -1 : 1;
      relicGroups = [...relicGroups].sort((a, b) => {
        const aEv = computeGroupDucatEv(a, $relicSquadSize, $relicQualityMode);
        const bEv = computeGroupDucatEv(b, $relicSquadSize, $relicQualityMode);

        if ((aEv == null) !== (bEv == null)) return aEv == null ? 1 : -1;
        if (aEv != null && bEv != null && aEv !== bEv) {
          return direction * (aEv - bEv);
        }

        const tierA = RELIC_TIER_ORDER[a.tier] ?? 99;
        const tierB = RELIC_TIER_ORDER[b.tier] ?? 99;
        return tierA !== tierB ? tierA - tierB : a.name.localeCompare(b.name);
      });
    } else if (
      $relicSortMode === "ducatonator_desc" ||
      $relicSortMode === "ducatonator_asc"
    ) {
      const direction = $relicSortMode === "ducatonator_desc" ? -1 : 1;
      relicGroups = [...relicGroups].sort((a, b) => {
        const aRatio = computeGroupDucatonator(a, $relicSquadSize, $relicQualityMode);
        const bRatio = computeGroupDucatonator(b, $relicSquadSize, $relicQualityMode);

        if ((aRatio == null) !== (bRatio == null)) return aRatio == null ? 1 : -1;
        if (aRatio != null && bRatio != null && aRatio !== bRatio) {
          return direction * (aRatio - bRatio);
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

  $: if ($perfSnapshot.relicWarmupFirstUsefulMs == null && groups.length > 0) {
    const hasUsefulPrice = groups.some((group) => {
      const ev = getCachedEv(group.key, $relicSquadSize, $relicQualityMode);
      const relicPrice = getCachedRelicCardPrice(group.key);
      return ev != null || relicPrice != null;
    });

    if (hasUsefulPrice) {
      markRelicWarmupFirstUseful();
    }
  }

  $: visibleRelicEntryCount = groups.reduce(
    (sum, group) =>
      sum + RELIC_QUALITY_COLUMNS.reduce((inner, quality) => inner + (ownedCount(group, quality) > 0 ? 1 : 0), 0),
    0,
  );

  interface RowEvData {
    plat: number | null;
    ducat: number | null;
    ratio: number | null;
    cls: "has-value" | "loading" | "no-data";
  }

  function selectedEvData(group: RelicGroup): RowEvData {
    const platEv = getCachedEv(group.key, $relicSquadSize, $relicQualityMode);
    const ducatEv = computeGroupDucatEv(group, $relicSquadSize, $relicQualityMode);
    const ratio = computeGroupDucatonator(group, $relicSquadSize, $relicQualityMode);
    const noData = evHasFreshNoData(group.key, $relicSquadSize, $relicQualityMode);

    return {
      plat: platEv,
      ducat: ducatEv,
      ratio,
      cls: platEv != null || ducatEv != null ? "has-value" : noData ? "no-data" : "loading",
    };
  }

  function bestQualityBadge(group: RelicGroup): { text: string; cls: "has-value" | "loading" | "no-data" } {
    let bestPlat: { quality: RelicQuality; value: number } | null = null;
    let bestDucat: { quality: RelicQuality; value: number } | null = null;

    for (const quality of RELIC_QUALITY_COLUMNS) {
      const plat = getCachedEv(group.key, $relicSquadSize, quality);
      if (plat != null && (!bestPlat || plat > bestPlat.value)) {
        bestPlat = { quality, value: plat };
      }

      const ducat = computeGroupDucatEv(group, $relicSquadSize, quality);
      if (ducat != null && (!bestDucat || ducat > bestDucat.value)) {
        bestDucat = { quality, value: ducat };
      }
    }

    if (bestPlat) {
      return {
        text: `${RELIC_QUALITY_SHORT[bestPlat.quality]} ${bestPlat.value.toFixed(1)}p`,
        cls: "has-value",
      };
    }

    if (bestDucat) {
      return {
        text: `${RELIC_QUALITY_SHORT[bestDucat.quality]} ${bestDucat.value.toFixed(1)}d`,
        cls: "has-value",
      };
    }

    const anyNoData = RELIC_QUALITY_COLUMNS.some((quality) =>
      evHasFreshNoData(group.key, $relicSquadSize, quality),
    );

    return {
      text: anyNoData ? "N/A" : "...",
      cls: anyNoData ? "no-data" : "loading",
    };
  }

  function ownedCount(group: RelicGroup, quality: RelicQuality): number {
    const owned = $relicOwnedCounts[group.key];
    return owned?.[quality] ?? 0;
  }

  function previewRewards(group: RelicGroup): RelicReward[] {
    const intactRewards = group.qualities.intact?.rewards || [];
    if (intactRewards.length > 0) {
      return intactRewards.slice(0, RELIC_PREVIEW_REWARD_LIMIT);
    }

    for (const quality of RELIC_QUALITY_COLUMNS) {
      const rewards = group.qualities[quality]?.rewards || [];
      if (rewards.length > 0) {
        return rewards.slice(0, RELIC_PREVIEW_REWARD_LIMIT);
      }
    }

    return [];
  }

  function isOwnedReward(reward: RelicReward): boolean {
    if (reward.uniqueName && ownedRewardInternalNames[reward.uniqueName]) {
      return true;
    }
    return Boolean(ownedRewardNames[normalizeOwnedRewardName(reward.name)]);
  }

  function rewardIconSrc(reward: RelicReward): string | null {
    if (reward.urlName && rewardIconBySlug[reward.urlName]) {
      return rewardIconBySlug[reward.urlName];
    }

    const rewardNameKey = reward.name
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (rewardNameKey && rewardIconByName[rewardNameKey]) {
      return rewardIconByName[rewardNameKey];
    }

    return reward.imageUrl || null;
  }

  function rewardTooltip(reward: RelicReward): string {
    const rarity = reward.rarity || "Unknown";
    return `${reward.name} (${rarity}, ${reward.chance}%)`;
  }

  function selectedQualityHeader(mode: "best" | RelicQuality): string {
    if (mode === "best") return "Selected EV (Best)";
    const label = mode.charAt(0).toUpperCase() + mode.slice(1);
    return `Selected EV (${label})`;
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

  $: {
    const nextInternalNames: Record<string, true> = {};
    const nextNames: Record<string, true> = {};
    for (const item of ($parsedItems || []) as ParsedItem[]) {
      if ((item.amount ?? 1) <= 0) continue;

      if (typeof item.internalName === "string" && item.internalName.trim().length > 0) {
        nextInternalNames[item.internalName] = true;
      }

      if (typeof item.name === "string" && item.name.trim().length > 0) {
        nextNames[normalizeOwnedRewardName(item.name)] = true;
      }
    }
    ownedRewardInternalNames = nextInternalNames;
    ownedRewardNames = nextNames;
  }

  $: {
    const nextBySlug: Record<string, string> = {};
    const nextByName: Record<string, string> = {};
    for (const entry of Object.values($wfmItems || {})) {
      if (!entry || typeof entry !== "object") continue;
      const slug = typeof entry.url_name === "string" ? entry.url_name.trim().toLowerCase() : "";
      const icon = typeof entry.icon === "string" && entry.icon.trim().length > 0 ? entry.icon : null;
      const thumb =
        typeof entry.thumb === "string" && entry.thumb.trim().length > 0 ? entry.thumb : null;
      const src = icon || thumb;

      if (src && slug && !nextBySlug[slug]) {
        nextBySlug[slug] = src;
      }

      const rawName = typeof entry.item_name === "string" ? entry.item_name : "";
      const nameKey = rawName
        .toLowerCase()
        .replace(/[’']/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      if (src && nameKey && !nextByName[nameKey]) {
        nextByName[nameKey] = src;
      }
    }
    rewardIconBySlug = nextBySlug;
    rewardIconByName = nextByName;
  }
</script>

<section class="view active">
  <div class="view-header">
    <h2>Relic Planner ({groups.length} groups / {visibleRelicEntryCount} entries)</h2>
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
    <div class="relic-cards relic-cards-3">
      {#each groups as group (group.key)}
        {@const tierClass = fissureTierClass(group.tier)}
        {@const iconSrc =
          group.imageUrl || RELIC_ICON_PATHS[tierClass] || RELIC_ICON_PATHS.default}
        {@const selected = selectedEvData(group)}
        {@const best = bestQualityBadge(group)}
        {@const rewardIcons = previewRewards(group)}
        {@const totalOwned = RELIC_QUALITY_COLUMNS.reduce(
          (sum, quality) => sum + ownedCount(group, quality),
          0,
        )}

        <button type="button" class="relic-compact-card" on:click={() => activeRelic.set(group)}>
          <span class="relic-compact-head">
            <span class="relic-row-icon-shell">
              <span class="relic-icon {tierClass}">
                <img
                  class="relic-icon-img"
                  src={iconSrc}
                  alt={group.name}
                  loading="lazy"
                  on:error={(event) => onRelicIconError(event, tierClass)}
                />
              </span>
            </span>

            <span class="relic-row-main">
              <span class="relic-row-name">{group.name}</span>
              <span class="relic-row-meta">
                <span class="relic-card-tier tier-{tierClass}">{group.tier}</span>
                {#if totalOwned > 0}
                  <span class="relic-owned-inline">x{totalOwned}</span>
                {/if}
              </span>
            </span>
          </span>

          <span class="relic-reward-preview-row">
            {#each rewardIcons as reward}
              <span
                class="relic-reward-preview-icon"
                class:owned={isOwnedReward(reward)}
                title={rewardTooltip(reward)}
              >
                <ItemImage src={rewardIconSrc(reward)} alt={reward.name} cls="relic-reward-preview-img" />
              </span>
            {/each}
          </span>

          <span class="relic-compact-ev-block">
            <span class="relic-compact-block-label">{selectedQualityHeader($relicQualityMode)}</span>
            <span class="relic-compact-ev-row">
              <span class={`relic-row-pill relic-row-pill-plat ${selected.cls}`}>
                {selected.plat != null ? `${selected.plat.toFixed(1)}p` : "p -"}
              </span>
              <span class={`relic-row-pill relic-row-pill-ducat ${selected.cls}`}>
                {selected.ducat != null ? `${selected.ducat.toFixed(1)}d` : "d -"}
              </span>
              <span class={`relic-row-pill relic-row-pill-ratio ${selected.cls}`}>
                {selected.ratio != null ? `${selected.ratio.toFixed(1)} d/p` : "d/p -"}
              </span>

              <span class="relic-quality-inline-counts">
                {#each RELIC_QUALITY_COLUMNS as quality}
                  {@const count = ownedCount(group, quality)}
                  <span class="relic-quality-inline-pill" class:zero={count === 0}>
                    <span class="relic-quality-inline-label">{RELIC_QUALITY_SHORT[quality]}</span>
                    <span class="relic-quality-inline-value">{count}</span>
                  </span>
                {/each}
              </span>
            </span>
          </span>

          <span class="relic-compact-best-block">
            <span class="relic-compact-block-label">Best EV</span>
            <span class={`relic-best-chip ${best.cls}`}>{best.text}</span>
          </span>

          {#if $debugMode}
            <span class="debug-reason">show:relic-planner:{group.key}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</section>








