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
  import { invoke, send } from "../lib/ipc.js";
  import {
    markRelicWarmupComplete,
    markRelicWarmupFirstUseful,
    perfSnapshot,
  } from "../lib/perf.js";
  import { debugMode } from "../stores/app.js";
  import ItemImage from "../components/ItemImage.svelte";
  import SearchBox from "../components/SearchBox.svelte";
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
    send("overlay:push-relic-filters", {
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
  const WARMUP_COALESCE_MS = 150;
  const RELIC_CARD_VISIBLE_WARMUP_LIMIT = 120;

  let loading = false;
  let error = "";
  let groups: RelicGroup[] = [];
  let warmupCoalesceTimer: ReturnType<typeof setTimeout> | null = null;
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
        const db = await invoke("getRelicDatabase");
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
      scheduleWarmup();
    }
  });

  // Stop this view's background warmups after navigation.
  onDestroy(() => {
    relicViewMounted = false;
    cancelWarmup();
    if (warmupCoalesceTimer) clearTimeout(warmupCoalesceTimer);
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

  // Re-run warmup for the currently selected squad/quality. Debounced so that
  // simultaneous squad+quality store updates collapse into one startWarmup call.
  $: if ($relicSquadSize || $relicQualityMode) {
    if ($relicDb) scheduleWarmup();
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

  /**
   * Debounced entry point for startWarmup(). Multiple reactive triggers
   * (onMount, squad-size change, quality-mode change) can fire in the same
   * tick; this coalesces them into a single warmup run so card/ducat warmups
   * don't double-enqueue.
   */
  function scheduleWarmup(): void {
    if (warmupCoalesceTimer) clearTimeout(warmupCoalesceTimer);
    warmupCoalesceTimer = setTimeout(() => {
      warmupCoalesceTimer = null;
      if (!relicViewMounted) return;
      startWarmup();
    }, WARMUP_COALESCE_MS);
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
  <div class="mb-4">
    <h2 class="m-0 mb-2 font-display text-[1.875rem] font-semibold tracking-[0.03em] text-text-primary">Relic Planner ({groups.length} groups / {visibleRelicEntryCount} entries)</h2>
    <div class="flex items-end border-b border-white/[0.09]">
      <div class="flex">
        {#each TIER_OPTIONS as [key, label]}
          <button
            class="flex items-center py-[0.45rem] px-[0.95rem] border-none border-b-[3px] border-b-transparent bg-none font-display text-base text-[#8a8c95] cursor-pointer transition-[color,border-color] duration-150 whitespace-nowrap -mb-px hover:text-[#b0b2ba] data-[active]:text-white data-[active]:border-b-white"
            data-active={$relicTierFilter === key || undefined}
            on:click={() => relicTierFilter.set(key)}
          >{label}</button>
        {/each}
      </div>
      <div class="ml-auto flex items-center gap-2 pb-[0.45rem] shrink-0 flex-nowrap">
        <SearchBox bind:value={$relicSearch} placeholder="Search relics..." class="min-w-[11rem]" />

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
          <select class="shared-filter-select min-w-[4rem]" bind:value={$relicSquadSize}>
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
    <div class="grid gap-[var(--relic-grid-gap)] grid-cols-[repeat(var(--relic-grid-columns),minmax(0,1fr))]">
      {#each groups as group (group.key)}
        {@const tierClass = fissureTierClass(group.tier)}
        {@const iconSrc =
          group.imageUrl || RELIC_ICON_PATHS[tierClass] || RELIC_ICON_PATHS.default}
        {@const selectedOwned = selectedOwnedQuality(group, ownedModeSelectedQualityByGroup[group.key])}
        {@const selected = selectedEvDataForMode(group, $relicQualityMode, selectedOwned)}
        {@const rewardIcons = previewRewards(group)}

        <div class="relic-compact-card">
          <button type="button" class="relic-compact-head grid grid-cols-[auto_minmax(0,1fr)_auto] min-w-0 items-center gap-[0.36rem] w-full border-0 p-0 m-0 bg-transparent text-inherit text-left cursor-pointer" on:click={() => openRelic(group)}>
            <span class="inline-flex items-center justify-center w-[2.4rem] shrink-0">
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

            <span class="flex min-w-0 flex-col gap-[0.24rem]">
              <span class="relic-row-name overflow-hidden text-ellipsis whitespace-nowrap font-display text-[1.24rem] font-semibold tracking-[0.01em]">{group.name}</span>
            </span>

            <span class="min-w-0 flex flex-col items-end gap-[0.16rem]">
              <span class="relic-compact-block-label text-right font-display text-[0.72rem] tracking-[0.06em] uppercase text-text-secondary"
                >{selectedQualityHeader($relicQualityMode, group, selectedOwned)}</span
              >
              <span class="flex flex-nowrap items-center justify-end gap-[0.24rem] min-w-0">
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

          <span class="relic-reward-preview-row grid grid-cols-6 gap-[0.3rem]">
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

          <span class="relic-quality-inline-counts ml-0 inline-grid grid-cols-4 w-full min-w-0 justify-stretch gap-[0.14rem]">
            {#each RELIC_QUALITY_COLUMNS as quality}
              {@const count = ownedCount(group, quality)}
              <button
                type="button"
                class="relic-quality-inline-pill {count === 0 ? 'text-text-muted opacity-90' : ''} {$relicQualityMode !== 'owned' || count === 0 ? 'cursor-default opacity-[0.86]' : ''}"
                class:active={$relicQualityMode === "owned" && selectedOwned === quality}
                on:click|stopPropagation={() => {
                  if ($relicQualityMode === "owned" && count > 0) {
                    setOwnedQuality(group, quality);
                  }
                }}
              >
                <span class="leading-none normal-case opacity-[0.96]">{RELIC_QUALITY_SHORT[quality]}:</span>
                <span class="relic-quality-inline-value {count === 0 ? '!text-text-muted' : ''}">{count}</span>
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
  .relic-compact-card {
    width: 100%; display: flex; min-width: 0; flex-direction: column; gap: 0.5rem;
    border: 1px solid var(--border); border-radius: 0.74rem;
    background:
      radial-gradient(circle at 14% 30%, color-mix(in oklab, var(--accent) 20%, transparent) 0%, transparent 52%),
      linear-gradient(180deg, color-mix(in oklab, var(--bg-surface) 88%, black) 0%, color-mix(in oklab, var(--bg-base) 94%, black) 100%);
    padding: 0.6rem; cursor: default; text-align: left; color: var(--text-primary); font: inherit;
    transition: border-color 0.14s ease, background 0.14s ease, transform 0.14s ease;
  }
  .relic-compact-card:hover {
    border-color: var(--border-strong);
    background:
      radial-gradient(circle at 14% 30%, color-mix(in oklab, var(--accent) 30%, transparent) 0%, transparent 56%),
      linear-gradient(180deg, color-mix(in oklab, var(--bg-raised) 86%, black) 0%, color-mix(in oklab, var(--bg-base) 92%, black) 100%);
    transform: translateY(-1px);
  }
  .relic-compact-card :global(.relic-icon) { width: 1.85rem; height: 1.85rem; }
  .relic-compact-card :global(.relic-icon-img) { transform: scale(1.06); }

  .relic-row-pill {
    display: inline-flex; align-items: center; border-radius: 999px;
    border: 1px solid var(--border);
    background: color-mix(in oklab, var(--bg-raised) 88%, var(--bg-base));
    padding: 0.2rem 0.6rem; font-family: var(--font-display); font-size: 0.85rem;
    font-weight: 700; letter-spacing: 0.03em; color: var(--text-secondary); white-space: nowrap;
  }
  :global(.has-value).relic-row-pill {
    border-color: color-mix(in oklab, var(--accent) 52%, transparent);
    background: color-mix(in oklab, var(--accent) 20%, var(--bg-raised));
    color: var(--accent-bright);
  }
  :global(.no-data).relic-row-pill {
    border-color: color-mix(in oklab, var(--text-muted) 35%, transparent);
    background: color-mix(in oklab, var(--bg-raised) 84%, var(--bg-base));
    color: var(--text-muted);
  }
  :global(.relic-row-pill-ratio).relic-row-pill {
    border-color: color-mix(in oklab, var(--success) 48%, transparent);
    background: color-mix(in oklab, var(--success) 16%, var(--bg-raised));
    color: color-mix(in oklab, var(--success) 82%, white);
  }

  .relic-reward-preview-icon {
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 0.5rem; border: 1px solid var(--border);
    background: color-mix(in oklab, var(--bg-raised) 86%, var(--bg-base));
    padding: 0.2rem; min-height: 2.05rem;
  }
  .relic-reward-preview-icon.owned {
    border-color: color-mix(in oklab, var(--success) 56%, transparent);
    background: color-mix(in oklab, var(--success) 18%, var(--bg-raised));
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--success) 24%, transparent);
  }

  .relic-quality-inline-pill {
    appearance: none; min-width: 0; width: 100%; display: inline-flex;
    flex-direction: row; align-items: center; justify-content: center;
    border-radius: 0.34rem;
    border: 1px solid color-mix(in oklab, var(--info) 36%, transparent);
    background: color-mix(in oklab, var(--info) 14%, var(--bg-base));
    gap: 0.2rem; padding: 0.18rem 0.3rem; font-family: var(--font-display);
    font-size: 0.78rem; font-weight: 700; letter-spacing: 0.02em;
    color: color-mix(in oklab, var(--text-secondary) 88%, white);
    white-space: nowrap; cursor: pointer;
  }
  .relic-quality-inline-pill.active {
    border-color: color-mix(in oklab, var(--accent) 62%, transparent);
    background: color-mix(in oklab, var(--accent) 22%, var(--bg-base));
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 28%, transparent);
  }
  .relic-quality-inline-value {
    line-height: 1; font-size: 0.78rem; letter-spacing: 0.02em;
    color: color-mix(in oklab, var(--info) 76%, white);
  }

  @media (max-width: 800px) {
    .relic-row-name { font-size: 0.94rem; }
    .relic-reward-preview-row { gap: 0.22rem; }
    .relic-quality-inline-counts {
      margin-left: 0; grid-template-columns: repeat(4, minmax(0, 1fr));
      justify-content: stretch;
    }
  }
</style>
