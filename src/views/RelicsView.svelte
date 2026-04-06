<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import {
    relicDb,
    relicEvRevision,
    relicOwnedCounts,
    relicQualityMode,
    relicSortDirection,
    relicSearch,
    relicSortMode,
    relicSquadSize,
    relicTierFilter,
  } from "../stores/relics.js";
  import { inventoryData, itemDb, parsedItems, wfmItems } from "../stores/data.js";
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

  type RelicQualityModeView = "owned" | RelicQuality;

  const TIER_OPTIONS: Array<[string, string]> = [
    ["all", "All"],
    ["Lith", "Lith"],
    ["Meso", "Meso"],
    ["Neo", "Neo"],
    ["Axi", "Axi"],
    ["Requiem", "Requiem"],
  ];

  const SORT_OPTIONS: Array<["tier" | "name" | "ev" | "ducat" | "ducatonator", string]> = [
    ["tier", "Default"],
    ["name", "Name"],
    ["ev", "Platinum"],
    ["ducat", "Ducats"],
    ["ducatonator", "Ducats/Plat"],
  ];

  const QUALITY_OPTIONS: Array<[RelicQualityModeView, string]> = [
    ["owned", "Owned"],
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
  const RELIC_QUALITY_LABEL: Record<RelicQuality, string> = {
    intact: "Intact",
    exceptional: "Exceptional",
    flawless: "Flawless",
    radiant: "Radiant",
  };
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

  function pushFiltersToOverlay(): void {
    ipc.pushRelicFilters({
      squadSize: $relicSquadSize,
      tierFilter: $relicTierFilter === "all" ? null : $relicTierFilter,
    });
  }

  function toggleRelicSortDirection(): void {
    relicSortDirection.update((value) => (value === "asc" ? "desc" : "asc"));
  }

  function openRelic(group: RelicGroup): void {
    activeRelic.set(group);
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
  let ownedModeSelectedQualityByGroup: Record<string, RelicQuality> = {};
  let ownedRewardInternalNames: Record<string, true> = {};
  let ownedRewardNames: Record<string, true> = {};
  let rewardGameRefBySlug: Record<string, string> = {};
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

    if ($relicSortMode === "ev") {
      const direction = $relicSortDirection === "desc" ? -1 : 1;
      relicGroups = [...relicGroups].sort((a, b) => {
        const aEv = selectedEvDataForMode(a, $relicQualityMode).plat;
        const bEv = selectedEvDataForMode(b, $relicQualityMode).plat;

        if ((aEv == null) !== (bEv == null)) return aEv == null ? 1 : -1;
        if (aEv != null && bEv != null && aEv !== bEv) {
          return direction * (aEv - bEv);
        }

        const tierA = RELIC_TIER_ORDER[a.tier] ?? 99;
        const tierB = RELIC_TIER_ORDER[b.tier] ?? 99;
        return tierA !== tierB ? tierA - tierB : a.name.localeCompare(b.name);
      });
    } else if ($relicSortMode === "ducat") {
      const direction = $relicSortDirection === "desc" ? -1 : 1;
      relicGroups = [...relicGroups].sort((a, b) => {
        const aEv = selectedEvDataForMode(a, $relicQualityMode).ducat;
        const bEv = selectedEvDataForMode(b, $relicQualityMode).ducat;

        if ((aEv == null) !== (bEv == null)) return aEv == null ? 1 : -1;
        if (aEv != null && bEv != null && aEv !== bEv) {
          return direction * (aEv - bEv);
        }

        const tierA = RELIC_TIER_ORDER[a.tier] ?? 99;
        const tierB = RELIC_TIER_ORDER[b.tier] ?? 99;
        return tierA !== tierB ? tierA - tierB : a.name.localeCompare(b.name);
      });
    } else if ($relicSortMode === "ducatonator") {
      const direction = $relicSortDirection === "desc" ? -1 : 1;
      relicGroups = [...relicGroups].sort((a, b) => {
        const aRatio = selectedEvDataForMode(a, $relicQualityMode).ratio;
        const bRatio = selectedEvDataForMode(b, $relicQualityMode).ratio;

        if ((aRatio == null) !== (bRatio == null)) return aRatio == null ? 1 : -1;
        if (aRatio != null && bRatio != null && aRatio !== bRatio) {
          return direction * (aRatio - bRatio);
        }

        const tierA = RELIC_TIER_ORDER[a.tier] ?? 99;
        const tierB = RELIC_TIER_ORDER[b.tier] ?? 99;
        return tierA !== tierB ? tierA - tierB : a.name.localeCompare(b.name);
      });
    } else if ($relicSortMode === "name") {
      const direction = $relicSortDirection === "desc" ? -1 : 1;
      relicGroups = [...relicGroups].sort((a, b) => direction * a.name.localeCompare(b.name));
    } else {
      const direction = $relicSortDirection === "desc" ? -1 : 1;
      relicGroups = [...relicGroups].sort((a, b) => {
        const tierA = RELIC_TIER_ORDER[a.tier] ?? 99;
        const tierB = RELIC_TIER_ORDER[b.tier] ?? 99;
        const tierOrder = tierA !== tierB ? tierA - tierB : a.name.localeCompare(b.name);
        return tierOrder * direction;
      });
    }

    return relicGroups;
  })();

  $: if ($perfSnapshot.relicWarmupFirstUsefulMs == null && groups.length > 0) {
    const hasUsefulPrice = groups.some((group) => {
      const ev = selectedEvDataForMode(group, $relicQualityMode).plat;
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

  function qualityEvData(group: RelicGroup, quality: RelicQuality): RowEvData {
    const platEv = getCachedEv(group.key, $relicSquadSize, quality);
    const ducatEv = computeGroupDucatEv(group, $relicSquadSize, quality);
    const ratio = computeGroupDucatonator(group, $relicSquadSize, quality);
    const noData = evHasFreshNoData(group.key, $relicSquadSize, quality);

    return {
      plat: platEv,
      ducat: ducatEv,
      ratio,
      cls: platEv != null || ducatEv != null ? "has-value" : noData ? "no-data" : "loading",
    };
  }

  function selectedOwnedQuality(
    group: RelicGroup,
    selectedFromState: RelicQuality | undefined,
  ): RelicQuality | null {
    const selected = selectedFromState;
    if (selected && ownedCount(group, selected) > 0) {
      return selected;
    }

    for (const quality of RELIC_QUALITY_COLUMNS) {
      if (ownedCount(group, quality) > 0) {
        return quality;
      }
    }

    return null;
  }

  function setOwnedQuality(group: RelicGroup, quality: RelicQuality): void {
    if (ownedCount(group, quality) <= 0) return;
    ownedModeSelectedQualityByGroup = {
      ...ownedModeSelectedQualityByGroup,
      [group.key]: quality,
    };
  }

  function selectedEvDataForMode(
    group: RelicGroup,
    mode: RelicQualityModeView,
    selectedOwned: RelicQuality | null = selectedOwnedQuality(
      group,
      ownedModeSelectedQualityByGroup[group.key],
    ),
  ): RowEvData {
    if (mode === "owned") {
      if (selectedOwned) {
        return qualityEvData(group, selectedOwned);
      }
      return {
        plat: null,
        ducat: null,
        ratio: null,
        cls: "no-data",
      };
    }

    return qualityEvData(group, mode);
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
    const slug =
      typeof reward.urlName === "string" && reward.urlName.trim().length > 0
        ? reward.urlName.trim().toLowerCase()
        : "";
    const gameRef = slug ? rewardGameRefBySlug[slug] : "";
    if (gameRef && ownedRewardInternalNames[gameRef]) {
      return true;
    }
    return Boolean(ownedRewardNames[normalizeOwnedRewardName(reward.name)]);
  }

  function rewardIconSrc(reward: RelicReward): string | null {
    const slug =
      typeof reward.urlName === "string" && reward.urlName.trim().length > 0
        ? reward.urlName.trim().toLowerCase()
        : "";

    if (slug) {
      const gameRef = rewardGameRefBySlug[slug];
      const dbImage = gameRef
        ? (($itemDb?.[gameRef] as { imageUrl?: unknown } | undefined)?.imageUrl ?? null)
        : null;
      if (typeof dbImage === "string" && dbImage.trim().length > 0) {
        return dbImage;
      }

      if (rewardIconBySlug[slug]) {
        return rewardIconBySlug[slug];
      }
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

  function selectedQualityHeader(
    mode: RelicQualityModeView,
    group: RelicGroup,
    selectedOwned: RelicQuality | null,
  ): string {
    if (mode === "owned") {
      if (selectedOwned) {
        return `Selected EV: ${RELIC_QUALITY_LABEL[selectedOwned]}`;
      }
      return "Selected EV: Owned";
    }

    return `Selected EV: ${RELIC_QUALITY_LABEL[mode]}`;
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
    const nextGameRefBySlug: Record<string, string> = {};
    const nextBySlug: Record<string, string> = {};
    const nextByName: Record<string, string> = {};
    for (const entry of Object.values($wfmItems || {})) {
      if (!entry || typeof entry !== "object") continue;
      const slug = typeof entry.url_name === "string" ? entry.url_name.trim().toLowerCase() : "";
      const gameRef =
        typeof entry.gameRef === "string" && entry.gameRef.trim().length > 0
          ? entry.gameRef.trim()
          : "";
      const icon = typeof entry.icon === "string" && entry.icon.trim().length > 0 ? entry.icon : null;
      const thumb =
        typeof entry.thumb === "string" && entry.thumb.trim().length > 0 ? entry.thumb : null;
      const src = icon || thumb;

      if (slug && gameRef && !nextGameRefBySlug[slug]) {
        nextGameRefBySlug[slug] = gameRef;
      }

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
    rewardGameRefBySlug = nextGameRefBySlug;
    rewardIconBySlug = nextBySlug;
    rewardIconByName = nextByName;
  }
</script>

<section class="view active">
  <div class="relics-header-wrap">
    <h2 class="relics-title">Relic Planner ({groups.length} groups / {visibleRelicEntryCount} entries)</h2>
    <div class="relics-tab-row">
      <div class="relics-tier-tab-bar">
        {#each TIER_OPTIONS as [key, label]}
          <button
            class="relics-tier-tab-item"
            class:active={$relicTierFilter === key}
            on:click={() => relicTierFilter.set(key)}
          >{label}</button>
        {/each}
      </div>
      <div class="relics-right-controls">
        <div class="search-box relics-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input type="text" bind:value={$relicSearch} placeholder="Search relics..." />
        </div>

        <div class="shared-sort-controls">
          <button
            class="shared-sort-direction"
            on:click={toggleRelicSortDirection}
            title="Sort direction"
            aria-label={$relicSortDirection === "asc"
              ? "Sort direction ascending"
              : "Sort direction descending"}
          >
            {#if $relicSortDirection === "asc"}
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

          <label class="shared-filter-sort" title="Sort relics">
            <span>Sort</span>
            <select class="shared-filter-select" bind:value={$relicSortMode}>
              {#each SORT_OPTIONS as [key, label]}
                <option value={key}>{label}</option>
              {/each}
            </select>
          </label>
        </div>

        <label class="shared-filter-sort" title="Relic quality for EV">
          <span>Quality</span>
          <select class="shared-filter-select" bind:value={$relicQualityMode}>
            {#each QUALITY_OPTIONS as [key, label]}
              <option value={key}>{label}</option>
            {/each}
          </select>
        </label>

        <label class="shared-filter-sort" title="Squad size for EV">
          <span>Squad</span>
          <select class="shared-filter-select relics-squad-select" bind:value={$relicSquadSize}>
            {#each SQUAD_OPTIONS as [size, label]}
              <option value={size}>{label}</option>
            {/each}
          </select>
        </label>

        <button
          class="push-overlay-btn"
          title="Push current tier & squad filters to the in-game relic overlay"
          on:click={pushFiltersToOverlay}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
            <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
          </svg>
          Push to Overlay
        </button>
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
        {@const selectedOwned = selectedOwnedQuality(group, ownedModeSelectedQualityByGroup[group.key])}
        {@const selected = selectedEvDataForMode(group, $relicQualityMode, selectedOwned)}
        {@const rewardIcons = previewRewards(group)}

        <div class="relic-compact-card">
          <button type="button" class="relic-compact-head relic-compact-head-button" on:click={() => openRelic(group)}>
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
            </span>

            <span class="relic-head-ev">
              <span class="relic-compact-block-label relic-compact-block-label-inline"
                >{selectedQualityHeader($relicQualityMode, group, selectedOwned)}</span
              >
              <span class="relic-compact-ev-row relic-compact-ev-row-inline">
                <span class={`relic-row-pill relic-row-pill-plat ${selected.cls}`}>
                  {selected.plat != null ? `${selected.plat.toFixed(1)}p` : "p -"}
                </span>
                <span class={`relic-row-pill relic-row-pill-ducat ${selected.cls}`}>
                  {selected.ducat != null ? `${selected.ducat.toFixed(1)}d` : "d -"}
                </span>
                <span class={`relic-row-pill relic-row-pill-ratio ${selected.cls}`}>
                  {selected.ratio != null ? `${selected.ratio.toFixed(1)} d/p` : "d/p -"}
                </span>
              </span>
            </span>
          </button>

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

          <span class="relic-quality-inline-counts">
            {#each RELIC_QUALITY_COLUMNS as quality}
              {@const count = ownedCount(group, quality)}
              <button
                type="button"
                class="relic-quality-inline-pill"
                class:zero={count === 0}
                class:active={$relicQualityMode === "owned" && selectedOwned === quality}
                class:disabled={$relicQualityMode !== "owned" || count === 0}
                on:click|stopPropagation={() => {
                  if ($relicQualityMode === "owned" && count > 0) {
                    setOwnedQuality(group, quality);
                  }
                }}
              >
                <span class="relic-quality-inline-label">{RELIC_QUALITY_SHORT[quality]}:</span>
                <span class="relic-quality-inline-value">{count}</span>
              </button>
            {/each}
          </span>

          {#if $debugMode}
            <span class="debug-reason">show:relic-planner:{group.key}</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .relics-header-wrap {
    margin-bottom: 1rem;
  }

  .relics-title {
    margin: 0 0 0.5rem;
    font-family: var(--font-display);
    font-size: var(--font-heading-size, 1.875rem);
    font-weight: 600;
    letter-spacing: 0.03em;
    color: var(--text-primary);
  }

  .relics-tab-row {
    display: flex;
    align-items: flex-end;
    border-bottom: 1px solid rgba(255, 255, 255, 0.09);
  }

  .relics-tier-tab-bar {
    display: flex;
  }

  .relics-tier-tab-item {
    display: flex;
    align-items: center;
    padding: 0.45rem 0.95rem;
    border: none;
    border-bottom: 3px solid transparent;
    background: none;
    font-family: var(--font-display);
    font-size: 1rem;
    color: #8a8c95;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
    white-space: nowrap;
    margin-bottom: -1px;
  }

  .relics-tier-tab-item:hover {
    color: #b0b2ba;
  }

  .relics-tier-tab-item.active {
    color: #ffffff;
    border-bottom-color: #ffffff;
  }

  .relics-right-controls {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-bottom: 0.45rem;
    flex-shrink: 0;
    flex-wrap: nowrap;
  }

  .relics-search {
    min-width: 11rem;
  }

  .relics-squad-select {
    min-width: 4rem;
  }
</style>
