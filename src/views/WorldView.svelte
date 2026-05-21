<script lang="ts">
  import { onMount } from "svelte";
  import { worldData, worldLoading, worldFissureMode } from "../stores/world.js";
  import { inventoryData, itemDb, componentOwnership, wfmItems } from "../stores/data.js";
  import {
    activeWindow,
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
  import { parseIsoDate } from "../lib/format.js";
  import { RELIC_ICON_PATHS, buildFeaturedPrimes, buildBaroOwnedSet, resolveCircuitChoices } from "../lib/world.js";
  import { overlaySettings } from "../stores/overlaySettings.js";
  import { activeItem } from "../stores/modals.js";
  import type { Invasion, SteelPathHonors } from "../types/world.js";
  import FissureAlerts from "../components/settings/FissureAlerts.svelte";
  import CollapsibleSection from "../components/CollapsibleSection.svelte";
  import InvasionItem from "../components/world/InvasionItem.svelte";
  import BaroInventoryCard from "../components/world/BaroInventoryCard.svelte";
  import CycleRow from "../components/world/CycleRow.svelte";
  import IconButtonCard from "../components/world/IconButtonCard.svelte";
  import WorldToggleIcon from "../components/world/WorldToggleIcon.svelte";
  import SegmentedControl from "../components/SegmentedControl.svelte";
  import { getBountyRewards, resolveRewardIcon, resolveRewardUniqueName } from "../lib/bountyRewards.js";
  import { buildParsedItemFromDb } from "../lib/parsedItemFromDb.js";
  import { clockStore } from "../lib/timers.js";

  // Collapse state per section — persisted to localStorage
  let collapsed: Record<string, boolean> = loadCollapsedSections();
  function toggleSection(key: string) {
    collapsed = toggleCollapsedSection(collapsed, key);
  }

  const nowClock = clockStore(1000);
  const coarseClock = clockStore(COARSE_CLOCK_MS);
  $: nowMs = $nowClock;
  $: nowCoarseMs = $coarseClock;

  onMount(mountWorldView);

  function openItemDetail(uniqueName: string, extraDrops?: import("../types/inventory.js").DropInfo[]) {
    if (!uniqueName) return;
    const db = $itemDb[uniqueName];
    if (!db) return;

    activeItem.set(
      buildParsedItemFromDb(
        uniqueName,
        db,
        $componentOwnership,
        extraDrops ? { extraDrops } : {},
      ),
    );
  }

  $: wd = $worldData;

  $: varzia    = wd?.vaultTrader || null;
  $: baro      = wd?.voidTrader  || null;
  $: earth     = wd?.earthCycle  || {};
  $: cetus     = wd?.cetusCycle  || {};
  $: vallis    = wd?.vallisCycle || {};
  $: cambion   = wd?.cambionCycle || {};
  $: duviri    = wd?.duviriCycle  || {};
  $: sortie    = wd?.sortie       || {};
  $: steelPath = wd?.steelPath    || null;

  $: varziaActive = activeWindow(varzia?.activation, varzia?.expiry, nowCoarseMs);

  $: baroAct = parseIsoDate(baro?.activation);
  $: baroActive = activeWindow(baro?.activation, baro?.expiry, nowCoarseMs);

  $: featuredPrimes = wd ? buildFeaturedPrimes(varzia, $inventoryData, $itemDb) : [];

  $: duviriState = (duviri.state || "unknown").toString();
  $: duviriNormal = (duviri.choices || []).find((c) => c.category === "normal")?.choices || [];
  $: duviriHard = (duviri.choices || []).find((c) => c.category === "hard")?.choices || [];
  $: circuitNormalItems = resolveCircuitChoices(duviriNormal, $itemDb, $inventoryData);
  $: circuitHardItems = resolveCircuitChoices(duviriHard, $itemDb, $inventoryData);

  // Recompute all countdowns from a single clock source.
  // This keeps seconds moving while staying on the World tab.
  $: times = buildWorldTimes({ baro, baroActive, varzia, varziaActive, sortie, steelPath, duviri, earth, cetus, vallis, cambion, nowMs });

  $: fissureFlat = buildFissureRows(wd?.fissures, $worldFissureMode, nowMs, nowCoarseMs);

  $: cycleRows = buildCycleRows({ earth, cetus, vallis, cambion, duviri, duviriState, times, nowCoarseMs });

  // Invasions from raw DE world state (or warframestat fallback)
  $: invasions = ((wd?.invasions || []) as Invasion[]).filter(inv => !inv.completed);

  // Current bounty rotation (A/B/C) from oracle bounty-cycle
  $: bountyRotation = (wd?.bountyRotation as string | undefined) || undefined;

  // Steel Path Honors from warframestat.us
  $: steelPathHonors = (wd?.steelPath && typeof (wd.steelPath as unknown as { currentReward?: unknown }).currentReward === 'object')
    ? wd.steelPath as SteelPathHonors
    : null;

  $: bounties = buildBountyGroups(wd?.bounties);

  $: resetUrgency = buildResetUrgency(sortie, steelPath, nowCoarseMs);

  $: bountyTimers = buildBountyTimers(bounties, nowMs, nowCoarseMs);

  // Baro relay location for countdown display
  $: baroLocation = typeof baro?.location === "string" && baro.location ? baro.location : null;

  // Baro ownership set — covers mods, weapons, relics, cosmetics
  $: baroOwnedSet = buildBaroOwnedSet($inventoryData);

  function titleCase(s: string): string {
    return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

  function daysUntilLabel(iso: string | undefined): string {
    const ms = iso ? Date.parse(iso) - nowCoarseMs : Number.NaN;
    if (!Number.isFinite(ms)) return "Soon";
    const days = Math.max(1, Math.ceil(ms / 86_400_000));
    return `In ${days} day${days === 1 ? "" : "s"}`;
  }
</script>

<section class="view active">
  <div class="view-header">
    <div class="flex items-center gap-3">
      <h2>World</h2>
      {#if baroActive}
        <span class="rounded border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-warning">Baro leaves in {times.baro}{#if baroLocation} · {baroLocation}{/if}</span>
      {:else if baroAct}
        <span class="rounded border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-warning">Baro arrives in {times.baro}{#if baroLocation} · {baroLocation}{/if}</span>
      {/if}
    </div>
  </div>

  {#if !wd && $worldLoading}
    <div class="empty-state"><p>Loading world data…</p></div>
  {:else if !wd}
    <div class="empty-state"><p>World data unavailable</p></div>
  {:else}
    <div class="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-x-6 max-[1100px]:grid-cols-1">
      <!-- LEFT COLUMN -->
      <div class="flex flex-col">

        <!-- PLANET CYCLES -->
        <div class="world-section">
          <CollapsibleSection title="Planet Cycles" collapsed={collapsed.cycles} onToggle={() => toggleSection('cycles')}>
          {#if cycleRows.length > 0}
            <div class="grid grid-cols-2 gap-x-5">
              {#each cycleRows as row}
                {@const isAlertable = row.key === 'earth' || row.key === 'cetus' || row.key === 'vallis' || row.key === 'cambion' || row.key === 'duviri'}
                {@const alertOn = isAlertable && !!$overlaySettings.cycleAlerts?.[row.key]}
                <CycleRow
                  name={row.key.charAt(0).toUpperCase() + row.key.slice(1)}
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
              <span>Notify before cycle change</span>
              <span class="flex items-center gap-1">
                <input
                  type="number"
                  class="cycle-lead-input w-10 rounded-[var(--radius-md)] border border-border bg-black/25 px-1 py-0.5 text-center text-xs text-text-primary outline-none"
                  min="0"
                  max="120"
                  value={$overlaySettings.cycleAlertMinutesBefore ?? 3}
                  on:change={(e) => setCycleAlertMinutes(Number(e.currentTarget.value))}
                />
                <span>min</span>
              </span>
            </div>
          {:else}
            <span class="text-sm text-text-secondary opacity-70">Cycle data unavailable</span>
          {/if}
          </CollapsibleSection>
        </div>

        <!-- RESET TIMERS -->
        <div class="world-section">
          <CollapsibleSection title="Reset Timers" collapsed={collapsed.timers} onToggle={() => toggleSection('timers')}>
          <div class="world-row"><span class="text-sm text-text-secondary">Daily sortie</span><span class="font-display text-sm tracking-[0.02em] whitespace-nowrap text-text-primary" class:world-timer-urgent={resetUrgency.sortie}>{times.sortie}</span></div>
          <div class="world-row"><span class="text-sm text-text-secondary">Daily reset</span><span class="font-display text-sm tracking-[0.02em] whitespace-nowrap text-text-primary" class:world-timer-urgent={resetUrgency.daily}>{times.daily}</span></div>
          <div class="world-row"><span class="text-sm text-text-secondary">Weekly resets</span><span class="font-display text-sm tracking-[0.02em] whitespace-nowrap text-text-primary" class:world-timer-urgent={resetUrgency.weekly}>{times.weekly}</span></div>
          <div class="world-row"><span class="text-sm text-text-secondary">Steel Path honours</span><span class="font-display text-sm tracking-[0.02em] whitespace-nowrap text-text-primary" class:world-timer-urgent={resetUrgency.steelPath}>{times.steelPath}</span></div>
          </CollapsibleSection>
        </div>

        <!-- PRIME RESURGENCE -->
        <div class="world-section">
          <CollapsibleSection title="Prime Resurgence" collapsed={collapsed.resurgence} onToggle={() => toggleSection('resurgence')}>
          <div class="text-sm text-text-secondary mb-2">
            Rotation ends in <strong>{times.varzia}</strong>
          </div>
          {#if featuredPrimes.length > 0}
            <div class="flex gap-2.5 overflow-x-auto overflow-y-visible px-1 py-1">
              {#each featuredPrimes as p}
                <IconButtonCard
                  name={p.name}
                  imageUrl={p.imageUrl}
                  owned={p.owned}
                  onClick={() => openItemDetail(p.uniqueName)}
                  size={100}
                  hoverScale={105}
                  borderWidth="2"
                />
              {/each}
            </div>
          {:else}
            <span class="text-sm text-text-secondary opacity-70">No featured prime items found</span>
          {/if}
          </CollapsibleSection>
        </div>

        <!-- THE CIRCUIT -->
        <div class="world-section">
          <CollapsibleSection title="The Circuit" collapsed={collapsed.circuit} onToggle={() => toggleSection('circuit')}>
          {#each [{ label: 'Normal rotation', items: circuitNormalItems, isSteelPath: false }, { label: 'Steel Path rotation', items: circuitHardItems, isSteelPath: true }] as rot}
          <div class="mb-1 text-xs font-bold uppercase tracking-[0.06em] {rot.isSteelPath ? 'text-warning' : 'text-text-secondary'}">{rot.label}</div>
          <div class="mb-2 flex gap-2 overflow-x-auto overflow-y-visible px-0.5 py-1">
            {#each rot.items as item}
              <IconButtonCard
                name={item.name}
                imageUrl={item.imageUrl}
                owned={item.owned}
                onClick={() => openItemDetail(item.uniqueName)}
                size={80}
                hoverScale={108}
                borderWidth="1.5"
              />
            {:else}
              <span class="text-sm text-text-secondary opacity-70">No data</span>
            {/each}
          </div>
          {/each}
          </CollapsibleSection>
        </div>

        <!-- STEEL PATH HONORS -->
        {#if steelPathHonors}
        <div class="world-section">
          <CollapsibleSection title="Steel Path Honors" collapsed={collapsed.steelpath} onToggle={() => toggleSection('steelpath')}>
            <svelte:fragment slot="actions">
            <span class="font-display text-sm tracking-[0.02em] whitespace-nowrap text-text-primary">{times.steelPath}</span>
            </svelte:fragment>
          <div class="flex items-center gap-2 py-1.5">
            <span class="text-xs font-bold text-text-secondary uppercase tracking-[0.06em] shrink-0">This week</span>
            <span class="text-sm font-semibold text-warning flex-1 min-w-0">{steelPathHonors.currentReward.name}</span>
            <span class="text-xs text-text-secondary whitespace-nowrap shrink-0">{steelPathHonors.currentReward.cost} Steel Essence</span>
          </div>
          {#each steelPathHonors.upcoming || [] as reward}
            <div class="flex items-center gap-2 py-0.5">
              <span class="text-sm text-text-secondary shrink-0">{daysUntilLabel(reward.activation)}:</span>
              <span class="text-sm text-text-primary flex-1 min-w-0">{reward.name}</span>
              <span class="text-xs text-text-secondary whitespace-nowrap shrink-0">{reward.cost} Steel Essence</span>
            </div>
          {/each}
          </CollapsibleSection>
        </div>
        {/if}
      </div>

      <!-- RIGHT COLUMN -->
      <div class="flex flex-col">

        <!-- VOID FISSURES -->
        <div class="world-section border-t-0">
          <CollapsibleSection title="Void Fissures" collapsed={collapsed.fissures} onToggle={() => toggleSection('fissures')}>
            <svelte:fragment slot="actions">
            <SegmentedControl
              value={$worldFissureMode}
              options={FISSURE_MODE_OPTIONS}
              onChange={(mode) => worldFissureMode.set(mode)}
            />
            </svelte:fragment>
          <div class="flex flex-col">
            {#if fissureFlat.length === 0}
              <span class="text-sm text-text-secondary opacity-70">No active {$worldFissureMode === 'steel' ? 'Steel Path' : 'Normal'} fissures</span>
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
                    <img class="h-3.5 w-3.5 shrink-0" src={RELIC_ICON_PATHS[f.tierCls] || RELIC_ICON_PATHS.default} alt="" />
                    {f.tier}
                  </span>
                  <span class="min-w-0 flex-1 text-sm">
                    <strong class="text-text-primary">{f.missionType || 'Mission'}</strong>
                    <span class="ml-1.5 text-xs text-text-secondary opacity-75">{f.node || 'Unknown'}</span>
                  </span>
                  <span class="shrink-0 font-display text-sm tracking-[0.02em] whitespace-nowrap text-text-primary">{f.timeStr}</span>
                </div>
              {/each}
            {/if}
          </div>
          </CollapsibleSection>
        </div>

        <!-- FISSURE ALERTS -->
        <div class="pb-3">
          <FissureAlerts />
        </div>

        <!-- INVASIONS -->
        {#if invasions.length > 0}
        <div class="world-section">
          <CollapsibleSection title="Invasions" collapsed={collapsed.invasions} onToggle={() => toggleSection('invasions')}>
          <div class="flex flex-col">
            {#each invasions as inv}
              <InvasionItem {inv} />
            {/each}
          </div>
          </CollapsibleSection>
        </div>
        {/if}

        <!-- BARO KI'TEER (inactive — under invasions) -->
        {#if !baroActive && baroAct}
        <div class="world-section">
          <div class="flex items-center gap-2 py-1.5">
            <span class="text-sm font-semibold text-text-primary">Baro Ki'Teer</span>
            <span class="text-xs font-bold py-0.5 px-1.5 rounded uppercase tracking-[0.06em] bg-white/[0.06] text-text-secondary opacity-70">Inactive</span>
            <span class="text-sm font-display text-text-secondary ml-auto">{times.baro}{#if baroLocation} · {baroLocation}{/if}</span>
          </div>
        </div>
        {/if}

      </div>
    </div>

    <!-- BARO KI'TEER (active — full-width with icon grid) -->
    {#if baroActive && baro?.inventory && baro.inventory.length > 0}
    <div class="world-section mt-2">
      <CollapsibleSection title="Baro Ki'Teer" collapsed={collapsed.baro} onToggle={() => toggleSection('baro')}>
      <div class="flex items-center justify-between py-1.5 text-sm text-text-secondary">
        <span>{baroLocation}</span>
        <span class="text-text-secondary text-xs">Leaves in <strong>{times.baro}</strong></span>
      </div>
      <div class="flex flex-wrap gap-2.5 px-1 py-1">
        {#each baro.inventory as inv}
          <BaroInventoryCard
            entry={inv}
            itemDb={$itemDb}
            wfmItems={$wfmItems}
            owned={baroOwnedSet.has(inv.uniqueName || '')}
            onOpen={openItemDetail}
          />
        {/each}
      </div>
      </CollapsibleSection>
    </div>
    {/if}

    <!-- BOUNTIES (full-width below grid) -->
    {#if bounties.length > 0}
    <div class="world-section mt-2">
      <CollapsibleSection title="Bounties" collapsed={collapsed.bounties} onToggle={() => toggleSection('bounties')}>
      <div class="grid grid-cols-2 items-start gap-x-5 gap-y-1">
        {#each bounties as group}
          <div class="border-b border-border py-1 last:border-b-0">
            <button class="flex w-full items-center gap-1 border-0 bg-transparent py-1 text-left text-inherit cursor-pointer" on:click={() => toggleSection(`bounty-${group.syndicateKey}`)} aria-expanded={!collapsed[`bounty-${group.syndicateKey}`]}>
              <WorldToggleIcon collapsed={collapsed[`bounty-${group.syndicateKey}`]} />
              <span class="text-lg font-semibold text-text-primary">{group.syndicate}</span>
              {#if bountyTimers[group.syndicateKey]?.timeStr}
                <span class="font-display text-sm tracking-[0.02em] whitespace-nowrap text-text-primary" class:world-timer-urgent={bountyTimers[group.syndicateKey]?.urgent}>{bountyTimers[group.syndicateKey].timeStr}</span>
              {/if}
              <span class="ml-auto text-xs text-text-secondary">{group.jobs.length} bounties</span>
            </button>
            {#if !collapsed[`bounty-${group.syndicateKey}`]}
            <div class="flex flex-col pl-4">
              {#each group.jobs as job, ji}
                <button class="flex w-full items-center gap-2 border-0 bg-transparent px-0 py-1 text-left text-sm text-inherit cursor-pointer hover:bg-white/[0.03]" on:click={() => toggleSection(`bounty-${group.syndicateKey}-${ji}`)}>
                  <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-text-primary">
                    {titleCase(job.type)}
                    {#if job.challengeDesc}
                      <span class="text-text-secondary text-[0.92em]"> — {job.challengeDesc}</span>
                    {/if}
                  </span>
                  <span class="shrink-0 font-display whitespace-nowrap text-accent text-base">{job.enemyLevels[0]}–{job.enemyLevels[1]}</span>
                  <WorldToggleIcon collapsed={!collapsed[`bounty-${group.syndicateKey}-${ji}`]} />
                </button>
                {#if collapsed[`bounty-${group.syndicateKey}-${ji}`]}
                <div class="mb-1 ml-1 border-l-2 border-accent py-1 pl-5">
                  {#await getBountyRewards(group.syndicateKey, job.enemyLevels, job.standingStages.length, bountyRotation)}
                    <span class="text-xs text-text-secondary py-1">Loading rewards…</span>
                  {:then rewards}
                    {#if rewards.length > 0}
                    <div class="mt-1.5">
                      {#each rewards as sr}
                        <div class="mb-1">
                          <span class="text-base font-semibold text-text-secondary block mb-0.5">{sr.label}</span>
                          <div class="flex flex-col gap-0.5">
                            {#each sr.items as item}
                              {@const rewardUniqueName = resolveRewardUniqueName(item.itemName, $itemDb)}
                              {@const rewardIcon = resolveRewardIcon(item.itemName, $itemDb)}
                              <button
                                type="button"
                                class="flex w-full items-center justify-between gap-1 border-0 bg-transparent px-1 -mx-1 py-0 text-left text-sm appearance-none disabled:text-text-primary disabled:opacity-100 disabled:cursor-default {rewardUniqueName ? 'cursor-pointer rounded transition-[background] duration-150 hover:bg-white/[0.06]' : ''} {item.rarity === 'Rare' || item.rarity === 'Legendary' ? 'text-accent' : 'text-text-primary'}"
                                disabled={!rewardUniqueName}
                                on:click={() => rewardUniqueName && openItemDetail(rewardUniqueName, [{location: `${group.syndicate} Bounty (${job.enemyLevels[0]}\u2013${job.enemyLevels[1]}) \u2014 ${sr.label}`, rarity: item.rarity, chance: item.chance / 100}])}
                              >
                                {#if rewardIcon}
                                  <img class="h-4 w-4 shrink-0 object-contain" src={rewardIcon} alt="" />
                                {/if}
                                <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{item.itemName}</span>
                                <span class="ml-2 w-14 shrink-0 whitespace-nowrap text-right text-xs font-semibold tabular-nums">{item.chance.toFixed(2)}%</span>
                              </button>
                            {/each}
                          </div>
                        </div>
                      {/each}
                    </div>
                    {/if}
                  {:catch}
                    <!-- silent fail -->
                  {/await}
                </div>
                {/if}
              {/each}
            </div>
            {/if}
          </div>
        {/each}
      </div>
      </CollapsibleSection>
    </div>
    {/if}
  {/if}
</section>

<style>
  .world-section { padding: 0.85rem 0; border-top: 1px solid var(--border); }
  .world-section:first-child { border-top: none; }

  .world-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.32rem 0; border-bottom: 1px dashed rgba(255, 255, 255, 0.06);
  }
  .world-row:last-child { border-bottom: none; }

  /* :global() because CollapsibleSection renders the actual header element. */
  :global(.world-section-header) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.55rem;
  }
  :global(.world-section-title) {
    line-height: inherit;
  }
  :global(.world-section-toggle) {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;

    font-family: var(--font-display);
    font-size: 0.84rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1;

    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
  }
  /* SVG caret shares the section title line-height, so alignment is controlled once. */
  :global(.world-toggle-icon) {
    width: 1.12lh;
    height: 1.12lh;
    flex: 0 0 auto;
    display: block;

    color: var(--text-secondary);
    transition: transform 0.15s ease;
    transform-origin: center;
  }
  :global(.world-toggle-icon.collapsed) {
    transform: rotate(-90deg);
  }

  /* :global() because state classes are applied via class: directive in CycleRow. */
  :global(.world-state-day)    { color: var(--world-state-day-text); background: color-mix(in srgb, var(--world-state-day-text) 10%, transparent); }
  :global(.world-state-night)  { color: var(--world-state-night-text); background: color-mix(in srgb, var(--world-state-night-text) 10%, transparent); }
  :global(.world-state-warm)   { color: var(--world-state-warm-text); background: color-mix(in srgb, var(--world-state-warm-text) 10%, transparent); }
  :global(.world-state-cold)   { color: var(--world-state-cold-text); background: color-mix(in srgb, var(--world-state-cold-text) 10%, transparent); }
  :global(.world-state-fass)   { color: var(--world-state-fass-text); background: color-mix(in srgb, var(--world-state-fass-text) 10%, transparent); }
  :global(.world-state-vome)   { color: var(--world-state-vome-text); background: color-mix(in srgb, var(--world-state-vome-text) 10%, transparent); }
  :global(.world-state-anger)  { color: var(--world-state-anger-text); background: color-mix(in srgb, var(--world-state-anger-text) 10%, transparent); }
  :global(.world-state-joy)    { color: var(--world-state-joy-text); background: color-mix(in srgb, var(--world-state-joy-text) 10%, transparent); }
  :global(.world-state-envy)   { color: var(--world-state-envy-text); background: color-mix(in srgb, var(--world-state-envy-text) 10%, transparent); }
  :global(.world-state-sorrow) { color: var(--world-state-sorrow-text); background: color-mix(in srgb, var(--world-state-sorrow-text) 10%, transparent); }
  :global(.world-state-fear)   { color: var(--world-state-fear-text); background: color-mix(in srgb, var(--world-state-fear-text) 10%, transparent); }

  .world-badge-lith    { background: color-mix(in srgb, var(--world-badge-lith-text) 12%, transparent); color: var(--world-badge-lith-text); }
  .world-badge-meso    { background: color-mix(in srgb, var(--world-badge-meso-text) 18%, transparent); color: var(--world-badge-meso-text); }
  .world-badge-neo     { background: color-mix(in srgb, var(--world-badge-neo-text) 12%, transparent); color: var(--world-badge-neo-text); }
  .world-badge-axi     { background: color-mix(in srgb, var(--world-badge-axi-text) 12%, transparent); color: var(--world-badge-axi-text); }
  .world-badge-requiem { background: color-mix(in srgb, var(--world-badge-requiem-text) 14%, transparent); color: var(--world-badge-requiem-text); }
  .world-badge-omnia   { background: color-mix(in srgb, var(--world-badge-omnia-text) 12%, transparent); color: var(--world-badge-omnia-text); }

  /* Faction colors shared with child world components. */
  :global(.world-faction-grineer)    { color: var(--world-faction-grineer); }
  :global(.world-faction-corpus)     { color: var(--world-faction-corpus); }
  :global(.world-faction-infested)   { color: var(--world-faction-infested); }
  :global(.world-faction-bg-grineer) { background: var(--world-faction-grineer); }
  :global(.world-faction-bg-corpus)  { background: var(--world-faction-corpus); }
  :global(.world-faction-bg-infested){ background: var(--world-faction-infested); }

  /* :global() because the class is applied via class: directive in child
     CycleRow; !important wins over the sibling text-text-primary utility. */
  :global(.world-timer-urgent) { color: var(--world-timer-urgent-text) !important; }

  .fissure-row {
    display: flex; align-items: center; gap: 0.55rem;
    padding: 0.35rem 0; border-bottom: 1px dashed rgba(255, 255, 255, 0.06);
  }
  .fissure-row:last-child { border-bottom: none; }

  /* Suppress number-input spin buttons (still needs -webkit- for Chromium). */
  .cycle-lead-input { appearance: textfield; }
  .cycle-lead-input::-webkit-inner-spin-button,
  .cycle-lead-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
</style>
