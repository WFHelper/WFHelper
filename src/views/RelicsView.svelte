<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import {
    relicDb,
    relicEvRevision,
    relicOwnedCounts,
    relicViewState,
    setRelicFilter,
  } from "../stores/relics.js";
  import { foundryData, inventoryData, itemDb, parsedItems, wfmItems } from "../stores/data.js";
  import { masteryData } from "../stores/mastery.js";
  import { activeRelic } from "../stores/modals.js";
  import { priceCacheRevision } from "../stores/pricing.js";
  import { themeSettings } from "../stores/theme.js";
  import {
    computeGroupDucatonator,
    computeGroupDucatEv,
    configureRelicRuntimeCacheFingerprint,
    createRelicWarmupController,
    QUALITY_MODES,
    evHasFreshNoData,
    getCachedEv,
    parseOwnedRelics,
    relicGroupHasMatchingReward,
    relicGroupMatchesSearch,
  } from "../lib/relic.js";
  import { invoke, send } from "../lib/ipc.js";
  import { tr, type MessageKey } from "../lib/i18n.js";
  import HeaderTabs from "../components/HeaderTabs.svelte";
  import RelicCompactCard from "../components/relics/RelicCompactCard.svelte";
  import SearchBox from "../components/SearchBox.svelte";
  import SortControl from "../components/SortControl.svelte";
  import { defaultSortDirection } from "../lib/filters.js";
  import { foundryBuildProducts } from "../lib/inventory/foundryResources.js";
  import { buildMasteryLookup } from "../lib/masteryLookup.js";
  import { isRewardNeeded, type RewardNeedContext } from "../lib/relic/rewardNeed.js";
  import { inventorySafetyContext } from "../stores/inventorySafety.js";
  import { stripQuantityPrefix } from "../../config/shared/quantityPrefix.js";
  import {
    RELIC_OWNED_ABOVE_STEPS,
    relicOwnedCountForMode,
    relicQualityForMode,
    selectRelicPlannerRows,
    type RelicPlannerFilters,
  } from "../../config/shared/relicPlannerView.js";
  import { sortRelicRewards } from "../../config/shared/relicRewardOrder.js";
  import type { ParsedItem } from "../types/inventory.js";
  import type { RelicGroup, RelicQuality, RelicReward } from "../types/relics.js";
  import type {
    RelicOwnershipMode,
    RelicQualityMode,
    RelicSortMode,
    RelicVaultedMode,
  } from "../stores/relics.js";

  type RelicQualityModeView = RelicQualityMode;

  const TIER_OPTION_KEYS: Array<[string, MessageKey]> = [
    ["all", "common.all"],
    ["Lith", "relics.tier.lith"],
    ["Meso", "relics.tier.meso"],
    ["Neo", "relics.tier.neo"],
    ["Axi", "relics.tier.axi"],
    ["Requiem", "relics.tier.requiem"],
  ];
  $: TIER_TABS = TIER_OPTION_KEYS.map(([key, i18nKey]) => ({ key, label: $tr(i18nKey) }));

  const SORT_OPTION_KEYS: Array<[RelicSortMode, MessageKey]> = [
    ["tier", "common.default"],
    ["name", "common.name"],
    ["ev", "common.platinum"],
    ["ducat", "common.ducats"],
    ["ducatonator", "relics.sort.ducatsPerPlat"],
    ["owned", "common.owned"],
  ];
  $: SORT_OPTIONS = SORT_OPTION_KEYS.map(
    ([key, i18nKey]) => [key, $tr(i18nKey)] as [RelicSortMode, string],
  );

  const QUALITY_OPTION_KEYS: Array<[RelicQualityModeView, MessageKey]> = [
    ["owned", "common.owned"],
    ["intact", "relics.quality.intact"],
    ["exceptional", "relics.quality.exceptional"],
    ["flawless", "relics.quality.flawless"],
    ["radiant", "relics.quality.radiant"],
  ];
  $: QUALITY_OPTIONS = QUALITY_OPTION_KEYS.map(
    ([key, i18nKey]) => [key, $tr(i18nKey)] as [RelicQualityModeView, string],
  );
  $: QUALITY_LABELS = {
    intact: $tr("relics.quality.intact"),
    exceptional: $tr("relics.quality.exceptional"),
    flawless: $tr("relics.quality.flawless"),
    radiant: $tr("relics.quality.radiant"),
  } as Record<RelicQuality, string>;

  const SQUAD_OPTION_KEYS: Array<[number, MessageKey]> = [
    [1, "relics.squad.solo"],
    [2, "relics.squad.p2"],
    [3, "relics.squad.p3"],
    [4, "relics.squad.p4"],
  ];
  $: SQUAD_OPTIONS = SQUAD_OPTION_KEYS.map(
    ([size, i18nKey]) => [size, $tr(i18nKey)] as [number, string],
  );
  const VAULTED_OPTION_KEYS: Array<[RelicVaultedMode, MessageKey]> = [
    ["all", "common.all"],
    ["vaulted", "common.vaulted"],
    ["unvaulted", "common.unvaulted"],
  ];
  $: VAULTED_OPTIONS = VAULTED_OPTION_KEYS.map(
    ([key, i18nKey]) => [key, $tr(i18nKey)] as [RelicVaultedMode, string],
  );
  $: OWNED_ABOVE_OPTIONS = [
    [0, $tr("relics.minOwned.any")] as [number, string],
    ...RELIC_OWNED_ABOVE_STEPS.map(
      (count) => [count, $tr("relics.minOwned.moreThan", { count })] as [number, string],
    ),
  ];
  const OWNERSHIP_OPTION_KEYS: Array<[RelicOwnershipMode, MessageKey]> = [
    ["owned", "relics.ownership.ownedOnly"],
    ["all", "relics.ownership.all"],
  ];
  $: OWNERSHIP_OPTIONS = OWNERSHIP_OPTION_KEYS.map(
    ([key, i18nKey]) => [key, $tr(i18nKey)] as [RelicOwnershipMode, string],
  );

  const RELIC_QUALITY_COLUMNS = QUALITY_MODES;
  const RELIC_PREVIEW_REWARD_LIMIT = 6;

  function normalizeOwnedRewardName(value: string): string {
    const keys = rewardLookupNameKeys(value);
    return keys[keys.length - 1] ?? "";
  }

  // Relic rewards carry the count in the name ("2X Forma Blueprint", "1200X Kuva").
  function normalizeRewardLookupName(value: string): string {
    const normalized = stripQuantityPrefix(value)
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

  // Without inventory every relic reads as zero copies, which would empty the
  // list (and the pushed planner) instead of filtering it.
  function plannerFiltersOf(
    viewState: typeof $relicViewState,
    hasInventory: boolean,
  ): RelicPlannerFilters {
    return {
      squadSize: viewState.squadSize,
      search: viewState.search,
      containsNeededReward: viewState.containsNeededReward,
      vaultedMode: viewState.vaultedMode,
      qualityMode: viewState.qualityMode,
      ownedAbove: hasInventory ? viewState.ownedAbove : 0,
      sortMode: viewState.sortMode,
      sortDirection: viewState.sortDirection,
    };
  }

  // The overlay cannot run the needed-reward engine: it reads the renderer's
  // safety settings, mastery pins and foundry state. Push the verdict instead.
  function neededRewardKeysForOverlay(): string[] | null {
    if (!$relicViewState.containsNeededReward || !$relicDb) return null;
    return Object.values($relicDb.groups)
      .filter((group) =>
        relicGroupHasMatchingReward(group, (reward) => isRewardNeeded(reward, needContext)),
      )
      .map((group) => group.key);
  }

  function pushFiltersToOverlay(): void {
    send("overlay:push-relic-filters", {
      ...plannerFiltersOf($relicViewState, Boolean($inventoryData)),
      tierFilter: $relicViewState.tierFilter === "all" ? null : $relicViewState.tierFilter,
      neededRewardKeys: neededRewardKeysForOverlay(),
      pinnedQualities: { ...ownedModeSelectedQualityByGroup },
    });
  }

  function toggleRelicSortDirection(): void {
    setRelicFilter({
      sortDirection: $relicViewState.sortDirection === "asc" ? "desc" : "asc",
    });
  }

  function setRelicSortMode(value: string): void {
    const sortMode = value as RelicSortMode;
    setRelicFilter({ sortMode, sortDirection: defaultSortDirection(sortMode) });
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

  function setRelicOwnedAbove(event: Event): void {
    const ownedAbove = Number((event.currentTarget as HTMLSelectElement).value);
    if (Number.isFinite(ownedAbove)) {
      setRelicFilter({ ownedAbove });
    }
  }

  function setRelicVaultedMode(event: Event): void {
    setRelicFilter({
      vaultedMode: (event.currentTarget as HTMLSelectElement).value as RelicVaultedMode,
    });
  }

  function setRelicOwnershipMode(event: Event): void {
    const ownershipMode = (event.currentTarget as HTMLSelectElement).value as RelicOwnershipMode;
    setRelicFilter({
      ownershipMode,
      qualityMode: ownershipMode === "owned" ? "owned" : "intact",
    });
  }

  function openRelic(group: RelicGroup): void {
    activeRelic.set(group);
  }

  let loading = false;
  let errorKey: MessageKey | null = null;
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
        errorKey = "relics.loadFailed";
        console.error("[Relics] getRelicDatabase failed:", e);
      } finally {
        loading = false;
      }
    }

    if ($relicDb) {
      warmupController.scheduleWarmup();
    }
  });

  onDestroy(() => {
    warmupController.destroy();
  });

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
    needContext: RewardNeedContext,
    qualityLabels: Record<RelicQuality, string>,
  ): RelicGroup[] {
    if (!db) return [];

    let relicGroups = Object.values(db.groups);

    if (hasInventory && viewState.ownershipMode === "owned") {
      relicGroups = relicGroups.filter((group) => {
        const owned = ownedCounts[group.key];
        return owned && Object.values(owned).some((count) => count > 0);
      });
    }

    if (viewState.tierFilter !== "all") {
      relicGroups = relicGroups.filter((group) => group.tier === viewState.tierFilter);
    }

    const filters = plannerFiltersOf(viewState, hasInventory);
    const rows = relicGroups.map((group) => {
      const ev = selectedEvDataForMode(group, viewState.qualityMode);
      return {
        group,
        name: group.name,
        tier: group.tier,
        vaulted: Boolean(group.vaulted),
        ownedCount: relicOwnedCountForMode(ownedCounts[group.key], viewState.qualityMode),
        ownedTotal: relicOwnedCountForMode(ownedCounts[group.key], "owned"),
        plat: ev.plat,
        ducat: ev.ducat,
        ratio: ev.ratio,
      };
    });

    return selectRelicPlannerRows(rows, filters, {
      matchesSearch: (row) =>
        relicGroupMatchesSearch(row.group, filters.search, {
          qualityLabels,
          ownedCounts: hasInventory ? (ownedCounts[row.group.key] ?? null) : undefined,
        }),
      hasNeededReward: (row) =>
        relicGroupHasMatchingReward(row.group, (reward) => isRewardNeeded(reward, needContext)),
    }).map((row) => row.group);
  }

  $: needContext = {
    safety: $inventorySafetyContext,
    building: foundryBuildProducts($foundryData),
    mastery: buildMasteryLookup($masteryData).byUniqueName,
    uniqueNameOf: (reward: RelicReward) => rewardUniqueName(reward, rewardGameRefBySlug),
    ownedByName: (reward: RelicReward) =>
      isOwnedRewardIn(reward, rewardGameRefBySlug, ownedRewardInternalNames, ownedRewardNames),
  } satisfies RewardNeedContext;

  // $relicEvRevision / $priceCacheRevision are listed as args (and ignored by the function) only so Svelte re-runs this.
  $: groups = computeFilteredRelicGroups(
    $relicDb,
    Boolean($inventoryData),
    $relicOwnedCounts,
    $relicViewState,
    $relicEvRevision,
    $priceCacheRevision,
    needContext,
    QUALITY_LABELS,
  );

  $: warmupController.updateContext({
    db: $relicDb,
    visibleGroups: groups,
    ownedCounts: $relicOwnedCounts,
  });

  $: if ($relicViewState.squadSize || $relicViewState.qualityMode) {
    if ($relicDb) warmupController.scheduleWarmup();
  }

  $: if ($priceCacheRevision && $relicDb) {
    warmupController.scheduleEvRefreshFromPriceUpdate();
  }

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
    return relicQualityForMode("owned", $relicOwnedCounts[group.key], selectedFromState);
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
    const quality = mode === "owned" ? selectedOwned : mode;
    if (!quality) {
      return {
        plat: null,
        ducat: null,
        ratio: null,
        cls: "no-data",
      };
    }

    return qualityEvData(group, quality);
  }

  function ownedCount(group: RelicGroup, quality: RelicQuality): number {
    const owned = $relicOwnedCounts[group.key];
    return owned?.[quality] ?? 0;
  }

  function previewRewards(group: RelicGroup): RelicReward[] {
    const intactRewards = group.qualities.intact?.rewards || [];
    if (intactRewards.length > 0) {
      return sortRelicRewards(intactRewards).slice(-RELIC_PREVIEW_REWARD_LIMIT);
    }

    for (const quality of RELIC_QUALITY_COLUMNS) {
      const rewards = group.qualities[quality]?.rewards || [];
      if (rewards.length > 0) {
        return sortRelicRewards(rewards).slice(-RELIC_PREVIEW_REWARD_LIMIT);
      }
    }

    return [];
  }

  function rewardSlug(reward: RelicReward): string {
    return typeof reward.urlName === "string" && reward.urlName.trim().length > 0
      ? reward.urlName.trim().toLowerCase()
      : "";
  }

  function rewardUniqueName(
    reward: RelicReward,
    gameRefBySlug: Record<string, string>,
  ): string | null {
    if (typeof reward.uniqueName === "string" && reward.uniqueName.trim().length > 0) {
      return reward.uniqueName.trim();
    }
    const slug = rewardSlug(reward);
    return (slug ? gameRefBySlug[slug] : "") || null;
  }

  function isOwnedRewardIn(
    reward: RelicReward,
    gameRefBySlug: Record<string, string>,
    internalNames: Record<string, true>,
    names: Record<string, true>,
  ): boolean {
    const slug = rewardSlug(reward);
    const gameRef = slug ? gameRefBySlug[slug] : "";
    if (gameRef && internalNames[gameRef]) {
      return true;
    }
    return Boolean(names[normalizeOwnedRewardName(reward.name)]);
  }

  function isOwnedReward(reward: RelicReward): boolean {
    return isOwnedRewardIn(reward, rewardGameRefBySlug, ownedRewardInternalNames, ownedRewardNames);
  }

  function rewardIconSrc(reward: RelicReward): string | null {
    const slug = rewardSlug(reward);

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

  function makeRewardTooltip(
    t: (key: MessageKey, params?: Record<string, string | number>) => string,
  ): (reward: RelicReward) => string {
    return (reward) =>
      t("relics.rewardTooltip", {
        name: reward.name,
        rarity: reward.rarity || t("common.unknown"),
        chance: reward.chance,
      });
  }

  $: rewardTooltip = makeRewardTooltip($tr);

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
      const icon =
        typeof entry.icon === "string" && entry.icon.trim().length > 0 ? entry.icon : null;
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
  <h2 class="m-0 mb-2 font-display text-3xl font-semibold tracking-[0.03em] text-text-primary">
    {$tr("relics.title", { count: groups.length })}
  </h2>
  <div class="view-sticky-filters mb-4" data-tour="relic-filters">
    <div class="flex flex-wrap items-end border-b border-border-subtle" data-relic-filter-row>
      <div class="shrink-0" data-relic-tier-tabs>
        <HeaderTabs
          options={TIER_TABS}
          activeKey={$relicViewState.tierFilter}
          onSelect={(tierFilter) => setRelicFilter({ tierFilter })}
        />
      </div>
      <div
        class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5 pb-2"
        data-relic-filter-controls
      >
        <SearchBox
          value={$relicViewState.search}
          onValueChange={(search) => setRelicFilter({ search })}
          placeholder={$tr("relics.searchPlaceholder")}
          class="w-40 min-w-40 shrink-0"
        />

        <div class="shrink-0 [&_.sort-control-select]:min-w-28">
          <SortControl
            value={$relicViewState.sortMode}
            options={SORT_OPTIONS}
            direction={$relicViewState.sortDirection}
            onSelect={setRelicSortMode}
            onToggleDirection={toggleRelicSortDirection}
          />
        </div>

        <!-- A select clips its value without an ellipsis. -->
        <label class="shared-filter-sort" title={$tr("relics.ownershipTitle")}>
          <span>{$tr("common.relics")}</span>
          <select
            class="shared-filter-select min-w-32"
            value={$relicViewState.ownershipMode}
            on:change={setRelicOwnershipMode}
          >
            {#each OWNERSHIP_OPTIONS as [key, label]}
              <option value={key}>{label}</option>
            {/each}
          </select>
        </label>

        <button
          type="button"
          class="filter-tab min-h-8 shrink-0 whitespace-nowrap"
          class:active={$relicViewState.containsNeededReward}
          title={$tr("relics.neededRewardTitle")}
          on:click={() =>
            setRelicFilter({ containsNeededReward: !$relicViewState.containsNeededReward })}
        >
          {$tr("relics.neededRewardLabel")}
        </button>

        <label class="shared-filter-sort" title={$tr("relics.qualityTitle")}>
          <span>{$tr("relics.qualityLabel")}</span>
          <select
            class="shared-filter-select min-w-32"
            data-relic-quality
            value={$relicViewState.qualityMode}
            on:change={setRelicQualityMode}
          >
            {#each QUALITY_OPTIONS as [key, label]}
              <option value={key}>{label}</option>
            {/each}
          </select>
        </label>

        <label class="shared-filter-sort" title={$tr("relics.minOwnedTitle")}>
          <span>{$tr("relics.minOwnedLabel")}</span>
          <select
            class="shared-filter-select min-w-28"
            data-relic-owned-above
            value={$relicViewState.ownedAbove}
            on:change={setRelicOwnedAbove}
          >
            {#each OWNED_ABOVE_OPTIONS as [value, label]}
              <option {value}>{label}</option>
            {/each}
          </select>
        </label>

        <label class="shared-filter-sort" title={$tr("relics.vaultedTitle")}>
          <span>{$tr("relics.vaultedLabel")}</span>
          <select
            class="shared-filter-select min-w-28"
            value={$relicViewState.vaultedMode}
            on:change={setRelicVaultedMode}
          >
            {#each VAULTED_OPTIONS as [key, label]}
              <option value={key}>{label}</option>
            {/each}
          </select>
        </label>

        <label class="shared-filter-sort" title={$tr("relics.squadTitle")}>
          <span>{$tr("relics.squadLabel")}</span>
          <select
            class="shared-filter-select min-w-24"
            value={$relicViewState.squadSize}
            on:change={setRelicSquadSize}
          >
            {#each SQUAD_OPTIONS as [size, label]}
              <option value={size}>{label}</option>
            {/each}
          </select>
        </label>

        <button
          class="inline-flex min-h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-md)] border border-[var(--ui-control-border)] bg-[var(--ui-control-bg)] px-3 py-0 font-display text-xs font-medium tracking-[0.03em] text-text-secondary transition-[border-color,background-color,color] duration-150 hover:border-accent hover:bg-bg-hover hover:text-accent [&_svg]:shrink-0"
          title={$tr("relics.pushOverlayTitle")}
          on:click={pushFiltersToOverlay}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            width="14"
            height="14"
          >
            <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
            <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
          </svg>
          {$tr("relics.pushOverlay")}
        </button>
      </div>
    </div>
  </div>

  {#if loading}
    <div class="empty-state"><p>{$tr("relics.loading")}</p></div>
  {:else if errorKey}
    <div class="empty-state"><p>{$tr(errorKey)}</p></div>
  {:else if groups.length === 0}
    <div class="empty-state"><p>{$tr("relics.empty")}</p></div>
  {:else}
    <div
      class="grid gap-[var(--relic-grid-gap)] grid-cols-[repeat(auto-fill,minmax(min(100%,18.5rem),1fr))]"
    >
      {#each groups as group (group.key)}
        {@const selectedOwned = selectedOwnedQuality(
          group,
          ownedModeSelectedQualityByGroup[group.key],
        )}
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
