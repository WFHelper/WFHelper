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
    createRelicWarmupController,
    RELIC_TIER_ORDER,
    evHasFreshNoData,
    getCachedEv,
    parseOwnedRelics,
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

  function compareRelicTierThenName(a: RelicGroup, b: RelicGroup): number {
    const tierA = RELIC_TIER_ORDER[a.tier] ?? 99;
    const tierB = RELIC_TIER_ORDER[b.tier] ?? 99;
    return tierA !== tierB ? tierA - tierB : a.name.localeCompare(b.name);
  }

  function compareNullableRelicMetric(
    a: RelicGroup,
    b: RelicGroup,
    direction: number,
    getMetric: (group: RelicGroup) => number | null,
  ): number {
    const aValue = getMetric(a);
    const bValue = getMetric(b);

    if ((aValue == null) !== (bValue == null)) return aValue == null ? 1 : -1;
    if (aValue != null && bValue != null && aValue !== bValue) {
      return direction * (aValue - bValue);
    }

    return compareRelicTierThenName(a, b);
  }

  function compareRelicGroupForSort(
    a: RelicGroup,
    b: RelicGroup,
    sortMode: RelicSortMode,
    sortDirection: "asc" | "desc",
    qualityMode: RelicQualityMode,
  ): number {
    const direction = sortDirection === "desc" ? -1 : 1;

    if (sortMode === "name") return direction * a.name.localeCompare(b.name);
    if (sortMode === "tier") return direction * compareRelicTierThenName(a, b);

    const metricKey = sortMode === "ducatonator" ? "ratio" : sortMode === "ducat" ? "ducat" : "plat";
    return compareNullableRelicMetric(
      a,
      b,
      direction,
      (group) => selectedEvDataForMode(group, qualityMode)[metricKey],
    );
  }

  function normalizeOwnedRewardName(value: string): string {
    const keys = rewardLookupNameKeys(value);
    return keys[keys.length - 1] ?? "";
  }

  function stripRewardQuantityPrefix(value: string): string {
    return value.replace(/^(?:x\s*\d+|\d+\s*x)\s*/i, "").trim();
  }

  function normalizeRewardLookupName(value: string): string {
    const normalized = stripRewardQuantityPrefix(value)
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

    if (normalized === "riven silver") return "riven sliver";
    return normalized;
  }

  function rewardLookupNameKeys(value: string): string[] {
    const nameKey = normalizeRewardLookupName(value);
    if (!nameKey) return [];

    const withoutBlueprint = nameKey.replace(/ blueprint$/i, "");
    return withoutBlueprint !== nameKey ? [nameKey, withoutBlueprint] : [nameKey];
  }

  function addRewardIconName(
    iconsByName: Record<string, string>,
    name: unknown,
    src: unknown,
  ): void {
    if (typeof name !== "string" || typeof src !== "string") return;
    const trimmedSrc = src.trim();
    if (!trimmedSrc) return;

    for (const nameKey of rewardLookupNameKeys(name)) {
      if (!iconsByName[nameKey]) {
        iconsByName[nameKey] = trimmedSrc;
      }
    }
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

  let loading = false;
  let error = "";
  let ownedModeSelectedQualityByGroup: Record<string, RelicQuality> = {};
  let ownedRewardInternalNames: Record<string, true> = {};
  let ownedRewardNames: Record<string, true> = {};
  let rewardGameRefBySlug: Record<string, string> = {};
  let rewardIconBySlug: Record<string, string> = {};
  let rewardIconByName: Record<string, string> = {};

  const warmupController = createRelicWarmupController(() => {
    relicEvRevision.update((value) => value + 1);
  });

  onMount(async () => {
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
      warmupController.scheduleWarmup();
    }
  });

  // Stop this view's background warmups after navigation.
  onDestroy(() => {
    warmupController.destroy();
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

  function computeFilteredRelicGroups(
    db: typeof $relicDb,
    hasInventory: boolean,
    ownedCounts: typeof $relicOwnedCounts,
    viewState: typeof $relicViewState,
    _evRevision: number,
    _priceRevision: number,
  ): RelicGroup[] {
    if (!db) return [];

    let relicGroups = Object.values(db.groups);

    if (hasInventory) {
      const hasOwnedRelics = Object.values(ownedCounts).some((counts) =>
        Object.values(counts || {}).some((count) => count > 0),
      );

      if (hasOwnedRelics) {
        relicGroups = relicGroups.filter((group) => {
          const owned = ownedCounts[group.key];
          return owned && Object.values(owned).some((count) => count > 0);
        });
      }
    }

    if (viewState.tierFilter !== "all") {
      relicGroups = relicGroups.filter((group) => group.tier === viewState.tierFilter);
    }

    if (viewState.vaultedMode !== "all") {
      const wantVaulted = viewState.vaultedMode === "vaulted";
      relicGroups = relicGroups.filter((group) => Boolean(group.vaulted) === wantVaulted);
    }

    if (viewState.search) {
      relicGroups = relicGroups.filter((group) =>
        relicGroupMatchesSearch(group, viewState.search),
      );
    }

    return [...relicGroups].sort((a, b) =>
      compareRelicGroupForSort(
        a,
        b,
        viewState.sortMode,
        viewState.sortDirection,
        viewState.qualityMode,
      ),
    );
  }

  // $relicEvRevision / $priceCacheRevision are listed as args (and ignored by
  // the function) only so Svelte re-runs this when EV/price caches invalidate.
  $: groups = computeFilteredRelicGroups(
    $relicDb,
    Boolean($inventoryData),
    $relicOwnedCounts,
    $relicViewState,
    $relicEvRevision,
    $priceCacheRevision,
  );

  $: warmupController.updateContext({
    db: $relicDb,
    visibleGroups: groups,
    ownedCounts: $relicOwnedCounts,
  });

  // Re-run warmup for the currently selected squad/quality. Debounced inside
  // the controller so simultaneous store updates collapse into one warmup run.
  $: if ($relicViewState.squadSize || $relicViewState.qualityMode) {
    if ($relicDb) warmupController.scheduleWarmup();
  }

  // When any background or modal fetch writes fresh prices into cache,
  // rebuild EV snapshots from the updated reward prices.
  $: if ($priceCacheRevision && $relicDb) {
    warmupController.scheduleEvRefreshFromPriceUpdate();
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

    for (const rewardNameKey of rewardLookupNameKeys(reward.name)) {
      if (rewardIconByName[rewardNameKey]) {
        return rewardIconByName[rewardNameKey];
      }
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

    for (const entry of Object.values($itemDb || {})) {
      addRewardIconName(nextByName, entry?.name, entry?.imageUrl);
    }

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

      addRewardIconName(nextByName, entry.item_name, src);
    }
    rewardGameRefBySlug = nextGameRefBySlug;
    rewardIconBySlug = nextBySlug;
    rewardIconByName = nextByName;
  }
</script>

<section class="view active">
  <div class="mb-4">
    <h2 class="m-0 mb-2 font-display text-3xl font-semibold tracking-[0.03em] text-text-primary">Relic Planner ({groups.length} groups / {visibleRelicEntryCount} entries)</h2>
    <div class="flex items-end border-b border-white/[0.09]">
      <HeaderTabs
        options={TIER_TABS}
        activeKey={$relicViewState.tierFilter}
        onSelect={(tierFilter) => setRelicFilter({ tierFilter })}
      />
      <div class="ml-auto flex items-center gap-2 pb-2 shrink-0 flex-nowrap">
        <SearchBox
          value={$relicViewState.search}
          onValueChange={(search) => setRelicFilter({ search })}
          placeholder="Search relics..."
          class="min-w-16"
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
            class="shared-filter-select min-w-16"
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
            class="shared-filter-select min-w-16"
            value={$relicViewState.squadSize}
            on:change={setRelicSquadSize}
          >
            {#each SQUAD_OPTIONS as [size, label]}
              <option value={size}>{label}</option>
            {/each}
          </select>
        </label>

        <button
          class="inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--ui-control-border)] bg-[var(--ui-control-bg)] px-3 py-0 font-display text-xs font-medium tracking-[0.03em] text-text-secondary transition-[border-color,background-color,color] duration-150 hover:border-accent hover:bg-bg-hover hover:text-accent [&_svg]:shrink-0"
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
