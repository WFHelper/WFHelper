<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { worldData, worldLoading, worldLastFetch, worldFissureMode } from "../stores/world.js";
  import { inventoryData, itemDb, componentOwnership, wfmItems } from "../stores/data.js";
  import { getLookupByName } from "../lib/inventoryMarket.js";
  import {
    parseIsoDate, timeTo, timeToStrict, cycleTimeDisplay,
    nextDailyResetUtc, nextWeeklyResetUtc,
  } from "../lib/format.js";
  import { PLANET_ICON_PATHS, RELIC_ICON_PATHS, fissureTierClass, buildFeaturedPrimes, buildBaroOwnedSet, resolveCircuitChoices } from "../lib/world.js";
  import { invoke, on } from "../lib/ipc.js";
  import { addToast } from "../stores/toasts.js";
  import { overlaySettings, overlaySettingsLoaded, applyOverlaySettingsResponse } from "../stores/overlaySettings.js";
  import { activeItem } from "../stores/modals.js";
  import type { Invasion, SyndicateBounty, SteelPathHonors } from "../types/world.js";
  import FissureAlerts from "../components/settings/FissureAlerts.svelte";
  import CollapsibleSection from "../components/CollapsibleSection.svelte";
  import { getBountyRewards, resolveRewardIcon, resolveRewardUniqueName } from "../lib/bountyRewards.js";
  import { buildParsedItemFromDb } from "../lib/parsedItemFromDb.js";

  const WORLD_REFRESH_MS = 120_000;
  const WORLD_POLL_MS = 30_000;
  const FISSURE_EXPIRY_GUARD_MS = 1_500;
  const FISSURE_TIER_ORDER: Record<string, number> = { lith: 0, meso: 1, neo: 2, axi: 3, requiem: 4, omnia: 5 };

  // Collapse state per section — persisted to localStorage
  const COLLAPSE_KEY = "world-collapsed-sections";
  function loadCollapsed(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }
  let collapsed: Record<string, boolean> = loadCollapsed();
  function toggleSection(key: string) {
    collapsed[key] = !collapsed[key];
    collapsed = collapsed; // trigger reactivity
    // Only persist section-level toggle, not per-bounty reward expansion
    const toSave: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(collapsed)) {
      if (!/^bounty-.+-\d+$/.test(k)) toSave[k] = v;
    }
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(toSave)); } catch { /* best effort */ }
  }

  // Two clocks: nowMs (1 s) drives display countdown labels; nowCoarseMs (5 s)
  // drives urgency flags and active-window booleans, which flip once per
  // hours/days and don't need second-level precision. Splitting these roughly
  // halves the per-second reactive re-fire count on this view.
  const COARSE_CLOCK_MS = 5_000;
  let nowMs = Date.now();
  let nowCoarseMs = Date.now();
  let clockInterval: ReturnType<typeof setInterval> | null = null;
  let coarseClockInterval: ReturnType<typeof setInterval> | null = null;
  let worldPollInterval: ReturnType<typeof setInterval> | null = null;
  let unsubFetchError: (() => void) | null = null;

  onMount(() => {
    void fetchWorldData(true);

    unsubFetchError = on("world-state-fetch-error", (message) => {
      addToast({
        level: "warning",
        title: "World State",
        message: `Failed to fetch world state: ${message}`,
        durationMs: 8000,
      });
    });

    // Ensure overlay settings are loaded so cycle-alert toggles reflect persisted state
    if (!$overlaySettingsLoaded) {
      void invoke("getOverlaySettings").then((loaded) => {
        if (loaded) applyOverlaySettingsResponse(loaded);
      }).catch((e: unknown) => console.error("[World] getOverlaySettings failed:", e));
    }

    clockInterval = setInterval(() => {
      nowMs = Date.now();
    }, 1000);

    coarseClockInterval = setInterval(() => {
      nowCoarseMs = Date.now();
    }, COARSE_CLOCK_MS);

    worldPollInterval = setInterval(() => {
      void fetchWorldData();
    }, WORLD_POLL_MS);
  });

  onDestroy(() => {
    if (clockInterval) clearInterval(clockInterval);
    if (coarseClockInterval) clearInterval(coarseClockInterval);
    if (worldPollInterval) clearInterval(worldPollInterval);
    unsubFetchError?.();
  });

  async function toggleCycleAlert(key: "earth" | "cetus" | "vallis" | "cambion" | "duviri") {
    const current = $overlaySettings.cycleAlerts?.[key] ?? false;
    const newAlerts = { ...$overlaySettings.cycleAlerts, [key]: !current };
    try {
      const saved = await invoke("setOverlaySettings", { cycleAlerts: newAlerts });
      if (saved) applyOverlaySettingsResponse(saved);
    } catch (e: unknown) {
      console.error("[World] toggleCycleAlert failed:", e);
    }
  }

  async function setCycleAlertMinutes(minutes: number) {
    const clamped = Math.max(0, Math.min(120, Math.round(minutes)));
    try {
      const saved = await invoke("setOverlaySettings", { cycleAlertMinutesBefore: clamped });
      if (saved) applyOverlaySettingsResponse(saved);
    } catch (e: unknown) {
      console.error("[World] setCycleAlertMinutes failed:", e);
    }
  }

  async function fetchWorldData(force: boolean = false) {
    if ($worldLoading) return;
    const now = Date.now();
    if (!force && $worldData && (now - $worldLastFetch) < WORLD_REFRESH_MS) return;

    worldLoading.set(true);
    try {
      const data = await invoke("getWorldState");
      if (data) {
        worldData.set(data);
        worldLastFetch.set(Date.now());
      }
    } catch (e) {
      console.error('[World] getWorldState failed:', e);
    } finally {
      worldLoading.set(false);
    }
  }

  // ── Open shared ItemDetailModal for any world item ──────────
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

  // Urgency threshold: remaining < 20% of total duration → urgent.
  // Callers pass `clock` (typically nowCoarseMs) so urgency flags don't
  // re-evaluate on every 1 s tick.
  const URGENCY_RATIO = 0.20;
  function isUrgent(expiryIso: string | null | undefined, activationIso: string | null | undefined, fallbackTotalMs?: number, clock?: number): boolean {
    const exp = parseIsoDate(expiryIso ?? null);
    if (!exp) return false;
    const ref = clock ?? nowCoarseMs;
    const remainMs = exp.getTime() - ref;
    if (remainMs <= 0) return false;
    const act = parseIsoDate(activationIso ?? null);
    const totalMs = act ? exp.getTime() - act.getTime() : (fallbackTotalMs ?? 0);
    if (totalMs <= 0) return false;
    return remainMs / totalMs < URGENCY_RATIO;
  }

  // Reactive derived values — recalculated on every tick
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

  $: varziaAct    = parseIsoDate(varzia?.activation);
  $: varziaExpiry = parseIsoDate(varzia?.expiry);
  $: varziaActive = !!(varziaAct && varziaExpiry && nowCoarseMs >= +varziaAct && nowCoarseMs < +varziaExpiry);

  $: baroAct    = parseIsoDate(baro?.activation);
  $: baroExpiry = parseIsoDate(baro?.expiry);
  $: baroActive = !!(baroAct && baroExpiry && nowCoarseMs >= +baroAct && nowCoarseMs < +baroExpiry);

  $: featuredPrimes = wd ? buildFeaturedPrimes(varzia, $inventoryData, $itemDb) : [];

  $: duviriState = (duviri.state || "unknown").toString();
  $: duviriExpiry = parseIsoDate(duviri.expiry);
  $: duviriNormal = (duviri.choices || []).find((c) => c.category === "normal")?.choices || [];
  $: duviriHard = (duviri.choices || []).find((c) => c.category === "hard")?.choices || [];
  $: circuitNormalItems = resolveCircuitChoices(duviriNormal, $itemDb, $inventoryData);
  $: circuitHardItems = resolveCircuitChoices(duviriHard, $itemDb, $inventoryData);

  // Recompute all countdowns from a single clock source.
  // This keeps seconds moving while staying on the World tab.
  $: times = {
    baro: baroActive ? timeTo(baroExpiry, nowMs) : timeTo(baroAct, nowMs),
    varzia: varziaActive ? timeTo(varziaExpiry, nowMs) : timeTo(varziaAct, nowMs),
    daily: timeTo(nextDailyResetUtc(), nowMs),
    weekly: timeTo(nextWeeklyResetUtc(), nowMs),
    sortie: timeTo(parseIsoDate(sortie?.expiry) || nextDailyResetUtc(), nowMs),
    steelPath: timeTo(parseIsoDate(steelPath?.expiry ?? undefined) || nextWeeklyResetUtc(), nowMs),
    duviri: timeTo(duviriExpiry, nowMs),
    earth: cycleTimeDisplay(earth.timeLeft, earth.expiry, nowMs),
    cetus: cycleTimeDisplay(cetus.timeLeft, cetus.expiry, nowMs),
    vallis: cycleTimeDisplay(vallis.timeLeft, vallis.expiry, nowMs),
    cambion: cycleTimeDisplay(cambion.timeLeft, cambion.expiry, nowMs),
  };

  $: fissuresAll = (wd?.fissures || [])
    .filter(
      (f) =>
        !f.expired &&
        ((parseIsoDate(f.expiry)?.getTime() || 0) > (nowCoarseMs + FISSURE_EXPIRY_GUARD_MS)),
    )
    .sort((a, b) => (parseIsoDate(a.expiry)?.getTime() || 0) - (parseIsoDate(b.expiry)?.getTime() || 0));

  $: fissures = fissuresAll.filter(f =>
    $worldFissureMode === 'steel' ? f.isHard === true : f.isHard !== true
  );

  $: fissureFlat = fissures
    .slice()
    .sort((a, b) => {
      const oa = FISSURE_TIER_ORDER[(a.tier || '').toLowerCase()] ?? 99;
      const ob = FISSURE_TIER_ORDER[(b.tier || '').toLowerCase()] ?? 99;
      if (oa !== ob) return oa - ob;
      return (parseIsoDate(a.expiry)?.getTime() || 0) - (parseIsoDate(b.expiry)?.getTime() || 0);
    })
    .map(f => ({
      ...f,
      timeStr: timeToStrict(parseIsoDate(f.expiry), nowMs),
      tierCls: fissureTierClass(f.tier || ''),
    }));

  $: cycleRows = [
    { key: 'earth' as const, src: PLANET_ICON_PATHS.earth, t: earth, time: times.earth, stateLabel: earthLabel, stateClass: earth.isDay ? 'day' : 'night', nextLabel: earth.isDay ? 'Night' : 'Day', urgent: isUrgent(earth.expiry, earth.activation) },
    { key: 'cetus' as const, src: PLANET_ICON_PATHS.cetus, t: cetus, time: times.cetus, stateLabel: cetusLabel, stateClass: cetus.isDay ? 'day' : 'night', nextLabel: cetus.isDay ? 'Night' : 'Day', urgent: isUrgent(cetus.expiry, cetus.activation) },
    { key: 'vallis' as const, src: PLANET_ICON_PATHS.vallis, t: vallis, time: times.vallis, stateLabel: vallisLabel, stateClass: vallis.isWarm ? 'warm' : 'cold', nextLabel: vallis.isWarm ? 'Cold' : 'Warm', urgent: isUrgent(vallis.expiry, vallis.activation) },
    { key: 'cambion' as const, src: PLANET_ICON_PATHS.cambion, t: cambion, time: times.cambion, stateLabel: cambionLabel, stateClass: (cambion.active || '').toString().toLowerCase() || 'fass', nextLabel: (cambion.active || '').toString().toLowerCase() === 'fass' ? 'VOME' : 'FASS', urgent: isUrgent(cambion.expiry, cambion.activation) },
    ...(duviriExpiry ? [{ key: 'duviri' as const, src: PLANET_ICON_PATHS.duviri, t: { expiry: duviri.expiry }, time: times.duviri, stateLabel: duviriState, stateClass: duviriState.toLowerCase(), nextLabel: (duviri.nextState || 'Unknown').toString(), urgent: isUrgent(duviri.expiry, null) }] : []),
  ].filter(row => row.t.expiry);

  // eslint-disable-next-line no-useless-assignment -- Svelte $: reactive
  $: earthLabel   = earth.isDay    ? 'Day'     : 'Night';
  // eslint-disable-next-line no-useless-assignment -- Svelte $: reactive
  $: cetusLabel   = cetus.isDay    ? 'Day'     : 'Night';
  // eslint-disable-next-line no-useless-assignment -- Svelte $: reactive
  $: vallisLabel  = vallis.isWarm  ? 'Warm'    : 'Cold';
  // eslint-disable-next-line no-useless-assignment -- Svelte $: reactive
  $: cambionLabel = (cambion.active || '').toString().toUpperCase() || 'Unknown';

  // Invasions from raw DE world state (or warframestat fallback)
  $: invasions = ((wd?.invasions || []) as Invasion[]).filter(inv => !inv.completed);

  // Current bounty rotation (A/B/C) from oracle bounty-cycle
  $: bountyRotation = (wd?.bountyRotation as string | undefined) || undefined;

  // Steel Path Honors from warframestat.us
  $: steelPathHonors = (wd?.steelPath && typeof (wd.steelPath as unknown as { currentReward?: unknown }).currentReward === 'object')
    ? wd.steelPath as SteelPathHonors
    : null;

  // Bounties from parsed + warframestat + bounty-cycle — sorted to canonical order
  const BOUNTY_ORDER: Record<string, number> = {
    CetusSyndicate: 0, Ostrons: 0,
    SolarisSyndicate: 1, "Solaris United": 1,
    EntratiSyndicate: 2, Entrati: 2,
    ZarimanSyndicate: 3, "The Holdfasts": 3,
    EntratiLabSyndicate: 4, Cavia: 4,
    HexSyndicate: 5, "The Hex": 5,
  };
  $: bounties = ((wd?.bounties || []) as SyndicateBounty[])
    .filter(b => b.jobs.length > 0)
    .sort((a, b) => (BOUNTY_ORDER[a.syndicateKey] ?? (BOUNTY_ORDER[a.syndicate] ?? 99)) - (BOUNTY_ORDER[b.syndicateKey] ?? (BOUNTY_ORDER[b.syndicate] ?? 99)));

  // Reset timer urgency (fixed known durations)
  const MS_24H = 86_400_000;
  const MS_7D = 604_800_000;
  $: resetUrgency = {
    sortie: isUrgent(sortie?.expiry, null, MS_24H, nowCoarseMs),
    daily: (() => { const r = nextDailyResetUtc().getTime() - nowCoarseMs; return r > 0 && r / MS_24H < URGENCY_RATIO; })(),
    weekly: (() => { const r = nextWeeklyResetUtc().getTime() - nowCoarseMs; return r > 0 && r / MS_7D < URGENCY_RATIO; })(),
    steelPath: isUrgent(steelPath?.expiry ?? undefined, null, MS_7D, nowCoarseMs),
  };

  // Bounty expiry timers (keyed by syndicateKey).
  // timeStr needs 1 s precision for the countdown display; urgent only flips
  // at the 20 %-remaining boundary, so nowCoarseMs is fine.
  $: bountyTimers = Object.fromEntries(
    bounties.map(b => {
      const exp = b.expiry ? parseIsoDate(b.expiry) : null;
      const timeStr = exp ? timeTo(exp, nowMs) : '';
      const urgent = isUrgent(b.expiry, null, 9_000_000, nowCoarseMs); // ~2.5h fallback
      return [b.syndicateKey, { timeStr, urgent }];
    })
  );

  // Baro relay location for countdown display
  $: baroLocation = typeof baro?.location === "string" && baro.location ? baro.location : null;

  // Baro ownership set — covers mods, weapons, relics, cosmetics
  $: baroOwnedSet = buildBaroOwnedSet($inventoryData);

  // Helper: invasion reward display text
  function invasionRewardLabel(side: Invasion["attacker"] | Invasion["defender"]): string {
    const r = side.reward;
    if (!r) return "";
    if (r.countedItems?.length > 0) {
      return r.countedItems.map(ci => ci.count > 1 ? `${ci.count}x ${ci.type}` : ci.type).join(", ");
    }
    if (r.items?.length > 0) return r.items.join(", ");
    if (r.credits > 0) return `${r.credits.toLocaleString()} Credits`;
    return "";
  }

  // Faction color class helper
  function factionClass(faction: string): string {
    const f = faction.toLowerCase();
    if (f === "grineer") return "grineer";
    if (f === "corpus") return "corpus";
    if (f === "infested") return "infested";
    return "";
  }

  function titleCase(s: string): string {
    return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }
</script>

<section class="view active">
  <div class="view-header">
    <div class="flex items-center gap-3">
      <h2>World</h2>
      {#if baroActive}
        <span class="rounded-[0.3rem] border border-[rgba(251,191,36,0.3)] bg-[rgba(251,191,36,0.1)] px-2 py-[0.15rem] text-[0.72rem] font-semibold whitespace-nowrap text-warning">Baro leaves in {times.baro}{#if baroLocation} · {baroLocation}{/if}</span>
      {:else if baroAct}
        <span class="rounded-[0.3rem] border border-[rgba(251,191,36,0.3)] bg-[rgba(251,191,36,0.1)] px-2 py-[0.15rem] text-[0.72rem] font-semibold whitespace-nowrap text-warning">Baro arrives in {times.baro}{#if baroLocation} · {baroLocation}{/if}</span>
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
                {@const alertKey = row.key}
                {@const hasCycleAlert = alertKey === 'earth' || alertKey === 'cetus' || alertKey === 'vallis' || alertKey === 'cambion' || alertKey === 'duviri'}
                {@const alertOn = hasCycleAlert && !!$overlaySettings.cycleAlerts?.[alertKey]}
                <div class="flex items-center justify-between py-[0.38rem] border-b border-dashed border-white/[0.06]">
                  <div class="flex items-center gap-[0.35rem] min-w-0">
                    <img class="h-[33px] w-[33px] shrink-0 rounded-full object-cover" src={row.src} alt="" />
                    <span class="text-[0.88rem] font-semibold whitespace-nowrap text-text-primary">{row.key.charAt(0).toUpperCase() + row.key.slice(1)}</span>
                    <span class="world-state-{row.stateClass} rounded-[0.2rem] px-[0.35rem] py-[0.08rem] text-[0.72rem] font-bold whitespace-nowrap">{row.stateLabel}</span>
                  </div>
                  <span class="flex shrink-0 items-center gap-[0.3rem]">
                    <span class="text-[0.78rem] whitespace-nowrap text-text-secondary">{row.nextLabel} in</span>
                    <span class="font-display text-[0.85rem] tracking-[0.02em] whitespace-nowrap text-text-primary" class:world-timer-urgent={row.urgent}>{row.time}</span>
                    {#if hasCycleAlert}
                    <button
                      class="inline-flex shrink-0 items-center justify-center w-5 h-5 rounded border border-border bg-transparent p-0 text-text-muted opacity-35 transition-[opacity,background,color,border-color] duration-150 cursor-pointer hover:opacity-80 hover:bg-white/[0.06] data-[active]:opacity-100 data-[active]:text-warning data-[active]:border-[rgba(251,191,36,0.4)] data-[active]:bg-[rgba(251,191,36,0.1)]"
                      data-active={alertOn || undefined}
                      title={alertOn ? `Disable ${row.key} notification` : `Enable ${row.key} notification`}
                      on:click={() => toggleCycleAlert(alertKey)}
                      aria-pressed={alertOn}
                    >
                      {#if alertOn}
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
                        <path d="M8 1a5 5 0 0 0-5 5v2.586l-.707.707A1 1 0 0 0 3 11h10a1 1 0 0 0 .707-1.707L13 8.586V6a5 5 0 0 0-5-5zM6.5 14a1.5 1.5 0 0 0 3 0H6.5z"/>
                      </svg>
                      {:else}
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                        <path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5v2.586l-.707.707A1 1 0 0 0 3.5 11h9a1 1 0 0 0 .707-1.707L12.5 8.586V6a4.5 4.5 0 0 0-4.5-4.5z"/>
                        <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0"/>
                      </svg>
                      {/if}
                    </button>
                    {/if}
                  </span>
                </div>
              {/each}
            </div>
            <div class="mt-[0.15rem] flex items-center gap-2 pt-[0.35rem] text-[0.78rem] text-text-secondary">
              <span>Notify before cycle change</span>
              <span class="flex items-center gap-1">
                <input
                  type="number"
                  class="cycle-lead-input w-[2.6rem] rounded border border-border bg-[rgba(0,0,0,0.25)] px-[0.3rem] py-[0.15rem] text-center text-[0.78rem] text-text-primary outline-none"
                  min="0"
                  max="120"
                  value={$overlaySettings.cycleAlertMinutesBefore ?? 3}
                  on:change={(e) => setCycleAlertMinutes(Number(e.currentTarget.value))}
                />
                <span>min</span>
              </span>
            </div>
          {:else}
            <span class="text-[0.82rem] text-text-secondary opacity-70">Cycle data unavailable</span>
          {/if}
          </CollapsibleSection>
        </div>

        <!-- RESET TIMERS -->
        <div class="world-section">
          <CollapsibleSection title="Reset Timers" collapsed={collapsed.timers} onToggle={() => toggleSection('timers')}>
          <div class="world-row"><span class="text-[0.88rem] text-text-secondary">Daily sortie</span><span class="font-display text-[0.88rem] tracking-[0.02em] whitespace-nowrap text-text-primary" class:world-timer-urgent={resetUrgency.sortie}>{times.sortie}</span></div>
          <div class="world-row"><span class="text-[0.88rem] text-text-secondary">Daily reset</span><span class="font-display text-[0.88rem] tracking-[0.02em] whitespace-nowrap text-text-primary" class:world-timer-urgent={resetUrgency.daily}>{times.daily}</span></div>
          <div class="world-row"><span class="text-[0.88rem] text-text-secondary">Weekly resets</span><span class="font-display text-[0.88rem] tracking-[0.02em] whitespace-nowrap text-text-primary" class:world-timer-urgent={resetUrgency.weekly}>{times.weekly}</span></div>
          <div class="world-row"><span class="text-[0.88rem] text-text-secondary">Steel Path honours</span><span class="font-display text-[0.88rem] tracking-[0.02em] whitespace-nowrap text-text-primary" class:world-timer-urgent={resetUrgency.steelPath}>{times.steelPath}</span></div>
          </CollapsibleSection>
        </div>

        <!-- PRIME RESURGENCE -->
        <div class="world-section">
          <div class="flex items-center justify-between gap-2 mb-[0.55rem]">
            <button class="world-section-toggle" on:click={() => toggleSection('resurgence')} aria-expanded={!collapsed.resurgence}>
              <span class="world-toggle-icon" class:collapsed={collapsed.resurgence}>&#x25BE;</span>
              <h3>Prime Resurgence</h3>
            </button>
          </div>
          {#if !collapsed.resurgence}
          <div class="text-[0.82rem] text-text-secondary mb-[0.55rem]">
            Rotation ends in <strong>{times.varzia}</strong>
          </div>
          {#if featuredPrimes.length > 0}
            <div class="flex gap-[0.6rem] overflow-x-auto overflow-y-visible px-1 py-[0.3rem]">
              {#each featuredPrimes as p}
                <button class="group flex shrink-0 flex-col items-center gap-[0.2rem] border-0 bg-transparent p-0 text-inherit cursor-pointer transition-transform duration-100 hover:scale-105 hover:z-[1]" on:click={() => openItemDetail(p.uniqueName)} title="View {p.name} details">
                  <div class="h-[100px] w-[100px] overflow-hidden rounded-[0.35rem] border-2 bg-[rgba(0,0,0,0.3)] {p.owned ? 'border-[rgba(74,222,128,0.5)] shadow-[0_0_6px_rgba(74,222,128,0.15)]' : 'border-border'}">
                    <img class="h-full w-full object-contain" src={p.imageUrl} alt={p.name} loading="lazy" />
                  </div>
                  <span class="max-w-[100px] overflow-hidden text-ellipsis whitespace-nowrap text-center text-[0.68rem] text-text-secondary">{p.name}</span>
                </button>
              {/each}
            </div>
          {:else}
            <span class="text-[0.82rem] text-text-secondary opacity-70">No featured prime items found</span>
          {/if}
          {/if}
        </div>

        <!-- THE CIRCUIT -->
        <div class="world-section">
          <CollapsibleSection title="The Circuit" collapsed={collapsed.circuit} onToggle={() => toggleSection('circuit')}>
          {#each [{ label: 'Normal rotation', items: circuitNormalItems, isSteelPath: false }, { label: 'Steel Path rotation', items: circuitHardItems, isSteelPath: true }] as rot}
          <div class="mb-[0.3rem] text-[0.7rem] font-bold uppercase tracking-[0.06em] {rot.isSteelPath ? 'text-warning' : 'text-text-secondary'}">{rot.label}</div>
          <div class="mb-2 flex gap-2 overflow-x-auto overflow-y-visible px-[0.15rem] py-[0.3rem]">
            {#each rot.items as item}
              <button class="group flex shrink-0 flex-col items-center gap-[0.15rem] border-0 bg-transparent p-0 text-inherit cursor-pointer transition-transform duration-100 hover:scale-[1.08] hover:z-[1]" on:click={() => openItemDetail(item.uniqueName)} title="View {item.name} details">
                <div class="flex h-20 w-20 items-center justify-center overflow-hidden rounded-[0.3rem] border-[1.5px] bg-[rgba(0,0,0,0.3)] {item.owned ? 'border-[rgba(74,222,128,0.5)] shadow-[0_0_5px_rgba(74,222,128,0.15)]' : 'border-border'}">
                  {#if item.imageUrl}
                    <img class="h-full w-full object-contain" src={item.imageUrl} alt={item.name} loading="lazy" />
                  {/if}
                </div>
                <span class="max-w-20 overflow-hidden text-ellipsis whitespace-nowrap text-center text-[0.65rem] text-text-secondary">{item.name}</span>
              </button>
            {:else}
              <span class="text-[0.82rem] text-text-secondary opacity-70">No data</span>
            {/each}
          </div>
          {/each}
          </CollapsibleSection>
        </div>

        <!-- STEEL PATH HONORS -->
        {#if steelPathHonors}
        <div class="world-section">
          <div class="flex items-center justify-between gap-2 mb-[0.55rem]">
            <button class="world-section-toggle" on:click={() => toggleSection('steelpath')} aria-expanded={!collapsed.steelpath}>
              <span class="world-toggle-icon" class:collapsed={collapsed.steelpath}>&#x25BE;</span>
              <h3>Steel Path Honors</h3>
            </button>
            <span class="font-display text-[0.88rem] tracking-[0.02em] whitespace-nowrap text-text-primary">{times.steelPath}</span>
          </div>
          {#if !collapsed.steelpath}
          <div class="flex items-center gap-2 py-[0.35rem]">
            <span class="text-[0.72rem] font-bold text-text-secondary uppercase tracking-[0.06em] shrink-0">This week</span>
            <span class="text-[0.88rem] font-semibold text-warning flex-1 min-w-0">{steelPathHonors.currentReward.name}</span>
            <span class="text-[0.72rem] text-text-secondary whitespace-nowrap shrink-0">{steelPathHonors.currentReward.cost} Steel Essence</span>
          </div>
          {/if}
        </div>
        {/if}
      </div>

      <!-- RIGHT COLUMN -->
      <div class="flex flex-col">

        <!-- VOID FISSURES -->
        <div class="world-section border-t-0">
          <div class="flex items-center justify-between gap-2 mb-[0.55rem]">
            <button class="world-section-toggle" on:click={() => toggleSection('fissures')} aria-expanded={!collapsed.fissures}>
              <span class="world-toggle-icon" class:collapsed={collapsed.fissures}>&#x25BE;</span>
              <h3>Void Fissures</h3>
            </button>
            <div class="flex">
              <button
                class="fissure-tab rounded-l-[0.3rem] data-[active]:bg-accent data-[active]:text-bg-deep data-[active]:border-accent"
                data-active={$worldFissureMode === 'normal' || undefined}
                on:click={() => worldFissureMode.set('normal')}
              >Normal</button>
              <button
                class="fissure-tab rounded-r-[0.3rem] border-l-0 data-[active]:bg-accent data-[active]:text-bg-deep data-[active]:border-accent"
                data-active={$worldFissureMode === 'steel' || undefined}
                on:click={() => worldFissureMode.set('steel')}
              >Steel Path</button>
            </div>
          </div>
          {#if !collapsed.fissures}
          <div class="flex flex-col">
            {#if fissureFlat.length === 0}
              <span class="text-[0.82rem] text-text-secondary opacity-70">No active {$worldFissureMode === 'steel' ? 'Steel Path' : 'Normal'} fissures</span>
            {:else}
              {#each fissureFlat as f}
                <div class="fissure-row">
                  <span class="world-badge-{f.tierCls} inline-flex min-w-20 items-center gap-[0.2rem] rounded px-[0.45rem] py-[0.18rem] text-[0.66rem] font-bold uppercase tracking-[0.06em]">
                    <img class="h-3.5 w-3.5 shrink-0" src={RELIC_ICON_PATHS[f.tierCls] || RELIC_ICON_PATHS.default} alt="" />
                    {f.tier}
                  </span>
                  <span class="min-w-0 flex-1 text-[0.84rem]">
                    <strong class="text-text-primary">{f.missionType || 'Mission'}</strong>
                    <span class="ml-[0.35rem] text-[0.78rem] text-text-secondary opacity-75">{f.node || 'Unknown'}</span>
                  </span>
                  <span class="shrink-0 font-display text-[0.84rem] tracking-[0.02em] whitespace-nowrap text-text-primary">{f.timeStr}</span>
                </div>
              {/each}
            {/if}
          </div>
          {/if}
        </div>

        <!-- FISSURE ALERTS -->
        <div class="py-0">
          <FissureAlerts />
        </div>

        <!-- INVASIONS -->
        {#if invasions.length > 0}
        <div class="world-section">
          <CollapsibleSection title="Invasions" collapsed={collapsed.invasions} onToggle={() => toggleSection('invasions')}>
          <div class="flex flex-col">
            {#each invasions as inv}
              <div class="flex flex-col gap-[0.2rem] border-b border-dashed border-white/[0.06] py-[0.35rem] last:border-b-0">
                <div class="flex items-center gap-[0.35rem]">
                  <span class="text-[1.06rem] font-semibold text-text-primary">{inv.node}</span>
                </div>
                <div class="flex items-center gap-[0.35rem] text-[0.98rem]">
                  <span class="shrink-0 text-[0.82rem] font-bold uppercase tracking-[0.05em] opacity-90 world-faction-{factionClass(inv.attacker.faction)}">{inv.attacker.faction}</span>
                  <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right text-accent">{invasionRewardLabel(inv.attacker)}</span>
                  <span class="text-[0.94rem] font-bold text-text-muted uppercase opacity-45 shrink-0">VS</span>
                  <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-accent">{invasionRewardLabel(inv.defender)}</span>
                  <span class="shrink-0 text-[0.82rem] font-bold uppercase tracking-[0.05em] opacity-90 world-faction-{factionClass(inv.defender.faction)}">{inv.defender.faction}</span>
                </div>
                <div class="flex h-[3px] overflow-hidden rounded-sm">
                  <div class="h-full world-faction-bg-{factionClass(inv.attacker.faction)} transition-[width] duration-300" style="width: {Math.max(0, Math.min(100, inv.completion))}%"></div>
                  <div class="h-full world-faction-bg-{factionClass(inv.defender.faction)} transition-[width] duration-300" style="width: {Math.max(0, Math.min(100, 100 - inv.completion))}%"></div>
                </div>
                <span class="flex items-center gap-[0.3rem] font-display text-[0.86rem] text-text-secondary">
                  <span class="world-faction-{factionClass(inv.attacker.faction)}">{inv.completion.toFixed(1)}%</span>
                  <span class="opacity-40">–</span>
                  <span class="world-faction-{factionClass(inv.defender.faction)}">{(100 - inv.completion).toFixed(1)}%</span>
                </span>
              </div>
            {/each}
          </div>
          </CollapsibleSection>
        </div>
        {/if}

        <!-- BARO KI'TEER (inactive — under invasions) -->
        {#if !baroActive && baroAct}
        <div class="world-section">
          <div class="flex items-center gap-[0.55rem] py-[0.35rem]">
            <span class="text-[0.88rem] font-semibold text-text-primary">Baro Ki'Teer</span>
            <span class="text-[0.62rem] font-bold py-[0.1rem] px-[0.4rem] rounded-[0.2rem] uppercase tracking-[0.06em] bg-white/[0.06] text-text-secondary opacity-70">Inactive</span>
            <span class="text-[0.82rem] font-display text-text-secondary ml-auto">{times.baro}{#if baroLocation} · {baroLocation}{/if}</span>
          </div>
        </div>
        {/if}

      </div>
    </div>

    <!-- BARO KI'TEER (active — full-width with icon grid) -->
    {#if baroActive && baro?.inventory && baro.inventory.length > 0}
    <div class="world-section mt-2">
      <CollapsibleSection title="Baro Ki'Teer" collapsed={collapsed.baro} onToggle={() => toggleSection('baro')}>
      <div class="flex items-center justify-between py-[0.35rem] text-[0.82rem] text-text-secondary">
        <span>{baroLocation}</span>
        <span class="text-text-secondary text-[0.78rem]">Leaves in <strong>{times.baro}</strong></span>
      </div>
      <div class="flex flex-wrap gap-[0.6rem] px-1 py-[0.3rem]">
        {#each baro.inventory as inv}
          {@const dbEntry = $itemDb[inv.uniqueName || '']}
          {@const hasDb = !!dbEntry}
          {@const isMod = dbEntry?.category === 'Mod'}
          {@const wfmEntry = isMod ? getLookupByName(inv.item || '', $wfmItems) : null}
          {@const wfmIcon = wfmEntry?.icon || wfmEntry?.thumb || null}
          {@const imgUrl = (isMod ? wfmIcon : null) || dbEntry?.imageUrl || (typeof inv.imageOverride === 'string' ? inv.imageOverride : null)}
          {@const owned = baroOwnedSet.has(inv.uniqueName || '')}
          <button
            class="flex shrink-0 flex-col items-center gap-[0.2rem] border-0 bg-transparent p-0 text-inherit transition-transform duration-100 disabled:cursor-default disabled:opacity-85 {hasDb ? 'cursor-pointer hover:scale-105 hover:z-[1]' : ''}"
            disabled={!hasDb}
            on:click={() => hasDb && openItemDetail(inv.uniqueName || '')}
            title="{inv.item || 'Unknown'}{inv.ducats ? ` — ${inv.ducats} duc` : ''}{inv.credits ? ` / ${inv.credits.toLocaleString()} cr` : ''}"
          >
            <div class="relative flex items-center justify-center overflow-hidden rounded-[0.35rem] border-2 bg-[rgba(0,0,0,0.3)] {isMod ? 'h-[140px] w-[100px] border-0 bg-transparent rounded-[0.3rem]' : 'h-[120px] w-[120px]'} {owned ? 'border-[rgba(34,139,34,0.7)]' : 'border-border'} {isMod && owned ? 'shadow-[0_0_8px_2px_rgba(34,139,34,0.5)]' : ''}">
              {#if imgUrl}
                <img class="h-full w-full object-contain" src={imgUrl} alt={inv.item || ''} loading="lazy" />
              {:else}
                <span class="text-[1.8rem] font-bold text-text-secondary opacity-40">{(inv.item || '?')[0]}</span>
              {/if}
              {#if inv.ducats}
                <span class="absolute top-[3px] left-[3px] rounded bg-[rgba(0,0,0,0.78)] px-[6px] py-[2px] text-[1.1rem] font-bold leading-[1.2] text-accent pointer-events-none">{inv.ducats}</span>
              {/if}
              {#if owned}
                <span class="absolute bottom-[3px] right-[3px] flex h-6 w-6 items-center justify-center rounded-full bg-[rgba(34,139,34,0.85)] text-[1rem] font-bold leading-none text-white pointer-events-none">✓</span>
              {/if}
            </div>
            <span class="overflow-hidden text-ellipsis whitespace-nowrap text-center text-[0.65rem] text-text-secondary {isMod ? 'max-w-[100px]' : 'max-w-[120px]'}">{inv.item || 'Unknown'}</span>
          </button>
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
            <button class="flex w-full items-center gap-[0.3rem] border-0 bg-transparent py-[0.2rem] text-left text-inherit cursor-pointer" on:click={() => toggleSection(`bounty-${group.syndicateKey}`)} aria-expanded={!collapsed[`bounty-${group.syndicateKey}`]}>
              <span class="world-toggle-icon" class:collapsed={collapsed[`bounty-${group.syndicateKey}`]}>&#x25BE;</span>
              <span class="text-[1.15rem] font-semibold text-text-primary">{group.syndicate}</span>
              {#if bountyTimers[group.syndicateKey]?.timeStr}
                <span class="font-display text-[0.88rem] tracking-[0.02em] whitespace-nowrap text-text-primary" class:world-timer-urgent={bountyTimers[group.syndicateKey]?.urgent}>{bountyTimers[group.syndicateKey].timeStr}</span>
              {/if}
              <span class="ml-auto text-[0.75rem] text-text-secondary">{group.jobs.length} bounties</span>
            </button>
            {#if !collapsed[`bounty-${group.syndicateKey}`]}
            <div class="flex flex-col pl-4">
              {#each group.jobs as job, ji}
                <button class="flex w-full items-center gap-2 border-0 bg-transparent px-0 py-[0.22rem] text-left text-[0.88rem] text-inherit cursor-pointer hover:bg-white/[0.03]" on:click={() => toggleSection(`bounty-${group.syndicateKey}-${ji}`)}>
                  <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-text-primary">
                    {titleCase(job.type)}
                    {#if job.challengeDesc}
                      <span class="text-text-secondary text-[0.92em]"> — {job.challengeDesc}</span>
                    {/if}
                  </span>
                  <span class="shrink-0 font-display whitespace-nowrap text-accent text-[1rem]">{job.enemyLevels[0]}–{job.enemyLevels[1]}</span>
                  <span class="world-toggle-icon h-4 w-4 shrink-0 text-[0.75rem]" class:collapsed={!collapsed[`bounty-${group.syndicateKey}-${ji}`]}>&#x25BE;</span>
                </button>
                {#if collapsed[`bounty-${group.syndicateKey}-${ji}`]}
                <div class="mb-[0.2rem] ml-[0.3rem] border-l-2 border-accent py-[0.2rem] pl-[1.2rem]">
                  {#await getBountyRewards(group.syndicateKey, job.enemyLevels, job.standingStages.length, bountyRotation)}
                    <span class="text-[0.7rem] text-text-secondary py-[0.2rem]">Loading rewards…</span>
                  {:then rewards}
                    {#if rewards.length > 0}
                    <div class="mt-[0.35rem]">
                      {#each rewards as sr}
                        <div class="mb-[0.3rem]">
                          <span class="text-[1.05rem] font-semibold text-text-secondary block mb-[0.1rem]">{sr.label}</span>
                          <div class="flex flex-col gap-[0.1rem]">
                            {#each sr.items as item}
                              {@const rewardUniqueName = resolveRewardUniqueName(item.itemName, $itemDb)}
                              {@const rewardIcon = resolveRewardIcon(item.itemName, $itemDb)}
                              <button
                                type="button"
                                class="flex w-full items-center justify-between gap-[0.3rem] border-0 bg-transparent px-0 py-[0.05rem] text-left text-[0.82rem] appearance-none disabled:text-text-primary disabled:opacity-100 disabled:cursor-default {rewardUniqueName ? 'cursor-pointer rounded-[0.2rem] px-[0.2rem] -mx-[0.2rem] transition-[background] duration-150 hover:bg-white/[0.06]' : ''} {item.rarity === 'Rare' || item.rarity === 'Legendary' ? 'text-accent' : 'text-text-primary'}"
                                disabled={!rewardUniqueName}
                                on:click={() => rewardUniqueName && openItemDetail(rewardUniqueName, [{location: `${group.syndicate} Bounty (${job.enemyLevels[0]}\u2013${job.enemyLevels[1]}) \u2014 ${sr.label}`, rarity: item.rarity, chance: item.chance / 100}])}
                              >
                                {#if rewardIcon}
                                  <img class="h-[1.1rem] w-[1.1rem] shrink-0 object-contain" src={rewardIcon} alt="" />
                                {/if}
                                <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{item.itemName}</span>
                                <span class="ml-2 shrink-0 whitespace-nowrap text-[0.78rem] font-semibold">{item.chance.toFixed(2)}%</span>
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
  /* Sections — border-top with :first-child exception */
  .world-section { padding: 0.85rem 0; border-top: 1px solid var(--border); }
  .world-section:first-child { border-top: none; }

  /* Shared row with dashed bottom border + :last-child exception */
  .world-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.32rem 0; border-bottom: 1px dashed rgba(255, 255, 255, 0.06);
  }
  .world-row:last-child { border-bottom: none; }

  /* Section h3 — :global() for CollapsibleSection child */
  .world-section :global(h3) {
    margin: 0 0 0.55rem; font-family: var(--font-display); font-size: 0.82rem;
    font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--accent, #d4a843);
  }

  /* Toggle button — :global() for CollapsibleSection */
  :global(.world-section-toggle) {
    display: inline-flex; align-items: center; gap: 0.3rem;
    background: none; border: none; padding: 0; cursor: pointer; color: inherit; font: inherit;
  }
  :global(.world-section-toggle h3) { margin: 0; }
  :global(.world-toggle-icon) {
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 1.1rem; width: 1.4rem; height: 1.4rem;
    transition: transform 0.15s ease; color: var(--text-secondary); flex-shrink: 0;
  }
  :global(.world-toggle-icon.collapsed) { transform: rotate(-90deg); }

  /* Cycle state colors — :global() dynamic class */
  :global(.world-state-day)    { color: #fbbf24; background: rgba(251, 191, 36, 0.1); }
  :global(.world-state-night)  { color: #60a5fa; background: rgba(96, 165, 250, 0.1); }
  :global(.world-state-warm)   { color: #f97316; background: rgba(249, 115, 22, 0.1); }
  :global(.world-state-cold)   { color: #38bdf8; background: rgba(56, 189, 248, 0.1); }
  :global(.world-state-fass)   { color: #f97316; background: rgba(249, 115, 22, 0.1); }
  :global(.world-state-vome)   { color: #a78bfa; background: rgba(167, 139, 250, 0.1); }
  :global(.world-state-anger)  { color: #ef4444; background: rgba(239, 68, 68, 0.1); }
  :global(.world-state-joy)    { color: #fbbf24; background: rgba(251, 191, 36, 0.1); }
  :global(.world-state-envy)   { color: #22c55e; background: rgba(34, 197, 94, 0.1); }
  :global(.world-state-sorrow) { color: #60a5fa; background: rgba(96, 165, 250, 0.1); }
  :global(.world-state-fear)   { color: #a78bfa; background: rgba(167, 139, 250, 0.1); }

  /* Fissure badge colors — :global() dynamic class */
  :global(.world-badge-lith)    { background: rgba(74, 222, 128, 0.12); color: #4ade80; }
  :global(.world-badge-meso)    { background: rgba(120, 120, 130, 0.18); color: #9a9aa0; }
  :global(.world-badge-neo)     { background: rgba(190, 195, 210, 0.12); color: #c0c5d0; }
  :global(.world-badge-axi)     { background: rgba(251, 191, 36, 0.12); color: #fbbf24; }
  :global(.world-badge-requiem) { background: rgba(239, 68, 68, 0.14); color: #ef4444; }
  :global(.world-badge-omnia)   { background: rgba(45, 212, 191, 0.12); color: #2dd4bf; }

  /* Faction colors — :global() dynamic class */
  :global(.world-faction-grineer)    { color: #ef5350; }
  :global(.world-faction-corpus)     { color: #42a5f5; }
  :global(.world-faction-infested)   { color: #66bb6a; }
  :global(.world-faction-bg-grineer) { background: #ef5350; }
  :global(.world-faction-bg-corpus)  { background: #42a5f5; }
  :global(.world-faction-bg-infested){ background: #66bb6a; }

  /* Urgent timer — :global() used by class: directive */
  :global(.world-timer-urgent) { color: #ef4444 !important; }

  /* Fissure row — gap-based layout instead of space-between */
  .fissure-row {
    display: flex; align-items: center; gap: 0.55rem;
    padding: 0.35rem 0; border-bottom: 1px dashed rgba(255, 255, 255, 0.06);
  }
  .fissure-row:last-child { border-bottom: none; }

  /* Fissure tab base — :first-child/:last-child for radius */
  .fissure-tab {
    padding: 0.25rem 0.65rem; font-size: 0.68rem; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase; background: none;
    border: 1px solid var(--border); color: var(--text-secondary);
    cursor: pointer; transition: all 0.15s;
  }
  .fissure-tab[data-active] {
    background: var(--accent); color: var(--bg-deep); border-color: var(--accent);
  }

  /* Spin button removal — vendor prefix */
  .cycle-lead-input { appearance: textfield; -moz-appearance: textfield; }
  .cycle-lead-input::-webkit-inner-spin-button,
  .cycle-lead-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
</style>
