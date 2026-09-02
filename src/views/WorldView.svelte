<script context="module" lang="ts">
  import { registerSections } from "../lib/layout/registry.js";

  const WORLD_MAIN_SECTIONS = [
    "world.cycles",
    "world.timers",
    "world.resurgence",
    "world.circuit",
    "world.steelPath",
    "world.fissures",
    "world.fissureAlerts",
    "world.invasions",
    "world.darvo",
    "world.baro",
    "world.bounties",
  ];
  const WORLD_ARBI_SECTIONS = ["world.arbiSchedule"];
  const WORLD_DAILIES_SECTIONS = ["world.dailies"];

  // Order is the default column split: the first half fills the wide left column,
  // which is why Darvo sits after Invasions rather than where its markup lives.
  registerSections("world", [
    {
      id: "world.cycles",
      view: "world",
      labelKey: "world.planetCycles",
      defaultSpan: 1,
      canPopout: true,
    },
    { id: "world.timers", view: "world", labelKey: "world.resetTimers", defaultSpan: 1 },
    { id: "world.resurgence", view: "world", labelKey: "world.primeResurgence", defaultSpan: 1 },
    { id: "world.circuit", view: "world", labelKey: "world.theCircuit", defaultSpan: 1 },
    {
      id: "world.steelPath",
      view: "world",
      labelKey: "world.steelPathHonorsReset",
      defaultSpan: 1,
    },
    {
      id: "world.fissures",
      view: "world",
      labelKey: "world.voidFissures",
      defaultSpan: 1,
      canPopout: true,
    },
    {
      id: "world.fissureAlerts",
      view: "world",
      labelKey: "common.alerts",
      defaultSpan: 1,
      canPopout: true,
    },
    {
      id: "world.invasions",
      view: "world",
      labelKey: "world.invasions",
      defaultSpan: 1,
      canPopout: true,
    },
    { id: "world.darvo", view: "world", labelKey: "world.darvosDeal", defaultSpan: 1 },
    {
      id: "world.baro",
      view: "world",
      labelKey: "world.baroKiteer",
      defaultSpan: "full",
      canPopout: true,
    },
    { id: "world.bounties", view: "world", labelKey: "world.bounties", defaultSpan: "full" },
    {
      id: "world.arbiSchedule",
      view: "world",
      labelKey: "common.arbitrations",
      defaultSpan: "full",
      minSpan: "full",
      canHide: false,
      canPopout: true,
    },
    {
      id: "world.dailies",
      view: "world",
      labelKey: "dailies.tab",
      defaultSpan: "full",
      minSpan: "full",
      canHide: false,
      canPopout: true,
    },
  ]);
</script>

<script lang="ts">
  import { itemLabel } from "../lib/itemLabel.js";
  import { onMount } from "svelte";
  import EditLayoutBar from "../components/layout/EditLayoutBar.svelte";
  import LayoutGrid from "../components/layout/LayoutGrid.svelte";
  import { worldData, worldLoading, worldFissureMode } from "../stores/world.js";
  import { inventoryData, itemDb, componentOwnership, wfmItems } from "../stores/data.js";
  import {
    buildBountyGroups,
    buildBountyTimers,
    buildCycleRows,
    buildFissureRows,
    buildWorldTimes,
    buildResetUrgency,
    COARSE_CLOCK_MS,
    FISSURE_MODE_OPTIONS,
    loadCollapsedSections,
    mountWorldView,
    setCycleAlertMinutes,
    toggleCollapsedSection,
    toggleCycleAlert,
  } from "../lib/world/useWorldView.js";
  import { titleCase } from "../../config/shared/textNormalize.js";
  import { activeWindow, parseIsoDate, timeTo } from "../lib/format.js";
  import {
    CIRCUIT_HARD_ROTATION,
    CIRCUIT_NORMAL_ROTATION,
    RELIC_ICON_PATHS,
    buildFeaturedPrimes,
    buildBaroOwnedSet,
    circuitRotationIndex,
    resolveCircuitChoices,
    resolveCircuitRotation,
    type CircuitChoice,
  } from "../lib/world.js";
  import type { ItemDbEntry, RawInventoryData } from "../types/inventory.js";
  import { overlaySettings } from "../stores/overlaySettings.js";
  import { isPopoutWindow } from "../stores/popout.js";
  import { invoke } from "../lib/ipc.js";
  import { log } from "../lib/log.js";
  import { activeItem, activeRelic } from "../stores/modals.js";
  import { relicDb } from "../stores/relics.js";
  import { relicGroupForUniqueName } from "../lib/relic.js";
  import type { Invasion, SteelPathHonors } from "../types/world.js";
  import FissureAlerts from "../components/settings/FissureAlerts.svelte";
  import CollapsibleSection from "../components/CollapsibleSection.svelte";
  import HeaderTabs from "../components/HeaderTabs.svelte";
  import ArbiSchedule from "../components/world/ArbiSchedule.svelte";
  import DailiesTracker from "../components/world/DailiesTracker.svelte";
  import { tr, type Translator } from "../lib/i18n.js";
  import InvasionItem from "../components/world/InvasionItem.svelte";
  import BaroInventoryCard from "../components/world/BaroInventoryCard.svelte";
  import CycleRow from "../components/world/CycleRow.svelte";
  import IconButtonCard from "../components/world/IconButtonCard.svelte";
  import WorldToggleIcon from "../components/world/WorldToggleIcon.svelte";
  import SegmentedControl from "../components/SegmentedControl.svelte";
  import {
    getBountyRewards,
    resolveRewardIcon,
    resolveRewardUniqueName,
  } from "../lib/bountyRewards.js";
  import { buildParsedItemFromDb } from "../lib/parsedItemFromDb.js";
  import { clockStore } from "../lib/timers.js";

  let collapsed: Record<string, boolean> = loadCollapsedSections();
  function toggleSection(key: string) {
    collapsed = toggleCollapsedSection(collapsed, key);
  }

  async function openInWindow(): Promise<void> {
    try {
      await invoke("popoutOpen", "world");
    } catch (err) {
      log.warn("[Popout] open world failed:", err);
    }
  }

  // Sub-tab (world overview, arbitration schedule, dailies) - persisted to localStorage
  const WORLD_TABS = ["world", "arbis", "dailies"] as const;
  type WorldTab = (typeof WORLD_TABS)[number];
  const asWorldTab = (key: string | null): WorldTab =>
    WORLD_TABS.includes(key as WorldTab) ? (key as WorldTab) : "world";

  let worldTab: WorldTab = asWorldTab(localStorage.getItem("world-tab"));
  function setWorldTab(key: string) {
    worldTab = asWorldTab(key);
    try {
      localStorage.setItem("world-tab", worldTab);
    } catch {
      // tab pref is best-effort
    }
  }
  $: worldTabOptions = [
    { key: "world", label: $tr("common.world") },
    { key: "arbis", label: $tr("common.arbitrations") },
    { key: "dailies", label: $tr("dailies.tab") },
  ];

  const nowClock = clockStore(1000);
  const coarseClock = clockStore(COARSE_CLOCK_MS);
  $: nowMs = $nowClock;
  $: nowCoarseMs = $coarseClock;

  onMount(mountWorldView);

  function openItemDetail(
    uniqueName: string,
    extraDrops?: import("../types/inventory.js").DropInfo[],
  ) {
    if (!uniqueName) return;
    // Relic tiles (Varzia's aged relics included) get the reward breakdown
    // modal, not the generic item card.
    const relicGroup = relicGroupForUniqueName($relicDb, uniqueName);
    if (relicGroup) {
      activeRelic.set(relicGroup);
      return;
    }
    const db = $itemDb[uniqueName];
    if (!db) return;

    activeItem.set(
      buildParsedItemFromDb(uniqueName, db, $componentOwnership, extraDrops ? { extraDrops } : {}),
    );
  }

  $: wd = $worldData;

  $: varzia = wd?.vaultTrader || null;
  $: baro = wd?.voidTrader || null;
  $: darvoDeals = wd?.dailyDeals || [];
  $: earth = wd?.earthCycle || {};
  $: cetus = wd?.cetusCycle || {};
  $: vallis = wd?.vallisCycle || {};
  $: cambion = wd?.cambionCycle || {};
  $: duviri = wd?.duviriCycle || {};
  $: sortie = wd?.sortie || {};
  $: steelPath = wd?.steelPath || null;

  $: varziaActive = activeWindow(varzia?.activation, varzia?.expiry, nowCoarseMs);

  $: baroAct = parseIsoDate(baro?.activation);
  $: baroActive = activeWindow(baro?.activation, baro?.expiry, nowCoarseMs);

  $: featuredPrimes = wd ? buildFeaturedPrimes(varzia, $inventoryData, $itemDb) : [];

  $: duviriState = (duviri.state || "unknown").toString();
  $: duviriNormal = (duviri.choices || []).find((c) => c.category === "normal")?.choices || [];
  $: duviriHard = (duviri.choices || []).find((c) => c.category === "hard")?.choices || [];
  $: circuitNormalItems = resolveCircuitChoices(duviriNormal, $itemDb, $inventoryData);
  $: circuitHardItems = resolveCircuitChoices(duviriHard, $itemDb, $inventoryData);

  let circuitFullView = false;
  $: circuitNormalIdx = circuitRotationIndex(CIRCUIT_NORMAL_ROTATION, duviriNormal);
  $: circuitHardIdx = circuitRotationIndex(CIRCUIT_HARD_ROTATION, duviriHard);
  $: circuitCanExpand = circuitNormalIdx >= 0 || circuitHardIdx >= 0;

  function buildFullWeeks(
    rotation: string[][],
    idx: number,
    db: Record<string, ItemDbEntry>,
    inv: RawInventoryData | null,
    t: Translator,
  ): Array<{ label: string; current: boolean; items: CircuitChoice[] }> {
    if (idx < 0) return [];
    const ordered = [...rotation.slice(idx), ...rotation.slice(0, idx)];
    return resolveCircuitRotation(ordered, db, inv).map((items, i) => ({
      label:
        i === 0
          ? t("world.thisWeek")
          : i === 1
            ? t("world.nextWeek")
            : t("world.inWeeks", { n: i }),
      current: i === 0,
      items,
    }));
  }

  $: circuitNormalFull = circuitFullView
    ? buildFullWeeks(CIRCUIT_NORMAL_ROTATION, circuitNormalIdx, $itemDb, $inventoryData, $tr)
    : [];
  $: circuitHardFull = circuitFullView
    ? buildFullWeeks(CIRCUIT_HARD_ROTATION, circuitHardIdx, $itemDb, $inventoryData, $tr)
    : [];

  // Recompute all countdowns from a single clock source.
  // This keeps seconds moving while staying on the World tab.
  $: times = buildWorldTimes({
    baro,
    baroActive,
    varzia,
    varziaActive,
    sortie,
    steelPath,
    duviri,
    earth,
    cetus,
    vallis,
    cambion,
    nowMs,
  });

  $: fissureFlat = buildFissureRows(wd?.fissures, $worldFissureMode, nowMs, nowCoarseMs);
  $: fissureModeOptions = FISSURE_MODE_OPTIONS.map((o) => ({
    value: o.value,
    label: $tr(o.labelKey),
  }));
  $: fissureModeLabel =
    fissureModeOptions.find((o) => o.value === $worldFissureMode)?.label ?? $tr("common.normal");

  $: cycleRows = buildCycleRows({
    earth,
    cetus,
    vallis,
    cambion,
    duviri,
    duviriState,
    times,
    nowCoarseMs,
    t: $tr,
  });

  // Invasions from raw DE world state (or warframestat fallback)
  $: invasions = ((wd?.invasions || []) as Invasion[]).filter((inv) => !inv.completed);

  // Current bounty rotation (A/B/C) from oracle bounty-cycle
  $: bountyRotation = (wd?.bountyRotation as string | undefined) || undefined;

  // warframestat.us sometimes omits currentReward even when the wrapper exists.
  function hasSteelPathReward(value: unknown): value is SteelPathHonors {
    return (
      !!value &&
      typeof value === "object" &&
      typeof (value as { currentReward?: unknown }).currentReward === "object"
    );
  }
  $: steelPathHonors = hasSteelPathReward(wd?.steelPath) ? wd.steelPath : null;

  $: bounties = buildBountyGroups(wd?.bounties);
  $: bountyColumns = [
    bounties.filter((_, index) => index % 2 === 0),
    bounties.filter((_, index) => index % 2 === 1),
  ];

  $: resetUrgency = buildResetUrgency(sortie, steelPath, nowCoarseMs);

  $: bountyTimers = buildBountyTimers(bounties, nowMs, nowCoarseMs);

  // Baro relay location for countdown display
  $: baroLocation = typeof baro?.location === "string" && baro.location ? baro.location : null;

  // Baro ownership set - covers mods, weapons, relics, cosmetics
  $: baroOwnedSet = buildBaroOwnedSet($inventoryData);

  function daysUntilLabel(iso: string | undefined, now: number, t: Translator): string {
    const ms = iso ? Date.parse(iso) - now : Number.NaN;
    if (!Number.isFinite(ms)) return t("world.soon");
    const days = Math.max(1, Math.ceil(ms / 86_400_000));
    return days === 1 ? t("world.inDaySingular", { days }) : t("world.inDaysPlural", { days });
  }

  $: steelPathUpcoming = (steelPathHonors?.upcoming ?? []).map((reward) => ({
    reward,
    daysLabel: daysUntilLabel(reward.activation, nowCoarseMs, $tr),
  }));

  // Most world blocks only exist when the world state carries them; an absent
  // one must not reserve an empty grid slot.
  $: baroPresent = baroActive
    ? !!baro?.inventory && baro.inventory.length > 0
    : Boolean(baroAct) && !baroActive;
  $: worldSectionScope =
    worldTab === "arbis"
      ? WORLD_ARBI_SECTIONS
      : worldTab === "dailies"
        ? WORLD_DAILIES_SECTIONS
        : WORLD_MAIN_SECTIONS;
  $: availableWorldSections = [
    "world.cycles",
    "world.timers",
    "world.resurgence",
    "world.circuit",
    ...(steelPathHonors ? ["world.steelPath"] : []),
    "world.fissures",
    "world.fissureAlerts",
    ...(invasions.length > 0 ? ["world.invasions"] : []),
    ...(darvoDeals.length > 0 ? ["world.darvo"] : []),
    ...(baroPresent ? ["world.baro"] : []),
    ...(bounties.length > 0 ? ["world.bounties"] : []),
  ];
</script>

<section class="view active">
  <div class="mb-4">
    <div class="mb-2 flex items-center justify-between gap-3">
      <h2 class="m-0 font-display text-3xl font-semibold tracking-[0.03em] text-text-primary">
        {$tr("common.world")}
      </h2>
      {#if !isPopoutWindow}
        <button
          type="button"
          data-popout-open
          aria-label={$tr("common.openInWindow")}
          title={$tr("common.openInWindow")}
          class="flex shrink-0 cursor-pointer items-center justify-center rounded border border-border bg-bg-raised/60 p-1.5 text-text-secondary transition-[border-color,color] duration-150 hover:border-border-strong hover:text-text-primary"
          on:click={openInWindow}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M9.5 2.5h4v4" />
            <path d="M13.5 2.5 8 8" />
            <path d="M12.5 9.5V13H3V3.5h3.5" />
          </svg>
        </button>
      {/if}
      <EditLayoutBar view="world" only={worldSectionScope} />
    </div>
    <div class="flex items-end border-b border-border-subtle">
      <HeaderTabs options={worldTabOptions} activeKey={worldTab} onSelect={setWorldTab} />
      {#if worldTab === "world" && (baroActive || baroAct)}
        <div class="ml-auto flex items-center pb-2 shrink-0">
          {#if baroActive}
            <span
              class="rounded border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-warning"
              >{$tr("world.baroLeavesIn", { baro: times.baro })}{#if baroLocation}
                - {baroLocation}{/if}</span
            >
          {:else}
            <span
              class="rounded border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-warning"
              >{$tr("world.baroArrivesIn", { baro: times.baro })}{#if baroLocation}
                - {baroLocation}{/if}</span
            >
          {/if}
        </div>
      {/if}
    </div>
  </div>

  {#if worldTab === "arbis"}
    <LayoutGrid view="world" only={WORLD_ARBI_SECTIONS} gapClass="gap-0" let:sectionId>
      {#if sectionId === "world.arbiSchedule"}
        <ArbiSchedule />
      {/if}
    </LayoutGrid>
  {:else if worldTab === "dailies"}
    <LayoutGrid view="world" only={WORLD_DAILIES_SECTIONS} gapClass="gap-0" let:sectionId>
      {#if sectionId === "world.dailies"}
        <DailiesTracker />
      {/if}
    </LayoutGrid>
  {:else if !wd && $worldLoading}
    <div class="empty-state"><p>{$tr("world.loading")}</p></div>
  {:else if !wd}
    <div class="empty-state"><p>{$tr("world.unavailable")}</p></div>
  {:else}
    <LayoutGrid
      view="world"
      only={WORLD_MAIN_SECTIONS}
      available={availableWorldSections}
      wideTemplate="minmax(0, 1.2fr) minmax(0, 1fr)"
      gapClass="gap-x-6"
      className="world-layout"
      let:sectionId
    >
      {#if sectionId === "world.cycles"}
        <!-- PLANET CYCLES -->
        <div class="world-section">
          <CollapsibleSection
            title={$tr("world.planetCycles")}
            collapsed={collapsed.cycles}
            onToggle={() => toggleSection("cycles")}
          >
            {#if cycleRows.length > 0}
              <div class="grid grid-cols-2 gap-x-5">
                {#each cycleRows as row}
                  {@const isAlertable =
                    row.key === "earth" ||
                    row.key === "cetus" ||
                    row.key === "vallis" ||
                    row.key === "cambion" ||
                    row.key === "duviri"}
                  {@const alertOn = isAlertable && !!$overlaySettings.cycleAlerts?.[row.key]}
                  <CycleRow
                    name={titleCase(row.key)}
                    iconSrc={row.src}
                    stateLabel={row.stateLabel}
                    stateClass={row.stateClass}
                    nextLabel={row.nextLabel}
                    time={row.time}
                    urgent={row.urgent}
                    alertKey={isAlertable ? row.key : null}
                    {alertOn}
                    onToggleAlert={toggleCycleAlert}
                  />
                {/each}
              </div>
              <div class="mt-0.5 flex items-center gap-2 pt-1.5 text-xs text-text-secondary">
                <span>{$tr("world.notifyBeforeCycleChange")}</span>
                <span class="flex items-center gap-1">
                  <input
                    type="number"
                    class="cycle-lead-input w-10 rounded-[var(--radius-md)] border border-border bg-surface-input px-1 py-0.5 text-center text-xs text-text-primary outline-none"
                    min="0"
                    max="120"
                    value={$overlaySettings.cycleAlertMinutesBefore ?? 3}
                    on:change={(e) => setCycleAlertMinutes(Number(e.currentTarget.value))}
                  />
                  <span>{$tr("world.min")}</span>
                </span>
              </div>
            {:else}
              <span class="text-sm text-text-secondary opacity-70"
                >{$tr("world.cycleDataUnavailable")}</span
              >
            {/if}
          </CollapsibleSection>
        </div>
      {:else if sectionId === "world.timers"}
        <!-- RESET TIMERS -->
        <div class="world-section">
          <CollapsibleSection
            title={$tr("world.resetTimers")}
            collapsed={collapsed.timers}
            onToggle={() => toggleSection("timers")}
          >
            <div class="world-row">
              <span class="text-sm text-text-secondary">{$tr("world.dailySortie")}</span><span
                class="font-display text-sm tracking-[0.02em] whitespace-nowrap text-text-primary"
                class:world-timer-urgent={resetUrgency.sortie}>{times.sortie}</span
              >
            </div>
            <div class="world-row">
              <span class="text-sm text-text-secondary">{$tr("world.dailyReset")}</span><span
                class="font-display text-sm tracking-[0.02em] whitespace-nowrap text-text-primary"
                class:world-timer-urgent={resetUrgency.daily}>{times.daily}</span
              >
            </div>
            <div class="world-row">
              <span class="text-sm text-text-secondary">{$tr("world.weeklyResets")}</span><span
                class="font-display text-sm tracking-[0.02em] whitespace-nowrap text-text-primary"
                class:world-timer-urgent={resetUrgency.weekly}>{times.weekly}</span
              >
            </div>
            <div class="world-row">
              <span class="text-sm text-text-secondary">{$tr("world.steelPathHonorsReset")}</span
              ><span
                class="font-display text-sm tracking-[0.02em] whitespace-nowrap text-text-primary"
                class:world-timer-urgent={resetUrgency.steelPath}>{times.steelPath}</span
              >
            </div>
          </CollapsibleSection>
        </div>
      {:else if sectionId === "world.resurgence"}
        <!-- PRIME RESURGENCE -->
        <div class="world-section">
          <CollapsibleSection
            title={$tr("world.primeResurgence")}
            collapsed={collapsed.resurgence}
            onToggle={() => toggleSection("resurgence")}
          >
            <div class="text-sm text-text-secondary mb-2">
              {$tr("world.rotationEndsIn")} <strong>{times.varzia}</strong>
            </div>
            {#if featuredPrimes.length > 0}
              <div class="-m-1 flex gap-2.5 overflow-x-auto p-2">
                {#each featuredPrimes as p}
                  <IconButtonCard
                    name={itemLabel(p)}
                    imageUrl={p.imageUrl}
                    owned={p.owned}
                    subsumed={p.subsumed}
                    onClick={() => openItemDetail(p.uniqueName)}
                    size={100}
                    hoverScale={105}
                    borderWidth="2"
                  />
                {/each}
              </div>
            {:else}
              <span class="text-sm text-text-secondary opacity-70"
                >{$tr("world.noFeaturedPrimes")}</span
              >
            {/if}
          </CollapsibleSection>
        </div>
      {:else if sectionId === "world.circuit"}
        <!-- THE CIRCUIT -->
        <div class="world-section">
          <CollapsibleSection
            title={$tr("world.theCircuit")}
            collapsed={collapsed.circuit}
            onToggle={() => toggleSection("circuit")}
          >
            <svelte:fragment slot="actions">
              {#if circuitCanExpand && !collapsed.circuit}
                <button
                  class="btn-secondary btn-sm"
                  on:click={() => (circuitFullView = !circuitFullView)}
                >
                  {circuitFullView ? $tr("world.showCurrent") : $tr("world.showFullRotation")}
                </button>
              {/if}
            </svelte:fragment>
            {#each [{ label: $tr("world.normalRotation"), items: circuitNormalItems, weeks: circuitNormalFull, isSteelPath: false }, { label: $tr("world.steelPathRotation"), items: circuitHardItems, weeks: circuitHardFull, isSteelPath: true }] as rot}
              <div
                class="mb-1 text-xs font-bold uppercase tracking-[0.06em] {rot.isSteelPath
                  ? 'text-warning'
                  : 'text-text-secondary'}"
              >
                {rot.label}
              </div>
              {#if circuitFullView && rot.weeks.length > 0}
                <div class="-mx-1.5 -mt-1 mb-1 flex gap-2.5 overflow-x-auto p-2">
                  {#each rot.weeks as week}
                    <div
                      class="flex shrink-0 flex-col gap-1.5 rounded-[var(--radius-md)] border p-2 {week.current
                        ? 'border-warning/60 bg-warning/5'
                        : 'border-border/60'}"
                    >
                      <span
                        class="text-[11px] font-semibold uppercase tracking-wide {week.current
                          ? 'text-warning'
                          : 'text-text-muted'}">{week.label}</span
                      >
                      <div class="flex gap-2">
                        {#each week.items as item}
                          <IconButtonCard
                            name={itemLabel(item)}
                            imageUrl={item.imageUrl}
                            owned={item.owned}
                            subsumed={item.subsumed}
                            onClick={() => openItemDetail(item.uniqueName)}
                            size={80}
                            hoverScale={108}
                            borderWidth="1.5"
                          />
                        {/each}
                      </div>
                    </div>
                  {/each}
                </div>
              {:else}
                <div class="-mx-1.5 -mt-1 mb-1 flex gap-2 overflow-x-auto p-2">
                  {#each rot.items as item}
                    <IconButtonCard
                      name={itemLabel(item)}
                      imageUrl={item.imageUrl}
                      owned={item.owned}
                      subsumed={item.subsumed}
                      onClick={() => openItemDetail(item.uniqueName)}
                      size={80}
                      hoverScale={108}
                      borderWidth="1.5"
                    />
                  {:else}
                    <span class="text-sm text-text-secondary opacity-70">{$tr("world.noData")}</span
                    >
                  {/each}
                </div>
              {/if}
            {/each}
          </CollapsibleSection>
        </div>
      {:else if sectionId === "world.steelPath"}
        <!-- STEEL PATH HONORS -->
        {#if steelPathHonors}
          <div class="world-section">
            <CollapsibleSection
              title={$tr("world.steelPathHonorsReset")}
              collapsed={collapsed.steelpath}
              onToggle={() => toggleSection("steelpath")}
            >
              <svelte:fragment slot="actions">
                <span
                  class="font-display text-sm tracking-[0.02em] whitespace-nowrap text-text-primary"
                  >{times.steelPath}</span
                >
              </svelte:fragment>
              <div class="flex items-center gap-2 py-1.5">
                <span
                  class="text-xs font-bold text-text-secondary uppercase tracking-[0.06em] shrink-0"
                  >{$tr("world.thisWeek")}</span
                >
                <span class="text-sm font-semibold text-warning flex-1 min-w-0"
                  >{steelPathHonors.currentReward.name}</span
                >
                <span class="text-xs text-text-secondary whitespace-nowrap shrink-0"
                  >{$tr("world.steelEssenceCost", {
                    cost: steelPathHonors.currentReward.cost,
                  })}</span
                >
              </div>
              {#each steelPathUpcoming as row}
                <div class="flex items-center gap-2 py-0.5">
                  <span class="text-sm text-text-secondary shrink-0">{row.daysLabel}:</span>
                  <span class="text-sm text-text-primary flex-1 min-w-0">{row.reward.name}</span>
                  <span class="text-xs text-text-secondary whitespace-nowrap shrink-0"
                    >{$tr("world.steelEssenceCost", { cost: row.reward.cost })}</span
                  >
                </div>
              {/each}
            </CollapsibleSection>
          </div>
        {/if}
      {:else if sectionId === "world.darvo"}
        <!-- DARVO'S DEAL -->
        {#if darvoDeals.length > 0}
          <div class="world-section">
            <CollapsibleSection
              title={$tr("world.darvosDeal")}
              collapsed={collapsed.darvo}
              onToggle={() => toggleSection("darvo")}
            >
              {#each darvoDeals as deal (deal.uniqueName)}
                {@const dealDb = $itemDb[deal.uniqueName || ""]}
                {@const dealImg =
                  dealDb?.imageUrl ||
                  (typeof deal.imageOverride === "string" ? deal.imageOverride : null)}
                <div class="flex items-center gap-3 px-1 py-1.5">
                  <button
                    type="button"
                    class="flex h-[64px] w-[64px] shrink-0 items-center justify-center overflow-hidden
                           rounded-[var(--radius-lg)] border-2 border-border bg-surface-card p-0
                           transition-transform duration-100 disabled:cursor-default
                           {dealDb ? 'cursor-pointer hover:scale-105' : ''}"
                    disabled={!dealDb}
                    on:click={() => dealDb && openItemDetail(deal.uniqueName || "")}
                    title={deal.item || $tr("common.unknown")}
                  >
                    {#if dealImg}
                      <img
                        class="h-full w-full object-contain"
                        src={dealImg}
                        alt={deal.item || ""}
                        loading="lazy"
                      />
                    {:else}
                      <span class="text-2xl font-bold text-text-secondary opacity-40"
                        >{(deal.item || "?")[0]}</span
                      >
                    {/if}
                  </button>
                  <div class="flex min-w-0 flex-col gap-0.5">
                    <span class="truncate text-sm font-semibold text-text-primary"
                      >{deal.item || $tr("common.unknown")}</span
                    >
                    <span class="text-xs text-text-secondary">
                      <strong class="text-accent">{deal.salePrice}p</strong>
                      <span class="mx-1 line-through opacity-60">{deal.originalPrice}p</span>
                      <span
                        class="rounded border border-success/30 bg-success/10 px-1 py-px font-semibold text-success"
                        >-{deal.discount}%</span
                      >
                    </span>
                    <span class="text-xs text-text-muted">
                      <!-- No counts means no sales data; "0/0 sold" would read as a real figure. -->
                      {#if deal.sold != null && deal.total != null}{$tr("world.soldOfTotal", {
                          sold: deal.sold,
                          total: deal.total,
                        })}{/if}
                      {#if deal.expiry}{$tr("world.endsIn", {
                          time: timeTo(parseIsoDate(deal.expiry), nowCoarseMs),
                        })}{/if}
                    </span>
                  </div>
                </div>
              {/each}
            </CollapsibleSection>
          </div>
        {/if}
      {:else if sectionId === "world.fissures"}
        <!-- VOID FISSURES -->
        <div class="world-section border-t-0">
          <CollapsibleSection
            title={$tr("world.voidFissures")}
            collapsed={collapsed.fissures}
            onToggle={() => toggleSection("fissures")}
          >
            <svelte:fragment slot="actions">
              <SegmentedControl
                value={$worldFissureMode}
                options={fissureModeOptions}
                onChange={(mode) => worldFissureMode.set(mode)}
              />
            </svelte:fragment>
            <div class="flex flex-col">
              {#if fissureFlat.length === 0}
                <span class="text-sm text-text-secondary opacity-70"
                  >{$worldFissureMode === "all"
                    ? $tr("world.noFissuresAny")
                    : $tr("world.noActiveFissures", { mode: fissureModeLabel })}</span
                >
              {:else}
                {#each fissureFlat as f}
                  <div class="fissure-row">
                    <span
                      class="inline-flex min-w-20 items-center gap-1 rounded-[var(--radius-md)] px-2 py-0.5 text-xs font-bold uppercase tracking-[0.06em]"
                      class:world-badge-lith={f.tierCls === "lith"}
                      class:world-badge-meso={f.tierCls === "meso"}
                      class:world-badge-neo={f.tierCls === "neo"}
                      class:world-badge-axi={f.tierCls === "axi"}
                      class:world-badge-requiem={f.tierCls === "requiem"}
                      class:world-badge-omnia={f.tierCls === "omnia"}
                    >
                      <img
                        class="h-3.5 w-3.5 shrink-0"
                        src={RELIC_ICON_PATHS[f.tierCls] || RELIC_ICON_PATHS.default}
                        alt=""
                      />
                      {f.tier}
                    </span>
                    <span class="min-w-0 flex-1 text-sm">
                      <strong class="text-text-primary"
                        >{f.missionType || $tr("common.mission")}</strong
                      >
                      <!-- The chip only disambiguates mixed lists: Railjack and "all". -->
                      {#if f.isHard && (f.sourceMode === "railjack" || $worldFissureMode === "all")}
                        <span
                          class="ml-1.5 rounded-sm bg-warning/20 px-1 py-0.5 text-[0.625rem] font-bold uppercase tracking-[0.06em] text-warning"
                          >{$tr("world.spBadge")}</span
                        >
                      {/if}
                      <span class="ml-1.5 text-xs text-text-secondary opacity-75"
                        >{f.node || $tr("common.unknown")}</span
                      >
                    </span>
                    <span
                      class="shrink-0 font-display text-sm tracking-[0.02em] whitespace-nowrap text-text-primary"
                      >{f.timeStr}</span
                    >
                  </div>
                {/each}
              {/if}
            </div>
          </CollapsibleSection>
        </div>
      {:else if sectionId === "world.fissureAlerts"}
        <!-- FISSURE ALERTS -->
        <div class="pb-3">
          <FissureAlerts />
        </div>
      {:else if sectionId === "world.invasions"}
        <!-- INVASIONS -->
        {#if invasions.length > 0}
          <div class="world-section">
            <CollapsibleSection
              title={$tr("world.invasions")}
              collapsed={collapsed.invasions}
              onToggle={() => toggleSection("invasions")}
            >
              <div class="flex flex-col">
                {#each invasions as inv}
                  <InvasionItem {inv} />
                {/each}
              </div>
            </CollapsibleSection>
          </div>
        {/if}
      {:else if sectionId === "world.baro"}
        <!-- BARO KI'TEER (inactive) -->
        {#if !baroActive && baroAct}
          <div class="world-section">
            <div class="flex items-center gap-2 py-1.5">
              <span class="text-sm font-semibold text-text-primary">{$tr("world.baroKiteer")}</span>
              <span
                class="text-xs font-bold py-0.5 px-1.5 rounded uppercase tracking-[0.06em] bg-surface-hover text-text-secondary opacity-70"
                >{$tr("world.inactive")}</span
              >
              <span class="text-sm font-display text-text-secondary ml-auto"
                >{times.baro}{#if baroLocation}
                  - {baroLocation}{/if}</span
              >
            </div>
          </div>
        {/if}
        <!-- BARO KI'TEER (active - icon grid) -->
        {#if baroActive && baro?.inventory && baro.inventory.length > 0}
          <div class="world-section mt-2">
            <CollapsibleSection
              title={$tr("world.baroKiteer")}
              collapsed={collapsed.baro}
              onToggle={() => toggleSection("baro")}
            >
              <div class="flex items-center justify-between py-1.5 text-sm text-text-secondary">
                <span>{baroLocation}</span>
                <span class="text-text-secondary text-xs"
                  >{$tr("world.leavesIn")} <strong>{times.baro}</strong></span
                >
              </div>
              <div class="flex flex-wrap gap-2.5 px-1 py-1">
                {#each baro.inventory as inv}
                  <BaroInventoryCard
                    entry={inv}
                    itemDb={$itemDb}
                    wfmItems={$wfmItems}
                    owned={baroOwnedSet.has(inv.uniqueName || "")}
                    onOpen={openItemDetail}
                  />
                {/each}
              </div>
            </CollapsibleSection>
          </div>
        {/if}
      {:else if sectionId === "world.bounties"}
        <!-- BOUNTIES -->
        {#if bounties.length > 0}
          <div class="world-section mt-2">
            <CollapsibleSection
              title={$tr("world.bounties")}
              collapsed={collapsed.bounties}
              onToggle={() => toggleSection("bounties")}
            >
              <div class="grid grid-cols-1 gap-x-5 gap-y-1 lg:grid-cols-2">
                {#each bountyColumns as column}
                  <div class="flex min-w-0 flex-col">
                    {#each column as group}
                      <div class="border-b border-border py-1">
                        <button
                          class="flex w-full items-center gap-1 border-0 bg-transparent py-1 text-left text-inherit cursor-pointer"
                          on:click={() => toggleSection(`bounty-${group.syndicateKey}`)}
                          aria-expanded={!collapsed[`bounty-${group.syndicateKey}`]}
                        >
                          <WorldToggleIcon collapsed={collapsed[`bounty-${group.syndicateKey}`]} />
                          <span class="text-lg font-semibold text-text-primary"
                            >{group.syndicate}</span
                          >
                          {#if bountyTimers[group.syndicateKey]?.timeStr}
                            <span
                              class="font-display text-sm tracking-[0.02em] whitespace-nowrap text-text-primary"
                              class:world-timer-urgent={bountyTimers[group.syndicateKey]?.urgent}
                              >{bountyTimers[group.syndicateKey].timeStr}</span
                            >
                          {/if}
                          <span class="ml-auto text-xs text-text-secondary"
                            >{$tr("world.bountiesCount", { count: group.jobs.length })}</span
                          >
                        </button>
                        {#if !collapsed[`bounty-${group.syndicateKey}`]}
                          <div class="flex flex-col pl-4">
                            {#each group.jobs as job, ji}
                              <button
                                class="flex w-full items-center gap-2 border-0 bg-transparent px-0 py-1 text-left text-sm text-inherit cursor-pointer hover:bg-surface-hover"
                                on:click={() => toggleSection(`bounty-${group.syndicateKey}-${ji}`)}
                              >
                                <span
                                  class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-text-primary"
                                >
                                  {titleCase(job.type)}
                                  {#if job.challengeDesc}
                                    <span class="text-text-secondary text-[0.92em]">
                                      - {job.challengeDesc}</span
                                    >
                                  {/if}
                                </span>
                                <span
                                  class="shrink-0 font-display whitespace-nowrap text-accent text-base"
                                  >{job.enemyLevels[0]}-{job.enemyLevels[1]}</span
                                >
                                <WorldToggleIcon
                                  collapsed={!collapsed[`bounty-${group.syndicateKey}-${ji}`]}
                                />
                              </button>
                              {#if collapsed[`bounty-${group.syndicateKey}-${ji}`]}
                                <div class="mb-1 ml-1 border-l-2 border-accent py-1 pl-5">
                                  {#await getBountyRewards(group.syndicateKey, job.enemyLevels, job.standingStages.length, bountyRotation, job.tierIndex)}
                                    <span class="text-xs text-text-secondary py-1"
                                      >{$tr("world.loadingRewards")}</span
                                    >
                                  {:then rewards}
                                    {#if rewards.length > 0}
                                      <div class="mt-1.5">
                                        {#each rewards as sr}
                                          <div class="mb-1">
                                            <span
                                              class="text-base font-semibold text-text-secondary block mb-0.5"
                                              >{sr.label}</span
                                            >
                                            <div class="flex flex-col gap-0.5">
                                              {#each sr.items as item}
                                                {@const rewardUniqueName = resolveRewardUniqueName(
                                                  item.itemName,
                                                  $itemDb,
                                                )}
                                                {@const rewardIcon = resolveRewardIcon(
                                                  item.itemName,
                                                  $itemDb,
                                                )}
                                                <button
                                                  type="button"
                                                  class="flex w-full items-center justify-between gap-1 border-0 bg-transparent px-1 -mx-1 py-0 text-left text-sm appearance-none disabled:text-text-primary disabled:opacity-100 disabled:cursor-default {rewardUniqueName
                                                    ? 'cursor-pointer rounded transition-[background] duration-150 hover:bg-surface-hover'
                                                    : ''} {item.rarity === 'Rare' ||
                                                  item.rarity === 'Legendary'
                                                    ? 'text-accent'
                                                    : 'text-text-primary'}"
                                                  disabled={!rewardUniqueName}
                                                  on:click={() =>
                                                    rewardUniqueName &&
                                                    openItemDetail(rewardUniqueName, [
                                                      {
                                                        location: `${group.syndicate} ${$tr("world.bountyLabel")} (${job.enemyLevels[0]}\u2013${job.enemyLevels[1]}) \u2014 ${sr.label}`,
                                                        rarity: item.rarity,
                                                        chance: item.chance / 100,
                                                      },
                                                    ])}
                                                >
                                                  {#if rewardIcon}
                                                    <img
                                                      class="h-4 w-4 shrink-0 object-contain"
                                                      src={rewardIcon}
                                                      alt=""
                                                    />
                                                  {/if}
                                                  <span
                                                    class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
                                                    >{item.itemName}</span
                                                  >
                                                  <span
                                                    class="ml-2 w-14 shrink-0 whitespace-nowrap text-right text-xs font-semibold tabular-nums"
                                                    >{item.chance.toFixed(2)}%</span
                                                  >
                                                </button>
                                              {/each}
                                            </div>
                                          </div>
                                        {/each}
                                      </div>
                                    {/if}
                                  {:catch err}
                                    <div class="text-xs text-text-muted opacity-50">
                                      {(err as Error)?.message ?? $tr("world.rewardUnavailable")}
                                    </div>
                                  {/await}
                                </div>
                              {/if}
                            {/each}
                          </div>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/each}
              </div>
            </CollapsibleSection>
          </div>
        {/if}
      {/if}
    </LayoutGrid>
  {/if}
</section>

<style>
  .world-section {
    padding: 0.85rem 0;
    border-top: 1px solid var(--border);
  }
  /* Each section is its own grid cell now, so "first" comes from the layout
     plan rather than from DOM position. Fully global because the marked element
     belongs to LayoutSection; .world-layout keeps it to this view. */
  :global(.world-layout [data-layout-first-in-column="true"] > .world-section) {
    border-top: none;
  }

  .world-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.32rem 0;
    border-bottom: 1px dashed var(--surface-hover);
  }
  .world-row:last-child {
    border-bottom: none;
  }

  /* :global() because state classes are applied via class: directive in CycleRow. */
  :global(.world-state-day) {
    color: var(--world-state-day-text);
    background: color-mix(in srgb, var(--world-state-day-text) 10%, transparent);
  }
  :global(.world-state-night) {
    color: var(--world-state-night-text);
    background: color-mix(in srgb, var(--world-state-night-text) 10%, transparent);
  }
  :global(.world-state-warm) {
    color: var(--world-state-warm-text);
    background: color-mix(in srgb, var(--world-state-warm-text) 10%, transparent);
  }
  :global(.world-state-cold) {
    color: var(--world-state-cold-text);
    background: color-mix(in srgb, var(--world-state-cold-text) 10%, transparent);
  }
  :global(.world-state-fass) {
    color: var(--world-state-fass-text);
    background: color-mix(in srgb, var(--world-state-fass-text) 10%, transparent);
  }
  :global(.world-state-vome) {
    color: var(--world-state-vome-text);
    background: color-mix(in srgb, var(--world-state-vome-text) 10%, transparent);
  }
  :global(.world-state-anger) {
    color: var(--world-state-anger-text);
    background: color-mix(in srgb, var(--world-state-anger-text) 10%, transparent);
  }
  :global(.world-state-joy) {
    color: var(--world-state-joy-text);
    background: color-mix(in srgb, var(--world-state-joy-text) 10%, transparent);
  }
  :global(.world-state-envy) {
    color: var(--world-state-envy-text);
    background: color-mix(in srgb, var(--world-state-envy-text) 10%, transparent);
  }
  :global(.world-state-sorrow) {
    color: var(--world-state-sorrow-text);
    background: color-mix(in srgb, var(--world-state-sorrow-text) 10%, transparent);
  }
  :global(.world-state-fear) {
    color: var(--world-state-fear-text);
    background: color-mix(in srgb, var(--world-state-fear-text) 10%, transparent);
  }

  .world-badge-lith {
    background: color-mix(in srgb, var(--world-badge-lith-text) 12%, transparent);
    color: var(--world-badge-lith-text);
  }
  .world-badge-meso {
    background: color-mix(in srgb, var(--world-badge-meso-text) 18%, transparent);
    color: var(--world-badge-meso-text);
  }
  .world-badge-neo {
    background: color-mix(in srgb, var(--world-badge-neo-text) 12%, transparent);
    color: var(--world-badge-neo-text);
  }
  .world-badge-axi {
    background: color-mix(in srgb, var(--world-badge-axi-text) 12%, transparent);
    color: var(--world-badge-axi-text);
  }
  .world-badge-requiem {
    background: color-mix(in srgb, var(--world-badge-requiem-text) 14%, transparent);
    color: var(--world-badge-requiem-text);
  }
  .world-badge-omnia {
    background: color-mix(in srgb, var(--world-badge-omnia-text) 12%, transparent);
    color: var(--world-badge-omnia-text);
  }

  /* Faction colors shared with child world components. */
  :global(.world-faction-grineer) {
    color: var(--world-faction-grineer);
  }
  :global(.world-faction-corpus) {
    color: var(--world-faction-corpus);
  }
  :global(.world-faction-infested) {
    color: var(--world-faction-infested);
  }
  :global(.world-faction-bg-grineer) {
    background: var(--world-faction-grineer);
  }
  :global(.world-faction-bg-corpus) {
    background: var(--world-faction-corpus);
  }
  :global(.world-faction-bg-infested) {
    background: var(--world-faction-infested);
  }

  /* :global() because the class is applied via class: directive in child
     CycleRow; !important wins over the sibling text-text-primary utility. */
  :global(.world-timer-urgent) {
    color: var(--world-timer-urgent-text) !important;
  }

  .fissure-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.35rem 0;
    border-bottom: 1px dashed var(--surface-hover);
  }
  .fissure-row:last-child {
    border-bottom: none;
  }

  /* Suppress number-input spin buttons (still needs -webkit- for Chromium). */
  .cycle-lead-input {
    appearance: textfield;
  }
  .cycle-lead-input::-webkit-inner-spin-button,
  .cycle-lead-input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
</style>
