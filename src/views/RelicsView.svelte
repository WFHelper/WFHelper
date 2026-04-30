<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import {
    relicDb,
    relicEvRevision,
    relicOwnedCounts,
    relicViewState,
    setRelicFilter,
  } from "../stores/relics.js";
  import { inventoryData, itemDb, parsedItems, wfmItems } from "../stores/data.js";
  import { activeRelic } from "../stores/modals.js";
  import { priceCacheRevision } from "../stores/pricing.js";
  import { themeSettings } from "../stores/theme.js";
  import {
    computeGroupDucatonator,
    computeGroupDucatEv,
    configureRelicRuntimeCacheFingerprint,
    RELIC_TIER_ORDER,
    cancelWarmup,
    evHasFreshNoData,
    getCachedEv,
    parseOwnedRelics,
    warmupRelicCardPrices,
    warmupRewardDucats,
    warmupRelicEvs,
    relicGroupMatchesSearch,
  } from "../lib/relic.js";
  import { invoke, send } from "../lib/ipc.js";
  import HeaderTabs from "../components/HeaderTabs.svelte";
  import RelicCompactCard from "../components/relics/RelicCompactCard.svelte";
  import SearchBox from "../components/SearchBox.svelte";
  import SortArrow from "../components/SortArrow.svelte";
  import type { ParsedItem } from "../types/inventory.js";
  import type { RelicGroup, RelicQuality, RelicReward } from "../types/relics.js";
  import type { RelicQualityMode, RelicSortMode, RelicVaultedMode } from "../stores/relics.js";

  type RelicQualityModeView = RelicQualityMode;

  const TIER_OPTIONS: Array<[string, string]> = [
    ["all", "All"],
    ["Lith", "Lith"],
    ["Meso", "Meso"],
    ["Neo", "Neo"],
    ["Axi", "Axi"],
    ["Requiem", "Requiem"],
  ];
  const TIER_TABS = TIER_OPTIONS.map(([key, label]) => ({ key, label }));

  const SORT_OPTIONS: Array<[RelicSortMode, string]> = [
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
  const VAULTED_OPTIONS: Array<[RelicVaultedMode, string]> = [
    ["all", "All"],
    ["vaulted", "Vaulted"],
    ["unvaulted", "Unvaulted"],
  ];

  const RELIC_QUALITY_COLUMNS: RelicQuality[] = ["intact", "exceptional", "flawless", "radiant"];
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
      squadSize: $relicViewState.squadSize,
      tierFilter: $relicViewState.tierFilter === "all" ? null : $relicViewState.tierFilter,
    });
  }

  function toggleRelicSortDirection(): void {
    setRelicFilter({
      sortDirection: $relicViewState.sortDirection === "asc" ? "desc" : "asc",
    });
  }

  function setRelicSortMode(event: Event): void {
    setRelicFilter({ sortMode: (event.currentTarget as HTMLSelectElement).value as RelicSortMode });
  }

  function setRelicQualityMode(event: Event): void {
    setRelicFilter({
      qualityMode: (event.currentTarget as HTMLSelectElement).value as RelicQualityMode,
    });
  }

  function setRelicSquadSize(event: Event): void {
    const squadSize = Number((event.currentTarget as HTMLSelectElement).value);
    if (Number.isFinite(squadSize)) {
      setRelicFilter({ squadSize });
    }
  }

  function setRelicVaultedMode(event: Event): void {
    setRelicFilter({ vaultedMode: (event.currentTarget as HTMLSelectElement).value as RelicVaultedMode });
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
  $: if ($relicViewState.squadSize || $relicViewState.qualityMode) {
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

    if ($relicViewState.tierFilter !== "all") {
      relicGroups = relicGroups.filter((group) => group.tier === $relicViewState.tierFilter);
    }

    if ($relicViewState.vaultedMode !== "all") {
      const wantVaulted = $relicViewState.vaultedMode === "vaulted";
      relicGroups = relicGroups.filter((group) => Boolean(group.vaulted) === wantVaulted);
    }

    if ($relicViewState.search) {
      relicGroups = relicGroups.filter((group) =>
        relicGroupMatchesSearch(group, $relicViewState.search),
      );
    }

    if ($relicViewState.sortMode === "ev") {
      const direction = $relicViewState.sortDirection === "desc" ? -1 : 1;
      relicGroups = [...relicGroups].sort((a, b) => {
        const aEv = selectedEvDataForMode(a, $relicViewState.qualityMode).plat;
        const bEv = selectedEvDataForMode(b, $relicViewState.qualityMode).plat;

        if ((aEv == null) !== (bEv == null)) return aEv == null ? 1 : -1;
        if (aEv != null && bEv != null && aEv !== bEv) {
          return direction * (aEv - bEv);
        }

        const tierA = RELIC_TIER_ORDER[a.tier] ?? 99;
        const tierB = RELIC_TIER_ORDER[b.tier] ?? 99;
        return tierA !== tierB ? tierA - tierB : a.name.localeCompare(b.name);
      });
    } else if ($relicViewState.sortMode === "ducat") {
      const direction = $relicViewState.sortDirection === "desc" ? -1 : 1;
      relicGroups = [...relicGroups].sort((a, b) => {
        const aEv = selectedEvDataForMode(a, $relicViewState.qualityMode).ducat;
        const bEv = selectedEvDataForMode(b, $relicViewState.qualityMode).ducat;

        if ((aEv == null) !== (bEv == null)) return aEv == null ? 1 : -1;
        if (aEv != null && bEv != null && aEv !== bEv) {
          return direction * (aEv - bEv);
        }

        const tierA = RELIC_TIER_ORDER[a.tier] ?? 99;
        const tierB = RELIC_TIER_ORDER[b.tier] ?? 99;
        return tierA !== tierB ? tierA - tierB : a.name.localeCompare(b.name);
      });
    } else if ($relicViewState.sortMode === "ducatonator") {
      const direction = $relicViewState.sortDirection === "desc" ? -1 : 1;
      relicGroups = [...relicGroups].sort((a, b) => {
        const aRatio = selectedEvDataForMode(a, $relicViewState.qualityMode).ratio;
        const bRatio = selectedEvDataForMode(b, $relicViewState.qualityMode).ratio;

        if ((aRatio == null) !== (bRatio == null)) return aRatio == null ? 1 : -1;
        if (aRatio != null && bRatio != null && aRatio !== bRatio) {
          return direction * (aRatio - bRatio);
        }

        const tierA = RELIC_TIER_ORDER[a.tier] ?? 99;
        const tierB = RELIC_TIER_ORDER[b.tier] ?? 99;
        return tierA !== tierB ? tierA - tierB : a.name.localeCompare(b.name);
      });
    } else if ($relicViewState.sortMode === "name") {
      const direction = $relicViewState.sortDirection === "desc" ? -1 : 1;
      relicGroups = [...relicGroups].sort((a, b) => direction * a.name.localeCompare(b.name));
    } else {
      const direction = $relicViewState.sortDirection === "desc" ? -1 : 1;
      relicGroups = [...relicGroups].sort((a, b) => {
        const tierA = RELIC_TIER_ORDER[a.tier] ?? 99;
        const tierB = RELIC_TIER_ORDER[b.tier] ?? 99;
        const tierOrder = tierA !== tierB ? tierA - tierB : a.name.localeCompare(b.name);
        return tierOrder * direction;
      });
    }

    return relicGroups;
  })();

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
    const platEv = getCachedEv(group.key, $relicViewState.squadSize, quality);
    const ducatEv = computeGroupDucatEv(group, $relicViewState.squadSize, quality);
    const ratio = computeGroupDucatonator(group, $relicViewState.squadSize, quality);
    const noData = evHasFreshNoData(group.key, $relicViewState.squadSize, quality);

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
      <HeaderTabs
        options={TIER_TABS}
        activeKey={$relicViewState.tierFilter}
        onSelect={(tierFilter) => setRelicFilter({ tierFilter })}
      />
      <div class="ml-auto flex items-center gap-2 pb-[0.45rem] shrink-0 flex-nowrap">
        <SearchBox
          value={$relicViewState.search}
          onValueChange={(search) => setRelicFilter({ search })}
          placeholder="Search relics..."
          class="min-w-[11rem]"
        />

        <div class="shared-sort-controls">
          <button
            class="shared-sort-direction"
            on:click={toggleRelicSortDirection}
            title="Sort direction"
            aria-label={$relicViewState.sortDirection === "asc"
              ? "Sort direction ascending"
              : "Sort direction descending"}
          >
            <SortArrow asc={$relicViewState.sortDirection === "asc"} />
          </button>

          <label class="shared-filter-sort" title="Sort relics">
            <span>Sort</span>
            <select
              class="shared-filter-select"
              value={$relicViewState.sortMode}
              on:change={setRelicSortMode}
            >
              {#each SORT_OPTIONS as [key, label]}
                <option value={key}>{label}</option>
              {/each}
            </select>
          </label>
        </div>

        <label class="shared-filter-sort" title="Relic quality for EV">
          <span>Quality</span>
          <select
            class="shared-filter-select"
            value={$relicViewState.qualityMode}
            on:change={setRelicQualityMode}
          >
            {#each QUALITY_OPTIONS as [key, label]}
              <option value={key}>{label}</option>
            {/each}
          </select>
        </label>

        <label class="shared-filter-sort" title="Vaulted status">
          <span>Vault</span>
          <select
            class="shared-filter-select min-w-[6.2rem]"
            value={$relicViewState.vaultedMode}
            on:change={setRelicVaultedMode}
          >
            {#each VAULTED_OPTIONS as [key, label]}
              <option value={key}>{label}</option>
            {/each}
          </select>
        </label>

        <label class="shared-filter-sort" title="Squad size for EV">
          <span>Squad</span>
          <select
            class="shared-filter-select min-w-[4rem]"
            value={$relicViewState.squadSize}
            on:change={setRelicSquadSize}
          >
            {#each SQUAD_OPTIONS as [size, label]}
              <option value={size}>{label}</option>
            {/each}
          </select>
        </label>

        <button
          class="inline-flex min-h-[2.1rem] cursor-pointer items-center gap-[0.35rem] rounded-[var(--radius-md)] border border-[var(--ui-control-border)] bg-[var(--ui-control-bg)] px-[0.7rem] py-0 font-display text-[0.7rem] font-medium tracking-[0.03em] text-text-secondary transition-[border-color,background-color,color] duration-150 hover:border-accent hover:bg-bg-hover hover:text-accent [&_svg]:shrink-0"
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
        {@const selectedOwned = selectedOwnedQuality(group, ownedModeSelectedQualityByGroup[group.key])}
        {@const selected = selectedEvDataForMode(group, $relicViewState.qualityMode, selectedOwned)}
        {@const rewardIcons = previewRewards(group)}
        <RelicCompactCard
          {group}
          qualityMode={$relicViewState.qualityMode}
          plain={$themeSettings.effects.relicCardStyle === "plain"}
          {selectedOwned}
          {selected}
          {rewardIcons}
          {ownedCount}
          {isOwnedReward}
          {rewardIconSrc}
          {rewardTooltip}
          {setOwnedQuality}
          {openRelic}
        />
      {/each}
    </div>
  {/if}
</section>
