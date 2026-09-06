<script context="module" lang="ts">
  import { registerSections } from "../lib/layout/registry.js";

  registerSections("mastery", [
    {
      id: "mastery.summary",
      view: "mastery",
      labelKey: "layout.section.masterySummary",
      defaultSpan: "full",
      canCollapse: true,
    },
    {
      id: "mastery.content",
      view: "mastery",
      labelKey: "layout.section.masteryContent",
      defaultSpan: "full",
      minSpan: "full",
      canHide: false,
    },
  ]);
</script>

<script lang="ts">
  import { itemLabel } from "../lib/itemLabel.js";
  import { SvelteMap } from "svelte/reactivity";
  import EditLayoutBar from "../components/layout/EditLayoutBar.svelte";
  import LayoutGrid from "../components/layout/LayoutGrid.svelte";

  import { masteryData } from "../stores/mastery.js";
  import {
    wfmItems,
    foundryData,
    inventoryData,
    itemDb,
    parsedItems,
    componentOwnership,
  } from "../stores/data.js";
  import { buildSubsumedFamilySet, isFrameSubsumed, isSubsumableFrame } from "../lib/helminth.js";
  import { componentUniqueNameAliases } from "../../config/shared/componentNames.js";
  import { masteryProjectionSubtext } from "../lib/masteryProjection.js";
  import { buildMasteryRoadmap, estimateMasteryPurchaseCost } from "../lib/masteryRoadmap.js";
  import {
    buildMasteryPlan,
    type MasteryPlan,
    type PlannerPin,
    type PlannerSort,
  } from "../lib/masteryPlanner.js";
  import {
    masteryPinKeepMastered,
    masteryPins,
    restoreMasteryPins,
    toggleMasteryPin,
    unpinMasteryItems,
  } from "../stores/masteryPins.js";
  import { addToast } from "../stores/toasts.js";
  import { getLookupByName } from "../lib/inventoryMarket.js";
  import { setRootOf } from "../lib/inventory/fullSets.js";
  import { parseOwnedRelics } from "../lib/relic.js";
  import { activeItem, activeComponent } from "../stores/modals.js";
  import { hideFounderMasteryItems } from "../stores/preferences.js";
  import { locale, tr, type Translator } from "../lib/i18n.js";
  import type { MessageKey } from "../lib/i18n.js";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import HeaderTabs from "../components/HeaderTabs.svelte";
  import SummaryStrip, { type SummaryStripItem } from "../components/SummaryStrip.svelte";
  import ThemedPanel from "../components/ThemedPanel.svelte";
  import CollapsibleSection from "../components/CollapsibleSection.svelte";
  import {
    persistedBoolean,
    persistedString,
    readStorage,
    writeStorage,
  } from "../lib/persistence.js";
  import { applySharedFiltersAndSort } from "../lib/filters.js";
  import { getCachedPriceState } from "../lib/wfm/priceCache.js";
  import { sharedFilters } from "../stores/filters.js";
  import { relicDb } from "../stores/relics.js";
  import ItemImage from "../components/ItemImage.svelte";
  import MasteryRoadmap from "../components/mastery/MasteryRoadmap.svelte";
  import MasteryPlanner from "../components/mastery/MasteryPlanner.svelte";
  import CodexPanel from "../components/mastery/CodexPanel.svelte";
  import ArchonShardPips from "../components/archon/ArchonShardPips.svelte";
  import ArchonShardSummary from "../components/archon/ArchonShardSummary.svelte";
  import { parseArchonShards, summarizeArchonShards } from "../lib/inventory/archonShards.js";
  import { fallbackNameFromUniqueName } from "../../config/shared/displayName.js";
  import { send } from "../lib/ipc.js";
  import type {
    ComponentInfo,
    MasteryCategoryStats,
    MasteryStatus,
    ProgressPair,
  } from "../types/inventory.js";
  import type { FoundryState } from "../types/filters.js";

  const CAT_ORDER = [
    "Warframes",
    "Primary",
    "Secondary",
    "Melee",
    "Companions",
    "Archwing",
    "Amps",
    "Necramech",
    "Misc",
  ];
  $: MASTERY_SORT_OPTIONS = [
    ["name", $tr("common.name")],
    ["owned", $tr("common.owned")],
    ["parts_owned", $tr("mastery.sort.partsOwned")],
    ["mastery_xp", $tr("mastery.sort.masteryXp")],
    ["platinum", $tr("common.platinum")],
  ] as Array<["name" | "owned" | "parts_owned" | "mastery_xp" | "platinum", string]>;
  const FOUNDER_ITEM_NAMES = new Set(["Excalibur Prime", "Lato Prime", "Skana Prime"]);

  const INCOMPLETE_SETS_TAB = "__incomplete_sets";
  const VIEW_TAB_KEY = "wf_mastery_view_tab";
  const CAT_TAB_KEY = "wf_mastery_cat_tab";
  const STATUS_TAB_KEY = "wf_mastery_status_tab";
  // Single source of truth per tab row: restore() runs at init and needs the bare
  // keys, the labeled arrays below translate that same list.
  const STATUS_TAB_DEFS: Array<{ key: string; labelKey: MessageKey }> = [
    { key: "all", labelKey: "common.all" },
    { key: "missing", labelKey: "common.missing" },
    { key: "progress", labelKey: "common.inProgress" },
    { key: "mastered", labelKey: "common.mastered" },
  ];
  const VIEW_TAB_DEFS: Array<{ key: string; labelKey: MessageKey }> = [
    { key: "collection", labelKey: "mastery.viewCollection" },
    { key: "roadmap", labelKey: "mastery.viewRoadmap" },
    { key: "planned", labelKey: "mastery.viewPlanned" },
    { key: "codex", labelKey: "mastery.viewCodex" },
  ];
  const PLANNER_SORT_KEYS = ["mastery_xp", "completeness", "name"] as const;
  const plannerSort = persistedString<PlannerSort>(
    "wf_mastery_planner_sort",
    PLANNER_SORT_KEYS,
    "mastery_xp",
  );
  const STATUS_TAB_KEYS = STATUS_TAB_DEFS.map((tab) => tab.key);
  const VIEW_TAB_KEYS = VIEW_TAB_DEFS.map((tab) => tab.key);
  $: STATUS_TABS = STATUS_TAB_DEFS.map(({ key, labelKey }) => ({ key, label: $tr(labelKey) }));
  $: VIEW_TABS = VIEW_TAB_DEFS.map(({ key, labelKey }) => ({ key, label: $tr(labelKey) }));

  // Category keys are data-driven; a stale restore falls back once categories load.
  let catFilter = readStorage(CAT_TAB_KEY) || "all";
  let statusFilter = restoreStatusTab();
  let viewTab = restoreViewTab();
  const breakdownExpanded = persistedBoolean("mastery-breakdown-expanded", false);
  const archonExpanded = persistedBoolean("mastery-archon-expanded", false);
  const masteryFilters = sharedFilters("mastery");

  function restoreStatusTab(): string {
    const raw = readStorage(STATUS_TAB_KEY);
    return raw && STATUS_TAB_KEYS.includes(raw) ? raw : "all";
  }

  function restoreViewTab(): string {
    const raw = readStorage(VIEW_TAB_KEY);
    return raw && VIEW_TAB_KEYS.includes(raw) ? raw : "collection";
  }

  function selectCategoryTab(key: string): void {
    catFilter = key;
    writeStorage(CAT_TAB_KEY, key);
  }

  function selectStatusTab(key: string): void {
    statusFilter = key;
    writeStorage(STATUS_TAB_KEY, key);
  }

  function selectViewTab(key: string): void {
    viewTab = VIEW_TAB_KEYS.includes(key) ? key : "collection";
    writeStorage(VIEW_TAB_KEY, viewTab);
  }

  function orderedCategories(byCategory: Record<string, MasteryCategoryStats>): string[] {
    const keys = Object.keys(byCategory);
    const ordered = CAT_ORDER.filter((c) => keys.includes(c));
    const extras = keys.filter((c) => !CAT_ORDER.includes(c)).sort((a, b) => a.localeCompare(b));
    return [...ordered, ...extras];
  }

  function isFounderItem(name: string): boolean {
    return FOUNDER_ITEM_NAMES.has(name);
  }

  function masteryStatsForItems(
    items: NonNullable<typeof $masteryData>["items"],
    data: NonNullable<typeof $masteryData>,
  ): NonNullable<typeof $masteryData>["stats"] {
    const stats: NonNullable<typeof $masteryData>["stats"] = {
      total: items.length,
      mastered: 0,
      inProgress: 0,
      missing: 0,
      byCategory: {},
      profileMastery: data.stats.profileMastery ?? null,
    };

    for (const item of items) {
      if (!stats.byCategory[item.category]) {
        stats.byCategory[item.category] = { total: 0, mastered: 0, inProgress: 0, missing: 0 };
      }
      stats.byCategory[item.category].total++;
      if (item.status === "mastered") {
        stats.mastered++;
        stats.byCategory[item.category].mastered++;
      } else if (item.status === "progress") {
        stats.inProgress++;
        stats.byCategory[item.category].inProgress++;
      } else {
        stats.missing++;
        stats.byCategory[item.category].missing++;
      }
    }

    return stats;
  }

  function masteryViewData(data: typeof $masteryData, hideFounder: boolean): typeof $masteryData {
    if (!data || !hideFounder) return data;
    const items = data.items.filter((item) => !isFounderItem(item.name));
    return {
      ...data,
      items,
      stats: masteryStatsForItems(items, data),
    };
  }

  $: displayMasteryData = masteryViewData($masteryData, $hideFounderMasteryItems);
  $: categories = displayMasteryData ? orderedCategories(displayMasteryData.stats.byCategory) : [];

  function buildMasterySummary(
    data: typeof $masteryData,
    foundry: ReturnType<typeof buildFoundryIndex>,
    t: Translator,
    localeCode: string,
  ): SummaryStripItem[] {
    if (!data) return [];
    const stats = data.stats;
    const profileMastery = stats.profileMastery || null;
    const rows: SummaryStripItem[] = [
      { key: "mastered", value: stats.mastered, label: t("common.mastered"), tone: "success" },
      { key: "progress", value: stats.inProgress, label: t("common.inProgress"), tone: "warning" },
      { key: "missing", value: stats.missing, label: t("common.missing"), tone: "danger" },
      { key: "total", value: stats.total, label: t("common.total") },
    ];
    if (profileMastery && profileMastery.rank != null) {
      const nextRank = profileMastery.rank + 1;
      let label = t("mastery.progressUnavailable");
      if (profileMastery.testReady && profileMastery.xpIntoRank != null) {
        // Banked XP overflows past the bar; show the real figure, not a clamp.
        label = t("mastery.mrXpReady", {
          xp: profileMastery.xpIntoRank.toLocaleString(localeCode),
          needed: (profileMastery.xpForNext ?? 0).toLocaleString(localeCode),
          rank: nextRank,
        });
      } else if (profileMastery.testReady) {
        label = t("mastery.mrTestReady", { rank: nextRank });
      } else if (profileMastery.xpIntoRank != null && profileMastery.xpForNext != null) {
        // The game counts down to the next rank ("LEGENDARY 7 IN 93,362"); match it.
        const remaining = Math.max(0, profileMastery.xpForNext - profileMastery.xpIntoRank);
        label = t("mastery.mrRemainingXp", {
          rank: nextRank,
          xp: remaining.toLocaleString(localeCode),
        });
      } else if (profileMastery.percentToNext != null) {
        label = t("mastery.percentToNext", { pct: profileMastery.percentToNext });
      }
      const mrRow: SummaryStripItem = { key: "mr", value: `MR ${profileMastery.rank}`, label };
      if (profileMastery.totalXp != null) {
        const readyXp = data.items.reduce((sum, item) => {
          if (item.status === "mastered") return sum;
          if (foundryStatusFor(item, foundry) !== "claimable") return sum;
          return sum + (item.masteryXpRemaining ?? 0);
        }, 0);
        const projection = masteryProjectionSubtext(
          t,
          profileMastery.rank,
          profileMastery.totalXp,
          readyXp,
          localeCode,
        );
        if (projection) {
          mrRow.subtext = projection;
          mrRow.subtextTone = "success";
        }
      }
      rows.push(mrRow);
    }
    return rows;
  }

  $: masterySummaryItems = buildMasterySummary(displayMasteryData, foundryIndex, $tr, $locale);
  // Straight from the account, so unaffected by the founder-item filter.
  $: completion = $masteryData?.stats?.completion ?? null;
  $: starChartRows = (
    completion
      ? [
          [$tr("common.normal"), completion.starChart.normal],
          [$tr("mastery.junctions"), completion.starChart.junctions],
          [$tr("common.steelPath"), completion.starChart.steelPath],
          [$tr("mastery.steelPathJunctions"), completion.starChart.steelPathJunctions],
        ]
      : []
  ) as Array<[string, ProgressPair]>;
  $: intrinsicRows = (
    completion
      ? [
          [$tr("world.railjack"), completion.intrinsics.railjack],
          [$tr("mastery.duviri"), completion.intrinsics.drifter],
        ]
      : []
  ) as Array<[string, ProgressPair]>;

  // Keyed by productUniqueName, name as fallback; parts match the same set.
  type FoundryStatus = "in-progress" | "claimable";
  function buildFoundryIndex(foundry: typeof $foundryData): {
    byUnique: SvelteMap<string, FoundryStatus>;
    byName: SvelteMap<string, FoundryStatus>;
  } {
    const byUnique = new SvelteMap<string, FoundryStatus>();
    const byName = new SvelteMap<string, FoundryStatus>();
    const now = Date.now();
    for (const b of foundry.building) {
      const status: FoundryStatus =
        b.endDate && b.endDate.getTime() <= now ? "claimable" : "in-progress";
      // Claimable outranks in-progress if the same product somehow appears twice.
      if (b.productUniqueName && byUnique.get(b.productUniqueName) !== "claimable") {
        byUnique.set(b.productUniqueName, status);
      }
      const nameKey = b.name.trim().toLowerCase();
      if (nameKey && byName.get(nameKey) !== "claimable") byName.set(nameKey, status);
    }
    return { byUnique, byName };
  }

  function foundryStatusFor(
    item: { uniqueName?: string | null; name: string },
    foundry: ReturnType<typeof buildFoundryIndex>,
  ): FoundryStatus | undefined {
    return (
      (item.uniqueName ? foundry.byUnique.get(item.uniqueName) : undefined) ??
      foundry.byName.get(item.name.trim().toLowerCase())
    );
  }

  function isComponentOwned(comp: ComponentInfo): boolean {
    return comp.owned === true || (comp.ownedCount ?? 0) >= (comp.itemCount || 1);
  }

  function componentStateLabelKey(state: "building" | "owned" | "missing"): MessageKey {
    if (state === "building") return "mastery.badgeCrafting";
    return state === "owned" ? "common.owned" : "common.missing";
  }

  /** The card badges are the source of truth here: "Ready" is a finished build. */
  function foundryStateOf(
    status: FoundryStatus | undefined,
    buildable: boolean,
  ): FoundryState | undefined {
    if (status === "claimable") return "claimable";
    if (status === "in-progress") return "building";
    return buildable ? "buildable" : undefined;
  }

  $: foundryIndex = buildFoundryIndex($foundryData);
  $: subsumedFamilies = buildSubsumedFamilySet($inventoryData, $itemDb);

  // Derived only, every render: shards are never cached, so a stale inventory
  // simply shows fewer of them.
  $: archonShards = parseArchonShards($inventoryData);
  $: archonSummary = summarizeArchonShards(archonShards);

  function frameLabel(itemType: string, db: typeof $itemDb): string {
    const entry = db[itemType];
    return itemLabel(entry) || fallbackNameFromUniqueName(itemType);
  }

  // Every mastery row, not only Warframes: the planner opens weapons through it too.
  function openMasteryItemByUniqueName(itemType: string): void {
    const match = hydratedMasteryItems.find(
      (item) => (item.uniqueName || item.internalName) === itemType,
    );
    if (match) activeItem.set(match);
  }

  // Precompute values outside the keyed loop so WFM updates patch only changed
  // items instead of rerendering the full template.
  function hydrateMasteryItems(
    data: typeof $masteryData,
    wfmLookup: typeof $wfmItems,
    foundry: ReturnType<typeof buildFoundryIndex>,
    subsumed: Set<string>,
  ) {
    if (!data) return [];
    return data.items.map((item) => {
      const mastered = item.status === "mastered";
      const missing = item.status === "missing";
      const nextPct = missing
        ? 0
        : Math.max(0, Math.min(100, Math.floor((item.rank / Math.max(item.maxRank, 1)) * 100)));
      const wfm = wfmLookup[item.name.toLowerCase()] || null;
      const foundryStatus = foundryStatusFor(item, foundry);
      // undefined, not false, for anything that can never be fed to the
      // Helminth: the strict tri-state filter drops those rows entirely.
      const isSubsumed =
        item.category === "Warframes" && isSubsumableFrame(item.name)
          ? isFrameSubsumed(item.name, subsumed)
          : undefined;
      const components = (item.components || []).map((comp) => ({
        ...comp,
        // Sets name a part ...Component while the foundry builds ...Blueprint.
        building: comp.uniqueName
          ? componentUniqueNameAliases(comp.uniqueName).some((un) => foundry.byUnique.has(un))
          : false,
      }));
      const partsOwned = components.length > 0 ? components.filter(isComponentOwned).length : null;
      const owned = item.currentlyOwned === true;
      const buildable =
        !owned && components.length > 0 && components.every((comp) => comp.owned === true);
      const rootPrice = wfm?.url_name ? (getCachedPriceState(wfm.url_name)?.median ?? null) : null;
      const estimatedCost = estimateMasteryPurchaseCost(rootPrice, components, (component) => {
        const byUnique = component.uniqueName
          ? wfmLookup[component.uniqueName.toLowerCase()] || null
          : null;
        const marketItem = byUnique || getLookupByName(component.name, wfmLookup);
        return marketItem?.url_name
          ? (getCachedPriceState(marketItem.url_name)?.median ?? null)
          : null;
      });
      return {
        ...item,
        masteryXpRemaining: item.masteryXpRemaining ?? 0,
        components,
        mastered,
        missing,
        nextPct,
        wfm,
        foundryStatus,
        subsumed: isSubsumed,
        partType: item.isPrime ? ("prime" as const) : ("normal" as const),
        leveledUp: item.rank > 0,
        amount: owned ? 1 : 0,
        owned,
        // Snapshot-only lookup: no per-card hydration for 800+ mastery rows.
        platinum: rootPrice,
        estimatedCost,
        buildable,
        partsOwned,
        foundryState: foundryStateOf(foundryStatus, buildable),
      };
    });
  }

  $: hydratedMasteryItems = hydrateMasteryItems(
    displayMasteryData,
    $wfmItems,
    foundryIndex,
    subsumedFamilies,
  );
  $: filtered = applySharedFiltersAndSort(
    hydratedMasteryItems
      .filter((item) => catFilter === "all" || item.category === catFilter)
      .filter((item) => statusFilter === "all" || item.status === statusFilter),
    $masteryFilters,
  );
  $: masteryOwnedRelics = parseOwnedRelics($inventoryData, $relicDb);
  $: masteryRoadmap = buildMasteryRoadmap(hydratedMasteryItems, $relicDb, masteryOwnedRelics);

  function buildPlannerPins(
    pinList: string[],
    items: NonNullable<typeof $masteryData>["items"],
    db: typeof $itemDb,
  ): PlannerPin[] {
    const byUniqueName = new SvelteMap<string, (typeof items)[number]>();
    for (const item of items) {
      const key = item.uniqueName || item.internalName;
      if (key && !byUniqueName.has(key)) byUniqueName.set(key, item);
    }
    return pinList.map((uniqueName) => {
      const match = byUniqueName.get(uniqueName);
      const entry = db[uniqueName];
      const displayName = match?.displayName || entry?.displayName;
      return {
        uniqueName,
        name: match?.name || entry?.name || fallbackNameFromUniqueName(uniqueName),
        ...(displayName ? { displayName } : {}),
        imageUrl: match?.imageUrl ?? entry?.imageUrl ?? null,
        masteryXpRemaining: match?.masteryXpRemaining ?? 0,
      };
    });
  }

  // One walk per pin over the whole item DB, so the plan is gated on the open
  // tab and reads the mastery rows, not the hydrated ones a WFM tick rewrites.
  const EMPTY_MASTERY_PLAN: MasteryPlan = {
    items: [],
    totals: [],
    totalCredits: 0,
    craftableCount: 0,
  };
  $: masteryPlan =
    viewTab === "planned" && $masteryPins.length > 0
      ? buildMasteryPlan(
          buildPlannerPins($masteryPins, displayMasteryData?.items ?? [], $itemDb),
          $itemDb,
          $componentOwnership,
        )
      : EMPTY_MASTERY_PLAN;
  $: pinnedSet = new Set($masteryPins);

  /** Mastered items by uniqueName, valued with the label the undo notice needs. */
  $: masteredMasteryLabels = (() => {
    const mastered = new SvelteMap<string, string>();
    for (const item of displayMasteryData?.items ?? []) {
      if (item.status !== "mastered") continue;
      const key = item.uniqueName || item.internalName;
      if (key) mastered.set(key, itemLabel(item));
    }
    return mastered;
  })();

  // Pins the account has since mastered leave on their own. One notice per drop
  // event, so mastering a second item cannot swallow the first undo.
  let autoUnpinNotices: Array<{
    id: number;
    dropped: string[];
    key: MessageKey;
    params: Record<string, string | number>;
  }> = [];
  let autoUnpinSeq = 0;

  function autoUnpinMastered(
    pinList: string[],
    mastered: SvelteMap<string, string>,
    keepMastered: string[],
    t: Translator,
  ): void {
    if (pinList.length === 0 || mastered.size === 0) return;
    const keep = new Set(keepMastered);
    const drop = pinList.filter((uniqueName) => mastered.has(uniqueName) && !keep.has(uniqueName));
    if (drop.length === 0) return;

    const single = drop.length === 1;
    const key: MessageKey = single
      ? "mastery.planner.autoUnpinnedOne"
      : "mastery.planner.autoUnpinnedMany";
    const params: Record<string, string | number> = single
      ? { name: mastered.get(drop[0]) ?? "" }
      : { count: drop.length };
    unpinMasteryItems(drop);
    autoUnpinNotices = [
      ...autoUnpinNotices,
      { id: (autoUnpinSeq += 1), dropped: [...drop], key, params },
    ];
    addToast({ level: "success", title: t("mastery.viewPlanned"), message: t(key, params) });
  }

  $: autoUnpinMastered($masteryPins, masteredMasteryLabels, $masteryPinKeepMastered, $tr);

  function dismissAutoUnpin(id: number): void {
    autoUnpinNotices = autoUnpinNotices.filter((notice) => notice.id !== id);
  }

  function undoAutoUnpin(id: number): void {
    const notice = autoUnpinNotices.find((entry) => entry.id === id);
    if (!notice) return;
    restoreMasteryPins(notice.dropped);
    dismissAutoUnpin(id);
  }

  function pinKeyOf(item: { uniqueName?: string; internalName?: string }): string {
    return item.uniqueName || item.internalName || "";
  }

  function formatPercent(n: number, total: number): string {
    return total > 0 ? ((n / total) * 100).toFixed(1) : "0.0";
  }
  function boundedPercent(n: number, total: number): number {
    const percent = total > 0 ? (n / total) * 100 : 0;
    return Math.max(0, Math.min(100, percent));
  }
  const RING_R = 52;
  const RING_C = 2 * Math.PI * RING_R;

  // Incomplete Sets sits just before Misc, which is the catch-all bucket.
  $: categoryTabs = (() => {
    const tabs = categories.map((cat) => ({ key: cat, label: cat }));
    const setsTab = { key: INCOMPLETE_SETS_TAB, label: $tr("mastery.incompleteSets") };
    const miscAt = tabs.findIndex((tab) => tab.key.toLowerCase() === "misc");
    tabs.splice(miscAt >= 0 ? miscAt : tabs.length, 0, setsTab);
    return [{ key: "all", label: $tr("common.all") }, ...tabs];
  })();

  // Drop a restored category that no longer exists in the loaded data.
  $: if (categories.length > 0 && !categoryTabs.some((tab) => tab.key === catFilter)) {
    catFilter = "all";
  }

  /** A set row has no mastery status of its own (rank 0 of 1), so every set read
   *  as "not mastered". Resolve it from the set root instead. */
  function buildSetStatusLookup(data: typeof $masteryData): {
    byUniqueName: SvelteMap<string, MasteryStatus>;
    byName: SvelteMap<string, MasteryStatus>;
  } {
    const byUniqueName = new SvelteMap<string, MasteryStatus>();
    const byName = new SvelteMap<string, MasteryStatus>();
    for (const item of data?.items ?? []) {
      if (!item.status) continue;
      const uniqueName = item.uniqueName || item.internalName;
      if (uniqueName && !byUniqueName.has(uniqueName)) byUniqueName.set(uniqueName, item.status);
      const nameKey = normalizeLookupKey(item.name);
      if (nameKey && !byName.has(nameKey)) byName.set(nameKey, item.status);
    }
    return { byUniqueName, byName };
  }

  function normalizeLookupKey(value: string | null | undefined): string {
    return (value || "").trim().toLowerCase();
  }

  $: setStatusLookup = buildSetStatusLookup(displayMasteryData);

  // Started but unfinished. Shares the filter bar with the category tabs, so
  // mastered/prime/vaulted and the sort dropdown all apply here too.
  $: incompleteSets = applySharedFiltersAndSort(
    $parsedItems
      .filter((entry) => entry.inventoryGroup === "incomplete_sets")
      .map((entry) => {
        const status =
          setStatusLookup.byUniqueName.get(setRootOf(entry.internalName)) ??
          setStatusLookup.byName.get(normalizeLookupKey(entry.name.replace(/\s+Set$/i, "")));
        return {
          ...entry,
          ...(status ? { status } : {}),
          partsOwned: entry.ownedPartTypes ?? null,
        };
      }),
    $masteryFilters,
  );
</script>

<section class="view active">
  <div class="view-header">
    <h2>{$tr("mastery.title")}</h2>
    <div class="ml-auto"><EditLayoutBar view="mastery" /></div>
  </div>

  {#each autoUnpinNotices as notice (notice.id)}
    <div
      class="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-success/30 bg-success/10 px-3 py-2"
      data-mastery-auto-unpin
    >
      <span class="text-sm text-text-secondary">{$tr(notice.key, notice.params)}</span>
      <div class="flex items-center gap-2">
        <button type="button" class="btn-secondary" on:click={() => undoAutoUnpin(notice.id)}
          >{$tr("mastery.planner.undo")}</button
        >
        <button
          type="button"
          class="btn-secondary"
          aria-label={$tr("common.dismissNotification")}
          on:click={() => dismissAutoUnpin(notice.id)}>{$tr("common.dismiss")}</button
        >
      </div>
    </div>
  {/each}

  <div class="mb-3 flex items-end border-b border-border-subtle" data-tour="mastery-view-tabs">
    <HeaderTabs options={VIEW_TABS} activeKey={viewTab} onSelect={selectViewTab} />
  </div>

  {#if viewTab === "codex"}
    <CodexPanel />
  {:else if displayMasteryData}
    {@const stats = displayMasteryData.stats}
    {@const masteredPct = formatPercent(stats.mastered, stats.total)}

    <LayoutGrid view="mastery" gapClass="gap-0" let:sectionId>
      {#if sectionId === "mastery.summary"}
        <div class="grid gap-3 mb-3.5">
          <div class="flex items-center gap-3.5" data-mastery-summary>
            <div class="shrink-0">
              <svg class="h-[120px] w-[120px]" viewBox="0 0 120 120">
                <circle
                  cx="60"
                  cy="60"
                  r={RING_R}
                  fill="none"
                  stroke="rgba(255,255,255,0.06)"
                  stroke-width="8"
                />
                <circle
                  cx="60"
                  cy="60"
                  r={RING_R}
                  fill="none"
                  stroke="var(--accent-blue)"
                  stroke-width="8"
                  stroke-dasharray={RING_C}
                  stroke-dashoffset={RING_C * (1 - stats.mastered / Math.max(stats.total, 1))}
                  stroke-linecap="round"
                  transform="rotate(-90 60 60)"
                />
                <text
                  x="60"
                  y="55"
                  text-anchor="middle"
                  fill="var(--text-primary)"
                  font-size="22"
                  font-weight="700"
                  font-family="Rajdhani">{masteredPct}%</text
                >
                <text
                  class="ring-caption"
                  x="60"
                  y="72"
                  text-anchor="middle"
                  fill="var(--text-muted)"
                  font-size="10"
                  font-family="Barlow">{$tr("common.mastered")}</text
                >
              </svg>
            </div>
            <SummaryStrip items={masterySummaryItems} variant="mastery" />
          </div>

          {#if viewTab === "collection"}
            <CollapsibleSection
              title={$tr("mastery.detailedBreakdown")}
              collapsed={!$breakdownExpanded}
              onToggle={() => breakdownExpanded.update((value) => !value)}
            >
              <ThemedPanel className="grid gap-2 p-2.5">
                {#each categories as cat}
                  {@const cs = stats.byCategory[cat]}
                  {@const masteredWidth = boundedPercent(cs.mastered, cs.total)}
                  {@const progressWidth = boundedPercent(cs.inProgress, cs.total)}
                  <div class="grid items-center gap-2 grid-cols-[minmax(72px,110px)_1fr_auto]">
                    <span class="text-xs text-text-secondary">{cat}</span>
                    <svg
                      class="block h-1.5 w-full overflow-hidden rounded-full bg-surface-hover"
                      viewBox="0 0 100 1"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      <rect class="fill-success" x="0" y="0" width={masteredWidth} height="1"
                      ></rect>
                      <rect
                        class="fill-warning opacity-60"
                        x={masteredWidth}
                        y="0"
                        width={progressWidth}
                        height="1"
                      ></rect>
                    </svg>
                    <span class="whitespace-nowrap text-xs text-text-secondary"
                      >{cs.mastered}/{cs.total}
                      <small class="text-text-muted"
                        >({formatPercent(cs.mastered, cs.total)}%)</small
                      ></span
                    >
                  </div>
                {/each}
              </ThemedPanel>

              {#if completion}
                <div class="mt-3 grid gap-2 min-[900px]:grid-cols-2">
                  <ThemedPanel className="grid gap-2 p-2.5">
                    <span class="font-display text-sm font-semibold text-text-secondary"
                      >{$tr("mastery.starChart")}</span
                    >
                    {#each starChartRows as [label, pair] (label)}
                      {@const width = boundedPercent(pair.done, pair.total)}
                      <div class="grid items-center gap-2 grid-cols-[minmax(96px,130px)_1fr_auto]">
                        <span class="text-xs text-text-secondary">{label}</span>
                        <svg
                          class="block h-1.5 w-full overflow-hidden rounded-full bg-surface-hover"
                          viewBox="0 0 100 1"
                          preserveAspectRatio="none"
                          aria-hidden="true"
                        >
                          <rect class="fill-info" x="0" y="0" {width} height="1"></rect>
                        </svg>
                        <span class="whitespace-nowrap text-xs text-text-secondary"
                          >{pair.done}/{pair.total}
                          <small class="text-text-muted"
                            >({formatPercent(pair.done, pair.total)}%)</small
                          ></span
                        >
                      </div>
                    {/each}
                  </ThemedPanel>

                  <ThemedPanel className="grid content-start gap-2 p-2.5">
                    <span class="font-display text-sm font-semibold text-text-secondary"
                      >{$tr("mastery.intrinsics")}</span
                    >
                    {#each intrinsicRows as [label, pair] (label)}
                      {@const width = boundedPercent(pair.done, pair.total)}
                      <div class="grid items-center gap-2 grid-cols-[minmax(96px,130px)_1fr_auto]">
                        <span class="text-xs text-text-secondary">{label}</span>
                        <svg
                          class="block h-1.5 w-full overflow-hidden rounded-full bg-surface-hover"
                          viewBox="0 0 100 1"
                          preserveAspectRatio="none"
                          aria-hidden="true"
                        >
                          <rect class="fill-accent" x="0" y="0" {width} height="1"></rect>
                        </svg>
                        <span class="whitespace-nowrap text-xs text-text-secondary"
                          >{pair.done}/{pair.total}
                          <small class="text-text-muted"
                            >({formatPercent(pair.done, pair.total)}%)</small
                          ></span
                        >
                      </div>
                    {/each}
                  </ThemedPanel>
                </div>
              {/if}
            </CollapsibleSection>

            {#if archonSummary.stock.length > 0}
              <CollapsibleSection
                title={$tr("archon.title")}
                collapsed={!$archonExpanded}
                onToggle={() => archonExpanded.update((value) => !value)}
              >
                <ArchonShardSummary
                  summary={archonSummary}
                  frameLabel={(itemType) => frameLabel(itemType, $itemDb)}
                  onOpenFrame={openMasteryItemByUniqueName}
                />
              </CollapsibleSection>
            {/if}
          {/if}
        </div>
      {:else if sectionId === "mastery.content"}
        {#if viewTab === "roadmap"}
          <MasteryRoadmap
            roadmap={masteryRoadmap}
            totalXp={stats.profileMastery?.totalXp ?? null}
            currentRank={stats.profileMastery?.rank ?? null}
            onOpen={(item) => activeItem.set(item)}
          />
        {:else if viewTab === "planned"}
          <div data-mastery-planned-tab>
            <MasteryPlanner
              plan={masteryPlan}
              sort={$plannerSort}
              onSort={(value) => plannerSort.set(value)}
              onUnpin={(uniqueName) => toggleMasteryPin(uniqueName)}
              onOpenItem={openMasteryItemByUniqueName}
              onOpenComponent={(comp, parentName) => activeComponent.set({ comp, parentName })}
            />
          </div>
        {:else}
          <div class="view-sticky-filters grid gap-2 mb-3">
            <SharedFilterBar
              scope="mastery"
              sortOptions={MASTERY_SORT_OPTIONS}
              showVaulted
              showSubsumed
              showFoundryState
            />
            <div class="flex items-end border-b border-border-subtle">
              <HeaderTabs
                options={categoryTabs}
                activeKey={catFilter}
                onSelect={selectCategoryTab}
              />
            </div>
            {#if catFilter !== INCOMPLETE_SETS_TAB}
              <div class="flex items-end border-b border-border-subtle">
                <HeaderTabs
                  options={STATUS_TABS}
                  activeKey={statusFilter}
                  onSelect={selectStatusTab}
                />
              </div>
            {/if}
          </div>

          {#if catFilter === INCOMPLETE_SETS_TAB}
            <div class="item-grid">
              {#if incompleteSets.length === 0}
                <div class="empty-state col-span-full">
                  <p>{$tr("mastery.noSetsInProgress")}</p>
                </div>
              {:else}
                {#each incompleteSets as set (set.internalName)}
                  <div
                    class="item-card group border-info/25"
                    role="button"
                    tabindex="0"
                    aria-label={$tr("common.openDetailsFor", { name: itemLabel(set) })}
                    on:click={() => activeItem.set(set)}
                    on:keydown={(event) => {
                      if (event.key === "Enter" || event.key === " ") activeItem.set(set);
                    }}
                  >
                    <div class="item-img-wrap">
                      <ItemImage src={set.imageUrl} alt={itemLabel(set)} auditKey={set.name} />
                      {#if set.vaulted}<span class="vault-badge">V</span>{/if}
                      <span
                        class="absolute right-2 bottom-1.5 font-display text-base font-bold text-info drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
                        >{set.ownedPartTypes ?? 0}/{set.totalPartTypes ?? 0}</span
                      >
                    </div>
                    <div class="item-body">
                      <span class="item-name">{itemLabel(set)}</span>
                      <span class="item-type"
                        >{(set.missingParts ?? 0) === 1
                          ? $tr("mastery.needsOnePart", { count: set.missingParts ?? 0 })
                          : $tr("mastery.needsPartsMany", { count: set.missingParts ?? 0 })}</span
                      >
                    </div>
                  </div>
                {/each}
              {/if}
            </div>
          {:else}
            <div class="item-grid">
              {#if filtered.length === 0}
                <div class="empty-state col-span-full"><p>{$tr("mastery.noItemsMatch")}</p></div>
              {:else}
                {#each filtered as item, itemIndex (`${item.uniqueName || item.internalName || item.name}-${itemIndex}`)}
                  {@const shardCopies =
                    archonShards.bySuitType.get(item.uniqueName || item.internalName || "") ?? []}
                  {@const pinKey = pinKeyOf(item)}
                  {@const pinned = pinnedSet.has(pinKey)}
                  <div
                    class="item-card group {item.status === 'missing'
                      ? 'opacity-60'
                      : item.status === 'mastered'
                        ? 'border-success/25'
                        : item.status === 'progress'
                          ? 'border-warning/25'
                          : ''}"
                    role="button"
                    tabindex="0"
                    aria-label={$tr("common.openDetailsFor", { name: itemLabel(item) })}
                    on:click={() => activeItem.set(item)}
                    on:keydown={(event) => {
                      if (event.key === "Enter" || event.key === " ") activeItem.set(item);
                    }}
                  >
                    <div class="item-img-wrap">
                      <ItemImage src={item.imageUrl} alt={itemLabel(item)} auditKey={item.name} />
                      {#if item.vaulted}<span class="vault-badge">V</span>{/if}
                      {#if pinKey}
                        <button
                          type="button"
                          class="absolute left-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded border bg-bg-deep/35 transition-[opacity,color,border-color] duration-100 {pinned
                            ? 'border-accent-dim text-accent opacity-100'
                            : 'border-border text-text-muted opacity-0 group-hover:opacity-100'}"
                          title={pinned ? $tr("mastery.planner.unpin") : $tr("mastery.planner.pin")}
                          aria-label={pinned
                            ? $tr("mastery.planner.unpin")
                            : $tr("mastery.planner.pin")}
                          aria-pressed={pinned}
                          data-mastery-pin={pinKey}
                          on:click|stopPropagation={() =>
                            toggleMasteryPin(pinKey, masteredMasteryLabels.has(pinKey))}
                        >
                          <svg
                            viewBox="0 0 16 16"
                            fill={pinned ? "currentColor" : "none"}
                            stroke="currentColor"
                            stroke-width="1.4"
                            class="h-3.5 w-3.5"
                          >
                            <path
                              d="M9.5 1.5l5 5-2 .5-3 3 .5 2.5-5-5-2.5 4 4-2.5-5-5 2.5.5 3-3 .5-2z"
                            />
                          </svg>
                        </button>
                      {/if}
                      {#if shardCopies.length > 0}
                        <span
                          class="absolute left-1.5 bottom-1.5 flex flex-col items-start gap-0.5"
                        >
                          {#each shardCopies as copy, copyIndex (copy.instanceId ?? copyIndex)}
                            <ArchonShardPips
                              slots={copy.slots}
                              title={copy.filled === 1
                                ? $tr("archon.shardCountOne", { count: copy.filled })
                                : $tr("archon.shardCount", { count: copy.filled })}
                            />
                          {/each}
                        </span>
                      {/if}
                      <span
                        class="absolute right-1.5 bottom-1.5 w-1.5 h-1.5 rounded-full shadow-[0_0_0_2px_rgba(0,0,0,0.38)] {item.status ===
                        'mastered'
                          ? 'bg-success'
                          : item.status === 'progress'
                            ? 'bg-warning'
                            : 'bg-danger opacity-70'}"
                      ></span>
                    </div>
                    <div class="item-body">
                      <span class="item-name">{itemLabel(item)}</span>
                      <span class="item-type"
                        >{item.category}{item.masteryReq ? ` · MR ${item.masteryReq}` : ""}</span
                      >
                      {#if item.foundryStatus || item.subsumed || item.masteryXpRemaining > 0 || item.platinum != null}
                        <div class="mt-1 flex flex-wrap gap-1">
                          {#if item.masteryXpRemaining > 0}
                            <span class="mastery-badge xp" title={$tr("mastery.xpBadgeTitle")}
                              >+{item.masteryXpRemaining.toLocaleString($locale)} XP</span
                            >
                          {/if}
                          {#if item.platinum != null}
                            <span class="mastery-badge plat" title={$tr("mastery.priceBadgeTitle")}
                              >{item.platinum}p</span
                            >
                          {/if}
                          {#if item.foundryStatus === "in-progress"}
                            <span class="mastery-badge building"
                              >{$tr("mastery.badgeCrafting")}</span
                            >
                          {:else if item.foundryStatus === "claimable"}
                            <span class="mastery-badge ready">{$tr("common.ready")}</span>
                          {/if}
                          {#if item.subsumed}<span class="mastery-badge subsumed"
                              >{$tr("common.subsumed")}</span
                            >{/if}
                        </div>
                      {/if}
                      {#if !item.missing}
                        {@const rankWidth =
                          item.maxRank > 0
                            ? Math.max(0, Math.min(100, (item.rank / item.maxRank) * 100))
                            : 0}
                        <div class="item-rank-bar">
                          <svg
                            class="rank-bar-svg"
                            viewBox="0 0 100 4"
                            preserveAspectRatio="none"
                            aria-hidden="true"
                          >
                            <rect
                              class="rank-fill-svg"
                              class:max={item.mastered}
                              class:partial={!item.mastered}
                              x="0"
                              y="0"
                              width={rankWidth}
                              height="4"
                              rx="2"
                              ry="2"
                            ></rect>
                          </svg>
                        </div>
                        <span class="item-rank-text"
                          >{$tr("mastery.rankLine", {
                            rank: item.rank,
                            maxRank: item.maxRank,
                            pct: item.nextPct,
                          })}</span
                        >
                      {:else}
                        <span class="text-xs text-text-muted">{$tr("mastery.notOwned")}</span>
                      {/if}
                      {#if (item.components || []).length > 0}
                        <div class="mt-1.5 flex flex-wrap gap-1">
                          {#each (item.components || []).slice(0, 8) as comp, compIndex (`${comp.uniqueName || comp.name || "component"}-${compIndex}`)}
                            {@const isOwned =
                              comp.owned || (comp.ownedCount ?? 0) >= (comp.itemCount || 1)}
                            {@const compState = comp.building
                              ? "building"
                              : isOwned
                                ? "owned"
                                : "missing"}
                            <button
                              type="button"
                              class="comp-dot h-1.5 w-1.5 rounded-full border border-transparent {compState}"
                              title="{itemLabel(comp) || '?'}: {$tr(
                                componentStateLabelKey(compState),
                              )}"
                              aria-label={$tr("mastery.openComponentDetailsAria", {
                                name: itemLabel(comp) || $tr("mastery.componentFallback"),
                              })}
                              on:click|stopPropagation={() =>
                                activeComponent.set({ comp, parentName: item.name })}
                            ></button>
                          {/each}
                        </div>
                      {/if}
                      {#if item.wfm}
                        <button
                          type="button"
                          class="wfm-link absolute top-1.5 right-1.5 inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-bg-deep/25 text-text-muted opacity-0 transition-[opacity,color,border-color] duration-100 group-hover:opacity-100 hover:text-accent hover:border-accent-dim"
                          title={$tr("mastery.viewOnWfmTitle")}
                          aria-label={$tr("mastery.viewOnWfmAria", { name: item.name })}
                          on:click|stopPropagation={() =>
                            send(
                              "open-external",
                              `https://warframe.market/items/${item.wfm.url_name}`,
                            )}
                        >
                          <svg
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.5"
                            class="h-3.5 w-3.5"
                          >
                            <path d="M6 3H3v10h10v-3" />
                            <path d="M9 2h5v5" />
                            <path d="M14 2L7 9" />
                          </svg>
                        </button>
                      {/if}
                    </div>
                  </div>
                {/each}
              {/if}
            </div>
          {/if}
        {/if}
      {/if}
    </LayoutGrid>
  {:else}
    <div class="empty-state">
      <p>{$tr("mastery.loadingData")}</p>
    </div>
  {/if}
</section>

<style>
  .ring-caption {
    text-transform: uppercase;
  }

  .comp-dot.owned {
    background: color-mix(in oklab, var(--success) 65%, transparent);
    border-color: color-mix(in oklab, var(--success) 60%, transparent);
  }
  .comp-dot.missing {
    background: color-mix(in oklab, var(--danger) 65%, transparent);
    border-color: color-mix(in oklab, var(--danger) 60%, transparent);
  }
  /* Amber so a building part reads apart from owned (green) and missing (red). */
  .comp-dot.building {
    background: color-mix(in oklab, var(--warning) 70%, transparent);
    border-color: color-mix(in oklab, var(--warning) 65%, transparent);
  }

  .mastery-badge {
    display: inline-flex;
    align-items: center;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    padding: 0.02rem 0.3rem;
    font-family: var(--font-display);
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    line-height: 1.3;
  }
  .mastery-badge.building {
    color: color-mix(in oklab, var(--warning) 86%, white);
    border-color: color-mix(in oklab, var(--warning) 40%, transparent);
    background: color-mix(in oklab, var(--warning) 14%, transparent);
  }
  .mastery-badge.ready {
    color: color-mix(in oklab, var(--success) 86%, white);
    border-color: color-mix(in oklab, var(--success) 40%, transparent);
    background: color-mix(in oklab, var(--success) 14%, transparent);
  }
  .mastery-badge.subsumed {
    color: color-mix(in oklab, var(--info) 86%, white);
    border-color: color-mix(in oklab, var(--info) 42%, transparent);
    background: color-mix(in oklab, var(--info) 14%, transparent);
  }
  .mastery-badge.xp {
    color: color-mix(in oklab, var(--accent) 86%, white);
    border-color: color-mix(in oklab, var(--accent) 42%, transparent);
    background: color-mix(in oklab, var(--accent) 14%, transparent);
  }
  .mastery-badge.plat {
    color: color-mix(in oklab, var(--info) 90%, white);
    border-color: color-mix(in oklab, var(--info) 34%, transparent);
    background: color-mix(in oklab, var(--info) 10%, transparent);
  }
</style>
